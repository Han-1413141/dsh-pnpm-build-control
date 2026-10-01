import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

function gitSource(value) {
  if (typeof value !== 'string') return null;
  const spec = value.trim();
  const github = spec.match(/^github:([^/#]+)\/([^/#]+)(#.*)?$/i);
  if (github) return `github:${github[1].toLowerCase()}/${github[2].replace(/\.git$/, '').toLowerCase()}${github[3] || ''}`;
  if (/^(?:gitlab|bitbucket|gist):|^git(?:\+[a-z]+)?:\/\/|^git@[^:]+:/.test(spec)) {
    if (!spec.startsWith('git+https://github.com/')) return spec;
  } else if (!/^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:#.*)?$/.test(spec)) return null;
  try {
    const url = new URL(spec.replace(/^git\+/, ''));
    if (/\.(?:tgz|tar\.gz)$/.test(url.pathname)) return null;
    // Only equate public GitHub HTTPS forms. Keep credentials, other transports,
    // and explicit refs distinct; never silently switch a branch, tag or commit.
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search) return spec;
    const path = url.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
    if (!path) return spec;
    return `github:${path[1].toLowerCase()}/${path[2].replace(/\.git$/, '').toLowerCase()}${url.hash}`;
  } catch { return spec; }
}

export function namedGitInstallSpec(spec, dependencies = {}) {
  const source = gitSource(spec);
  if (!source || !dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return spec;
  const names = Object.entries(dependencies)
    .filter(([name, value]) => PACKAGE_NAME.test(name) && gitSource(value) === source)
    .map(([name]) => name);
  return names.length === 1 ? `${names[0]}@${spec.trim()}` : spec;
}

export function installGitUpdateCompatibility(service) {
  // Cordis wraps service reads. Change only this service instance, retaining the
  // caller's context and the Remote markers on its untouched class prototype.
  const manager = service[Symbol.for('cordis.original')] ?? service;
  const original = manager.installBundle;
  if (typeof original !== 'function' || typeof manager.profile?.dir !== 'string') return () => {};
  const source = Function.prototype.toString.call(original).replace(/\s+/g, '');
  const faultyFallback = 'if(installed.length===0)installed.push(...Object.keys(after).filter((name)=>spec===name||spec.startsWith(`${name}@`)));consttarget=installed[0];';
  // Scope the workaround to the known rc.2 implementation. A different native
  // implementation (including an upstream fix) keeps its own install behavior.
  if (!source.includes('before[name]!==after[name]') || !source.includes(faultyFallback)) return () => {};
  const ownDescriptor = Object.getOwnPropertyDescriptor(manager, 'installBundle');
  if (ownDescriptor && !ownDescriptor.configurable) return () => {};
  function installBundle(spec, ...args) {
    let namedSpec = spec;
    if (gitSource(spec)) {
      try {
        const manifest = JSON.parse(readFileSync(join(manager.profile.dir, 'package.json'), 'utf8'));
        namedSpec = namedGitInstallSpec(spec, manifest.dependencies);
      } catch {
        // Let the native manager report unreadable/invalid manifests itself.
      }
    }
    if (namedSpec === spec) return original.call(this, spec, ...args);
    // pnpm add <name>@<git-url> can reuse the old locked commit. Give DSH the
    // explicit identity, but pass the original URL to pnpm so it resolves HEAD
    // again. The receiver belongs to this one invocation; no shared runPnpm
    // method or concurrent installation is modified.
    const receiver = new Proxy(this, {
      get(target, property, receiver) {
        if (property !== 'runPnpm') return Reflect.get(target, property, receiver);
        return (argv, ...rest) => target.runPnpm(
          argv[0] === 'add' && argv[1] === namedSpec ? [argv[0], spec, ...argv.slice(2)] : argv,
          ...rest,
        );
      },
    });
    return original.call(receiver, namedSpec, ...args);
  }
  Object.defineProperty(manager, 'installBundle', { configurable: true, writable: true, value: installBundle });
  return () => {
    if (manager.installBundle !== installBundle) return;
    if (ownDescriptor) Object.defineProperty(manager, 'installBundle', ownDescriptor);
    else delete manager.installBundle;
  };
}
