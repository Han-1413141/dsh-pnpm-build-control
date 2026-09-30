import { promises as fs, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDocument, isMap } from 'yaml';
import { RISK_NOTICE_VERSION, RISK_NOTICE } from './risk.js';

const MODES = new Set(['approval', 'allow-all']);
const FLAG = 'dangerouslyAllowAllBuilds';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)); };

export function resolveHome(explicit) {
  const value = explicit ?? (process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'));
  return resolve(value === '~' ? homedir() : /^~[/\\]/.test(value) ? join(homedir(), value.slice(2)) : value);
}

async function optionalRead(path) {
  try { return await fs.readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function decode(buffer, path) {
  if (buffer.length > 1024 * 1024) throw new Error(`配置文件超过 1 MiB：${path}`);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { throw new Error(`配置文件不是有效 UTF-8，未改写：${path}`); }
}

function parseYaml(buffer, path) {
  const text = buffer ? decode(buffer, path) : '';
  const bom = text.startsWith('\uFEFF');
  const doc = parseDocument(bom ? text.slice(1) : text, { keepSourceTokens: true });
  if (doc.errors.length) throw new Error(`YAML 无法解析：${path}；${doc.errors[0].message}`);
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error(`YAML 顶层必须是映射：${path}`);
  if (doc.has(FLAG) && typeof doc.get(FLAG) !== 'boolean') throw new Error(`${FLAG} 必须是布尔值：${path}`);
  return { doc, bom, crlf: text.includes('\r\n') };
}

async function safeFile(path, root) {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`配置文件不是普通文件：${path}`);
    if (!inside(root, await fs.realpath(path))) throw new Error(`配置文件位于 DSH 配置目录外：${path}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function atomicWrite(path, bytes) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, path);
  } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export class BuildControl {
  constructor(options = {}) {
    this.home = resolveHome(options.home);
    this.profilesRoot = join(this.home, 'profiles');
    this.dataRoot = join(this.home, 'pnpm-build-control');
    this.statePath = join(this.dataRoot, 'state.json');
    this.lockPath = join(this.dataRoot, 'write.lock');
    this.lastError = null;
    this.queue = Promise.resolve();
    this.disposed = false;
    this.watchers = new Map();
    this.onError = options.onError ?? (() => {});
  }

  async state() {
    const bytes = await optionalRead(this.statePath);
    if (!bytes) return { schemaVersion: 1, mode: null, lastBackup: null };
    const state = JSON.parse(decode(bytes, this.statePath));
    if (state.schemaVersion !== 1 || !MODES.has(state.mode)) throw new Error('插件状态文件无效，请检查 state.json。');
    return state;
  }

  async profiles() {
    let entries;
    try { entries = await fs.readdir(this.profilesRoot, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const root = await fs.realpath(this.profilesRoot);
    const result = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
      const dir = join(this.profilesRoot, entry.name);
      let manifest;
      try {
        if (!inside(root, await fs.realpath(dir))) continue;
        const bytes = await optionalRead(join(dir, 'package.json'));
        if (!bytes) continue;
        manifest = JSON.parse(decode(bytes, join(dir, 'package.json')));
      } catch (error) { result.push({ name: entry.name, path: join(dir, 'pnpm-workspace.yaml'), error: error.message }); continue; }
      if (!Array.isArray(manifest.dsh?.profile?.bundles)) continue;
      const path = join(dir, 'pnpm-workspace.yaml');
      try {
        await safeFile(path, root);
        const original = await optionalRead(path);
        const parsed = parseYaml(original, path);
        result.push({ name: entry.name, path, original, ...parsed });
      } catch (error) { result.push({ name: entry.name, path, error: error.message }); }
    }
    return result;
  }

  async status() {
    const [state, profiles] = await Promise.all([this.state(), this.profiles()]);
    const rows = profiles.map(p => ({ name: p.name, path: p.path,
      mode: p.error ? 'error' : p.doc.get(FLAG) === true ? 'allow-all' : 'approval',
      error: p.error ?? null, scriptsIgnored: !p.error && p.doc.get('ignoreScripts') === true,
    }));
    const modes = new Set(rows.map(p => p.mode));
    return { home: this.home, desiredMode: state.mode, mode: rows.length === 0 ? 'empty' : modes.size === 1 ? rows[0].mode : 'mixed',
      profiles: rows, lastBackup: state.lastBackup, changedAt: state.changedAt ?? null, error: this.lastError,
      monitoring: this.monitoring === true, riskAcknowledged: state.riskAcknowledgement?.version === RISK_NOTICE_VERSION };
  }

  exclusive(work) {
    const pending = this.queue.catch(() => {}).then(async () => {
      if (this.disposed) throw new Error('插件已停止。');
      await fs.mkdir(this.dataRoot, { recursive: true });
      const id = randomUUID();
      for (let attempt = 0; ; attempt++) {
        try {
          const handle = await fs.open(this.lockPath, 'wx', 0o600);
          try { await handle.writeFile(JSON.stringify({ pid: process.pid, id })); } finally { await handle.close(); }
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          let owner;
          try { owner = JSON.parse(await fs.readFile(this.lockPath, 'utf8')); } catch {}
          if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); } catch (e) {
              if (e.code === 'ESRCH') { await fs.unlink(this.lockPath).catch(() => {}); continue; }
            }
          }
          if (attempt >= 50) throw new Error('另一 DSH 进程正在修改构建设置，请稍后重试。');
          await delay(100);
        }
      }
      try { return await work(); }
      finally {
        const owner = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
        if (owner.id === id) await fs.unlink(this.lockPath);
      }
    });
    this.queue = pending;
    return pending;
  }

  async setMode(mode, { acknowledgeRisk = false } = {}) {
    if (!MODES.has(mode)) throw new Error('无效模式；只能选择 approval 或 allow-all。');
    await this.exclusive(async () => {
      const previous = await this.state();
      if (mode === 'allow-all' && previous.riskAcknowledgement?.version !== RISK_NOTICE_VERSION && acknowledgeRisk !== true) {
        throw new Error(`首次关闭审批前需要确认风险。${RISK_NOTICE} 如使用命令行，确认后添加 --accept-risk。`);
      }
      await this.applyMode(mode, mode === 'allow-all' && acknowledgeRisk === true);
    });
    return this.status();
  }

  async applyMode(mode, acknowledgeRisk = false) {
    const [profiles, previous] = await Promise.all([this.profiles(), this.state()]);
    if (!profiles.length) throw new Error('没有找到 DSH 配置，未修改任何 pnpm 设置。');
    const invalid = profiles.filter(p => p.error);
    if (invalid.length) throw new Error(invalid.map(p => `${p.name}：${p.error}`).join('\n'));
    const value = mode === 'allow-all';
    const changed = profiles.filter(p => p.doc.get(FLAG) !== value);
    for (const p of changed) {
      p.doc.set(FLAG, value);
      let text = p.doc.toString({ lineWidth: 0 });
      if (p.crlf) text = text.replace(/\r?\n/g, '\r\n');
      p.next = Buffer.from((p.bom ? '\uFEFF' : '') + text, 'utf8');
    }
    const needsAcknowledgement = acknowledgeRisk && previous.riskAcknowledgement?.version !== RISK_NOTICE_VERSION;
    if (!changed.length && previous.mode === mode && !needsAcknowledgement) { this.lastError = null; return; }
    const at = new Date().toISOString();
    let backup = previous.lastBackup;
    if (changed.length) {
      backup = join(this.dataRoot, 'backups', `${at.replace(/[:.]/g, '-')}-${randomUUID().slice(0,8)}`);
      await fs.mkdir(backup, { recursive: true });
      for (const p of changed) {
        if (p.original) await fs.writeFile(join(backup, `${p.name}.pnpm-workspace.yaml`), p.original, { flag: 'wx', mode: 0o600 });
      }
      await fs.writeFile(join(backup, 'manifest.json'), JSON.stringify({ at, mode, profiles: changed.map(p => ({ name: p.name, path: p.path, existed: p.original !== null })) }, null, 2) + '\n');
    }
    const written = [];
    try {
      for (const p of changed) {
        await safeFile(p.path, await fs.realpath(this.profilesRoot));
        const now = await optionalRead(p.path);
        if (!(p.original === null ? now === null : now?.equals(p.original))) throw new Error(`配置已被其他进程修改，请重试：${p.name}`);
        await atomicWrite(p.path, p.next);
        written.push(p);
      }
      const riskAcknowledgement = needsAcknowledgement ? { version: RISK_NOTICE_VERSION, acknowledgedAt: at } : previous.riskAcknowledgement;
      await atomicWrite(this.statePath, Buffer.from(JSON.stringify({ schemaVersion: 1, mode, changedAt: at, lastBackup: backup, riskAcknowledgement }, null, 2) + '\n'));
      this.lastError = null;
    } catch (error) {
      const failures = [];
      for (const p of written.reverse()) {
        try {
          const now = await optionalRead(p.path);
          if (!now?.equals(p.next)) throw new Error('文件在切换期间再次变化');
          if (p.original === null) await fs.unlink(p.path); else await atomicWrite(p.path, p.original);
        } catch (e) { failures.push(`${p.name}：${e.message}`); }
      }
      throw new Error(`${error.message}${failures.length ? `；恢复未完成：${failures.join('；')}；备份：${backup}` : '；本次已写入的配置已恢复。'}`);
    }
  }

  async reconcile() {
    await this.exclusive(async () => { const state = await this.state(); if (state.mode) await this.applyMode(state.mode); });
    if (this.monitoring) await this.refreshWatchers();
  }

  schedule() {
    if (this.disposed) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.reconcile().catch(e => this.report(e)); }, 350);
    this.debounce.unref?.();
  }

  report(error) { this.lastError = error.message; this.onError(error); }

  async refreshWatchers() {
    if (this.disposed) return;
    const profiles = await this.profiles();
    if (this.disposed) return;
    const paths = new Set([this.profilesRoot, this.dataRoot, ...profiles.map(p => join(this.profilesRoot, p.name))]);
    for (const [path, watcher] of this.watchers) if (!paths.has(path)) { watcher.close(); this.watchers.delete(path); }
    for (const path of paths) {
      if (this.watchers.has(path)) continue;
      try {
        const watcher = watch(path, { persistent: false }, (_event, filename) => {
          if (path === this.profilesRoot || (path === this.dataRoot ? filename === 'state.json' : ['package.json','pnpm-workspace.yaml'].includes(String(filename)))) this.schedule();
        });
        watcher.on('error', e => { watcher.close(); this.watchers.delete(path); this.report(e); });
        this.watchers.set(path, watcher);
      } catch (e) { if (e.code !== 'ENOENT') this.report(e); }
    }
  }

  async start() {
    this.monitoring = true;
    await this.reconcile().catch(e => this.report(e));
    await this.refreshWatchers();
    if (this.disposed) return;
    this.interval = setInterval(() => { this.reconcile().catch(e => this.report(e)); }, 60_000);
    this.interval.unref?.();
  }

  async dispose() {
    this.disposed = true;
    this.monitoring = false;
    clearTimeout(this.debounce);
    clearInterval(this.interval);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    await this.queue.catch(() => {});
  }
}
