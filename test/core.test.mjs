import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { BuildControl } from '../src/core.js';

const work = join(tmpdir(), 'dsh-pnpm-control-tests');
await fs.mkdir(work, { recursive: true });
async function fixture() {
  const home = await fs.mkdtemp(join(work, 'case-'));
  const manager = new BuildControl({ home });
  return { home, manager };
}
async function profile(home, name, yaml = 'packages:\n  - .\n') {
  const dir = join(home, 'profiles', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}`, private: true, dsh: { profile: { bundles: [] } } }));
  if (yaml !== null) await fs.writeFile(join(dir, 'pnpm-workspace.yaml'), yaml);
  return join(dir, 'pnpm-workspace.yaml');
}
const read = async path => parse(await fs.readFile(path, 'utf8'));

test('统一切换所有配置，保留各自允许列表、注释和其他选项', async () => {
  const { home, manager } = await fixture();
  const desktop = await profile(home, 'desktop', '# 用户设置\npackages:\n  - .\nnodeLinker: hoisted\nallowBuilds:\n  allowed: true\n  blocked: false\nminimumReleaseAge: 60\n');
  const web = await profile(home, 'web', 'packages:\n  - .\nautoInstallPeers: false\n');
  const off = await manager.setMode('allow-all', { acknowledgeRisk: true });
  assert.equal(off.mode, 'allow-all');
  assert.deepEqual(off.profiles.map(p => p.name), ['desktop','web']);
  assert.equal((await read(desktop)).dangerouslyAllowAllBuilds, true);
  assert.equal((await read(web)).dangerouslyAllowAllBuilds, true);
  assert.deepEqual((await read(desktop)).allowBuilds, { allowed: true, blocked: false });
  assert.match(await fs.readFile(desktop, 'utf8'), /# 用户设置/);
  const backup = await fs.readFile(join(off.lastBackup, 'desktop.pnpm-workspace.yaml'), 'utf8');
  assert.ok(!backup.includes('dangerouslyAllowAllBuilds'));
  const on = await manager.setMode('approval');
  assert.equal(on.mode, 'approval');
  assert.equal((await read(desktop)).dangerouslyAllowAllBuilds, false);
  assert.deepEqual((await read(desktop)).allowBuilds, { allowed: true, blocked: false });
  assert.equal((await read(desktop)).minimumReleaseAge, 60);
  await manager.dispose();
});

test('重复应用不改写文件，不新增备份；新配置跟随已保存的统一策略', async () => {
  const { home, manager } = await fixture();
  const desktop = await profile(home, 'desktop');
  const first = await manager.setMode('allow-all', { acknowledgeRisk: true });
  const stat = await fs.stat(desktop);
  await manager.reconcile();
  assert.equal((await manager.status()).lastBackup, first.lastBackup);
  assert.equal((await fs.stat(desktop)).mtimeMs, stat.mtimeMs);
  const tui = await profile(home, 'tui', null);
  await manager.reconcile();
  assert.equal((await read(tui)).dangerouslyAllowAllBuilds, true);
  await manager.dispose();
});

test('错误 YAML 阻止整次切换，任何配置均不被部分改写', async () => {
  const { home, manager } = await fixture();
  const desktop = await profile(home, 'desktop');
  const before = await fs.readFile(desktop);
  await profile(home, 'web', 'allowBuilds: [broken');
  await assert.rejects(manager.setMode('allow-all', { acknowledgeRisk: true }), /YAML 无法解析/);
  assert.deepEqual(await fs.readFile(desktop), before);
  assert.equal((await manager.status()).desiredMode, null);
  await manager.dispose();
});

test('保留 UTF-8 BOM 和 CRLF，拒绝损坏的 UTF-8', async () => {
  const { home, manager } = await fixture();
  const file = await profile(home, 'desktop', '\uFEFF# 原设置\r\npackages:\r\n  - .\r\n');
  await manager.setMode('allow-all', { acknowledgeRisk: true });
  const text = await fs.readFile(file, 'utf8');
  assert.ok(text.startsWith('\uFEFF'));
  assert.ok(text.includes('\r\n'));
  assert.ok(!text.replaceAll('\r\n','').includes('\n'));
  await fs.writeFile(file, Buffer.from([255,254,1]));
  await assert.rejects(manager.setMode('approval'), /UTF-8/);
  await manager.dispose();
});

test('两个管理实例同时写入时串行完成，状态与所有文件保持一致', async () => {
  const { home, manager } = await fixture();
  await profile(home, 'desktop'); await profile(home, 'web');
  const second = new BuildControl({ home });
  await Promise.all([manager.setMode('allow-all', { acknowledgeRisk: true }), second.setMode('approval')]);
  const status = await manager.status();
  assert.equal(status.mode, status.desiredMode);
  assert.ok(status.profiles.every(p => p.mode === status.desiredMode));
  await manager.dispose(); await second.dispose();
});

test('只识别 DSH 配置，忽略 node_modules 和普通项目；拒绝无效操作', async () => {
  const { home, manager } = await fixture();
  await profile(home, 'desktop');
  await profile(home, 'node_modules');
  const other = join(home,'profiles','ordinary'); await fs.mkdir(other);
  await fs.writeFile(join(other,'package.json'), '{"name":"ordinary"}');
  assert.deepEqual((await manager.status()).profiles.map(p=>p.name), ['desktop']);
  await assert.rejects(manager.setMode('anything'), /无效模式/);
  await manager.dispose();
});

test('损坏的状态文件不能悄悄重置策略；没有配置时不修改 pnpm', async () => {
  const { home, manager } = await fixture();
  await assert.rejects(manager.setMode('allow-all', { acknowledgeRisk: true }), /没有找到/);
  const file = await profile(home, 'desktop');
  const before = await fs.readFile(file);
  await fs.writeFile(manager.statePath, '{"schemaVersion":99,"mode":"allow-all"}');
  await assert.rejects(manager.setMode('allow-all', { acknowledgeRisk: true }), /状态文件无效/);
  assert.deepEqual(await fs.readFile(file), before);
  await manager.dispose();
});

test('运行中的文件监测会接管新建配置，关闭插件后停止监测', async () => {
  const { home, manager } = await fixture();
  await profile(home, 'desktop');
  await manager.setMode('allow-all', { acknowledgeRisk: true });
  await manager.start();
  const tui = await profile(home, 'tui');
  let applied = false;
  for (let i = 0; i < 40; i++) {
    if ((await read(tui)).dangerouslyAllowAllBuilds === true) { applied = true; break; }
    await new Promise(resolve => setTimeout(resolve,100));
  }
  assert.ok(applied, '新配置应在文件变化后应用策略');
  await manager.dispose();
  assert.equal(manager.watchers.size, 0);
});

test('首次关闭需要确认，确认跨实例持久保存且不会因重新开启或目录同步丢失', async () => {
  const { home, manager } = await fixture();
  const desktop = await profile(home, 'desktop');
  const original = await fs.readFile(desktop);
  await assert.rejects(manager.setMode('allow-all'), /首次关闭审批前需要确认风险/);
  await assert.rejects(manager.setMode('allow-all', { acknowledgeRisk: 'true' }), /首次关闭审批前需要确认风险/);
  assert.deepEqual(await fs.readFile(desktop), original);
  assert.equal((await manager.status()).riskAcknowledged, false);
  assert.equal((await manager.status()).desiredMode, null);
  await assert.rejects(fs.access(manager.statePath), { code: 'ENOENT' });
  const accepted = await manager.setMode('allow-all', { acknowledgeRisk: true });
  assert.equal(accepted.riskAcknowledged, true);
  const receipt = (await manager.state()).riskAcknowledgement;
  assert.equal(receipt.version, 1);
  assert.ok(Number.isFinite(Date.parse(receipt.acknowledgedAt)));
  await manager.setMode('approval');
  await manager.dispose();
  const reopened = new BuildControl({ home });
  assert.equal((await reopened.setMode('allow-all')).mode, 'allow-all');
  const tui = await profile(home, 'tui');
  await reopened.reconcile();
  assert.equal((await read(tui)).dangerouslyAllowAllBuilds, true);
  assert.deepEqual((await reopened.state()).riskAcknowledgement, receipt);
  await reopened.dispose();
});

test('旧版已关闭的设置继续生效，但不自动记为已确认风险', async () => {
  const { home, manager } = await fixture();
  const file = await profile(home, 'desktop', 'dangerouslyAllowAllBuilds: true\n');
  await fs.mkdir(manager.dataRoot, { recursive: true });
  await fs.writeFile(manager.statePath, JSON.stringify({ schemaVersion: 1, mode: 'allow-all', lastBackup: null }));
  await manager.reconcile();
  assert.equal((await manager.status()).riskAcknowledged, false);
  await assert.rejects(manager.setMode('allow-all'), /需要确认风险/);
  const stat = await fs.stat(file);
  const accepted = await manager.setMode('allow-all', { acknowledgeRisk: true });
  assert.equal(accepted.riskAcknowledged, true);
  assert.equal(accepted.lastBackup, null);
  assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
  await manager.dispose();
});

test('CLI 首次 off 显示风险并保持原设置，--accept-risk 才应用，后续不重复要求', async () => {
  const { home, manager } = await fixture();
  const file = await profile(home, 'desktop');
  const run = (...args) => spawnSync(process.execPath, [resolve('src/cli.js'), ...args, '--home', home], { encoding: 'utf8', windowsHide: true });
  const denied = run('off');
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /读写文件/);
  assert.match(denied.stderr, /--accept-risk/);
  assert.equal((await read(file)).dangerouslyAllowAllBuilds, undefined);
  const accepted = run('off', '--accept-risk');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).riskAcknowledged, true);
  assert.equal(run('on').status, 0);
  assert.equal(run('off').status, 0);
  await manager.dispose();
});
