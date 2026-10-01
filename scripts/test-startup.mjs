import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { prepareGitUpdateFixture, verifyOriginalFailure, verifyFixedUpdates } from './git-update-fixture.mjs';

// 使用完整 DSH 启动流程，验证自动 Typert 注册不会撤销内置设置接口。
// 临时 DSH_HOME 不包含真实配置或会话；仅启动本地后端，不打开窗口。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.env.DSH_CLI_ENTRY;
if (!entry) throw Error('请设置 DSH_CLI_ENTRY 为 DSH 的 CLI JavaScript 入口；Electron 运行时还需设置 DSH_EXECUTABLE。');
const executable = process.env.DSH_EXECUTABLE || process.execPath;
const home = await fs.mkdtemp(join(tmpdir(), 'dsh-pnpm-startup-'));
const profile = join(home, 'profiles', 'startup-test');
const pkg = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'));
const testInstall = process.argv.includes('--install');
await fs.mkdir(join(profile, 'node_modules'), { recursive: true });
await fs.writeFile(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-startup-test', private: true, dependencies: { [pkg.name]: testInstall ? `file:${root.replaceAll('\\', '/')}` : pkg.version },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...testInstall ? [] : [pkg.name]] } },
}));
await fs.writeFile(join(profile, 'cordis.yml'), '[]\n');
await fs.writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
if (!testInstall) await fs.symlink(root, join(profile, 'node_modules', pkg.name), process.platform === 'win32' ? 'junction' : 'dir');
const fixture = testInstall ? await prepareGitUpdateFixture({ home, profile, executable }) : null;

const child = spawn(executable, ['--expose-internals', entry, 'startup-test', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
  env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
let timer;
const exited = once(child, 'exit');
try {
  const address = await new Promise((accept, reject) => {
    const inspect = chunk => {
      logs += chunk.toString();
      const match = logs.match(/dsh web:\s+(http:\/\/\S+)\r?\n/);
      if (match) accept(match[1]);
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', reject);
    child.once('exit', code => reject(Error(`DSH 在就绪前退出：${code}`)));
    timer = setTimeout(() => reject(Error('DSH 在 30 秒内未就绪。')), 30_000);
  });
  clearTimeout(timer);
  const login = await fetch(address, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  assert.ok(login.ok || [301, 302, 303, 307, 308].includes(login.status), '本地 DSH 认证入口应可用');
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const invoke = async (namespace, method, args = {}) => {
    const rpcId = randomUUID();
    const response = await fetch(new URL(`/api/${namespace}/${method}`, address), {
      method: 'POST', signal: AbortSignal.timeout(method === 'installBundle' ? 90_000 : 10_000), headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: `${namespace}/${method}`, payload: { args } }),
    });
    assert.equal(response.status, 200);
    const envelope = await response.json();
    assert.equal(envelope.type, 'server-response');
    assert.equal(envelope.rpcId, rpcId);
    assert.equal(envelope.result?.ok, true, `${namespace}/${method}: ${JSON.stringify(envelope.result?.error)}`);
    return envelope.result.value;
  };
  const settings = await invoke('settings', 'describe');
  assert.ok(Array.isArray(settings.namespaces) && settings.namespaces.length > 0);
  assert.ok(Array.isArray(await invoke('llm', 'listConfigurableProviders')));
  if (fixture) {
    await verifyOriginalFailure(invoke, fixture, profile);
    const enabled = await invoke('pluginManager', 'setBundleEnabled', { name: pkg.name, enabled: true });
    assert.equal(enabled.error, undefined, JSON.stringify(enabled));
    await verifyFixedUpdates(invoke, fixture, profile);
  }
  const request = async payload => JSON.parse(await invoke('pnpmBuildControl', 'request', { payload: JSON.stringify(payload) }));
  assert.equal((await request({ action: 'status' })).mode, 'approval');
  assert.equal((await request({ action: 'set', mode: 'allow-all', acknowledgeRisk: true })).mode, 'allow-all');
  assert.equal((await request({ action: 'set', mode: 'approval' })).mode, 'approval');
  assert.ok((await invoke('settings', 'describe')).namespaces.length > 0);
  if (fixture) {
    const disabled = await invoke('pluginManager', 'setBundleEnabled', { name: pkg.name, enabled: false });
    assert.equal(disabled.error, undefined, JSON.stringify(disabled));
    const original = await invoke('pluginManager', 'installBundle', { spec: fixture.spec, options: { enabled: false } });
    assert.equal(original.error?.code, 'ambiguous-install', '停用插件后应恢复原生安装方法');
    assert.ok((await invoke('settings', 'describe')).namespaces.length > 0);
    console.log('PASS: plugin disable restores the native install method; settings RPC remains available');
  }
  assert.doesNotMatch(logs, /already registered|contributor\(s\) failed|entry did not activate/);
  console.log(JSON.stringify({ result: 'PASS', pluginVersion: pkg.version, checks: ['full DSH startup', 'settings/describe', 'llm/listConfigurableProviders', 'plugin status/off/on', 'settings remains available'], home }));
} catch (error) {
  console.error(logs.replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g, '$1?[redacted]'));
  throw error;
} finally {
  clearTimeout(timer);
  if (child.exitCode === null) child.kill();
  await exited;
}
