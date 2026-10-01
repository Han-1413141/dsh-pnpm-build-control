import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// Real local Git commits and the bundled pnpm: no published test packages,
// user profiles, build scripts or network Git remotes are involved.
export async function prepareGitUpdateFixture({ home, profile, executable }) {
  const pnpm = process.env.DSH_PNPM_ENTRY;
  if (!pnpm) throw Error('Git 安装测试还需设置 DSH_PNPM_ENTRY 为内置 pnpm 的 JavaScript 入口。');
  const repo = join(home, 'git-fixture');
  const name = 'dsh-same-source-fixture';
  await fs.mkdir(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'DSH regression test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  const commit = async (version, bundle = true, content = version) => {
    await fs.writeFile(join(repo, 'package.json'), JSON.stringify({ name, version, ...(bundle ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}) }));
    await fs.writeFile(join(repo, 'cordis.patch.yml'), '[]\n');
    await fs.writeFile(join(repo, 'content.txt'), content);
    git('add', '.');
    git('commit', '--quiet', '-m', version);
    return git('rev-parse', 'HEAD');
  };
  const first = await commit('1.0.0');
  const spec = `git+${pathToFileURL(repo).href}`;
  await fs.writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  execFileSync(executable, [pnpm, 'add', spec, '--reporter=append-only'], {
    cwd: profile, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lockFile = join(profile, 'pnpm-lock.yaml');
  const readLock = () => fs.readFile(lockFile, 'utf8');
  const oldLock = await readLock();
  assert.ok(oldLock.includes(first), '初次安装应锁定第一个提交');
  // Same package version too: the Git commit and contents alone change.
  const second = await commit('1.0.0', true, '1.1.0');
  return { name, spec, first, second, oldLock, readLock, commit };
}

export async function verifyOriginalFailure(invoke, fixture, profile) {
  const result = await invoke('pluginManager', 'installBundle', { spec: fixture.spec, options: { enabled: false } });
  assert.equal(result.packageResult?.exitCode, 0, JSON.stringify(result));
  assert.equal(result.error?.code, 'ambiguous-install', JSON.stringify(result));
  assert.equal(await fs.readFile(join(profile, 'node_modules', fixture.name, 'content.txt'), 'utf8'), '1.1.0', 'pnpm 确实已下载新提交');
  assert.equal(await fixture.readLock(), fixture.oldLock, '旧版会把已更新的锁文件恢复');
  console.log('PASS: reproduced native ambiguous-install and old lockfile rollback');
}

export async function verifyFixedUpdates(invoke, fixture, profile) {
  const install = () => invoke('pluginManager', 'installBundle', { spec: fixture.spec, options: { enabled: false } });
  const result = await install();
  assert.equal(result.packageResult?.exitCode, 0, JSON.stringify(result));
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.bundle, fixture.name);
  assert.equal(result.application, 'restart-required');
  const updatedLock = await fixture.readLock();
  assert.ok(updatedLock.includes(fixture.second), '同一地址更新后应保留第二个提交');
  assert.ok(!updatedLock.includes(fixture.first), '不能恢复第一个提交');
  assert.equal(await fs.readFile(join(profile, 'node_modules', fixture.name, 'content.txt'), 'utf8'), '1.1.0');
  const repeat = await install();
  assert.equal(repeat.error, undefined, JSON.stringify(repeat));
  assert.equal(await fixture.readLock(), updatedLock, '没有新提交时再次安装也应成功');
  const manifestFile = join(profile, 'package.json');
  const manifest = await fs.readFile(manifestFile, 'utf8');
  assert.equal(JSON.parse(manifest).dependencies[fixture.name], fixture.spec, '保存的依赖来源仍是原 Git 地址');
  await fixture.commit('1.2.0', false);
  const invalid = await install();
  assert.equal(invalid.error?.code, 'not-bundle', JSON.stringify(invalid));
  assert.equal(await fixture.readLock(), updatedLock, '无效插件应恢复之前的锁文件');
  assert.equal(await fs.readFile(manifestFile, 'utf8'), manifest, '无效插件应恢复 manifest');
  // Restore valid package content for the remaining lifecycle checks.
  await fixture.commit('1.3.0');
  assert.equal((await install()).error, undefined);
  console.log('PASS: same URL/new commit, no-op repeat, exact package target, native validation and rollback');
}
