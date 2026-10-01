import { test } from 'node:test';
import assert from 'node:assert/strict';
import { namedGitInstallSpec, installGitUpdateCompatibility } from '../src/git-update.js';

test('repeated Git installs use the actual dependency name, including scoped names', () => {
  const spec = 'github:author/repository';
  assert.equal(namedGitInstallSpec(spec, { '@scope/plugin': spec }), `@scope/plugin@${spec}`);
  const localGit = 'git+file:///tmp/test-repository';
  assert.equal(namedGitInstallSpec(localGit, { plugin: localGit }), `plugin@${localGit}`);
});

test('GitHub shorthand and HTTPS forms identify the same repository and ref', () => {
  const dependencies = { plugin: 'github:Author/Repository#preview' };
  for (const spec of ['https://github.com/author/repository#preview', 'git+https://github.com/Author/Repository.git#preview']) {
    assert.equal(namedGitInstallSpec(spec, dependencies), `plugin@${spec}`);
  }
});

test('different refs, credentials and protocols retain the original install spec', () => {
  const dependencies = { plugin: 'github:author/repository#main' };
  for (const spec of ['github:author/repository', 'github:author/repository#other', 'github:author/repository#MAIN', 'git+ssh://git@github.com/author/repository.git#main', 'https://user:secret@github.com/author/repository#main']) {
    assert.equal(namedGitInstallSpec(spec, dependencies), spec);
  }
});

test('new repositories and ambiguous dependency aliases are not guessed', () => {
  const spec = 'github:author/repository';
  assert.equal(namedGitInstallSpec(spec, {}), spec);
  assert.equal(namedGitInstallSpec(spec, { a: spec, b: 'https://github.com/author/repository' }), spec);
});

test('registry packages, named Git specs and local tarballs pass through', () => {
  for (const spec of ['plugin', 'plugin@latest', 'plugin@github:author/repository', 'file:C:/plugin.tgz', 'https://example.com/plugins/plugin.tgz', '-bad']) {
    assert.equal(namedGitInstallSpec(spec, { plugin: spec }), spec);
  }
});

test('unknown manager implementations remain untouched', () => {
  const manager = { profile: { dir: '.' }, installBundle() { return 'native'; } };
  const original = manager.installBundle;
  const dispose = installGitUpdateCompatibility(manager);
  assert.equal(manager.installBundle, original);
  dispose();
  assert.equal(manager.installBundle, original);
});
