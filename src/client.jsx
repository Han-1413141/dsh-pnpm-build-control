import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TYPERT_REMOTE } from './typert.js';
import { RISK_NOTICE } from './risk.js';
import { compatibilityError, compatibleCaller, readableError } from './compatibility.js';

const STYLE = `
.dsh-pnpm-control{font-size:12px;line-height:1.6;border:1px solid var(--dsw-alias-border-l4,#ddd);border-radius:12px;padding:12px 14px;color:var(--dsw-alias-label-primary,#222);background:var(--dsw-alias-bg-layer-1,#fff)}
.dsh-pnpm-control *{box-sizing:border-box}.dsh-pnpm-control .pbc-row{display:flex;align-items:center;justify-content:space-between;gap:16px}.dsh-pnpm-control strong{font-size:13px;font-weight:550}
.dsh-pnpm-control p{margin:3px 0 0;color:var(--dsw-alias-label-secondary,#666)}.dsh-pnpm-control button{font:inherit;cursor:pointer}.dsh-pnpm-control button:disabled{cursor:wait;opacity:.5}
.dsh-pnpm-control .pbc-switch{position:relative;flex-shrink:0;width:38px;height:23px;border:0;border-radius:20px;padding:0;background:var(--dsw-alias-label-tertiary,#9399a0);transition:background .15s}
.dsh-pnpm-control .pbc-switch[aria-checked=true]{background:var(--dsw-alias-state-business-primary,#4d6bfe)}.dsh-pnpm-control .pbc-switch span{position:absolute;top:3px;left:3px;width:17px;height:17px;border-radius:50%;background:white;transition:transform .15s}.dsh-pnpm-control .pbc-switch[aria-checked=true] span{transform:translateX(15px)}
.dsh-pnpm-control :focus-visible{outline:2px solid #4d6bfe;outline-offset:3px}.dsh-pnpm-control .pbc-status{font-size:11px;margin-top:8px}.dsh-pnpm-control .pbc-error{color:var(--dsw-alias-state-danger-primary,#bd3535);overflow-wrap:anywhere}
.dsh-pnpm-control details{margin-top:8px}.dsh-pnpm-control summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#666)}.dsh-pnpm-control ul{padding-left:18px;margin:6px 0 0}.dsh-pnpm-control .pbc-retry{border:0;background:transparent;color:var(--dsw-alias-state-business-primary,#4d6bfe);padding:0 0 0 8px}
.dsh-pnpm-control .pbc-risk{margin-top:12px;padding:12px;border:1px solid var(--dsw-alias-state-warning-primary,#bd7d24);border-radius:8px}.dsh-pnpm-control .pbc-risk p{color:inherit;margin-top:6px}.dsh-pnpm-control .pbc-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:12px}.dsh-pnpm-control .pbc-actions button{padding:5px 10px;border:1px solid var(--dsw-alias-border-l4,#ccc);border-radius:6px;background:transparent;color:inherit}.dsh-pnpm-control .pbc-actions .pbc-confirm{background:#a34e11;border-color:#a34e11;color:white}
@media(prefers-reduced-motion:reduce){.dsh-pnpm-control .pbc-switch,.dsh-pnpm-control .pbc-switch span{transition:none}}
`;
const LABELS = { approval: '审批已开启', 'allow-all': '审批已关闭', mixed: '各配置的设置不同', error: '配置读取失败', empty: '未找到 DSH 配置' };

export function Control({ call }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showRisk, setShowRisk] = useState(false);
  const cancelRef = useRef(null);
  const switchRef = useRef(null);
  useEffect(() => { if (showRisk) cancelRef.current?.focus(); }, [showRisk]);
  const refresh = useCallback(async () => {
    try { const value = await call({ action: 'status' }); setStatus(value); setError(''); }
    catch (error) { setError(readableError(error)); }
  }, [call]);
  useEffect(() => { let alive = true; call({ action: 'status' }).then(s => { if (alive) setStatus(s); }).catch(e => { if (alive) setError(readableError(e)); });
    window.addEventListener('focus', refresh); return () => { alive = false; window.removeEventListener('focus', refresh); }; }, [call, refresh]);
  const apply = async (mode, acknowledgeRisk = false) => {
    setBusy(true); setError('');
    try { setStatus(await call({ action: 'set', mode, ...(acknowledgeRisk ? { acknowledgeRisk: true } : {}) })); setShowRisk(false); }
    catch (error) { setError(readableError(error)); }
    finally { setBusy(false); }
  };
  const toggle = () => {
    const mode = status.mode === 'approval' ? 'allow-all' : 'approval';
    if (mode === 'allow-all' && !status.riskAcknowledged) { setShowRisk(true); return; }
    return apply(mode);
  };
  const cancelRisk = () => { setShowRisk(false); switchRef.current?.focus(); };
  const incompatibility = compatibilityError(status);
  const disabled = busy || !status || !!incompatibility || ['empty', 'error'].includes(status.mode) || status.profiles.some(p => p.error);
  return <section className="dsh-pnpm-control" aria-label="pnpm 构建脚本审批">
    <div className="pbc-row"><div><strong>构建脚本审批</strong><p>作用于所有 DSH 配置中的全部插件和依赖。</p></div>
      <button ref={switchRef} className="pbc-switch" type="button" role="switch" aria-label="构建脚本审批（所有 DSH 配置）" aria-checked={status?.mode === 'approval'} disabled={disabled} onClick={toggle} title={status?.mode === 'approval' ? '关闭审批，允许所有依赖构建' : '开启审批，按原有允许列表执行'}><span /></button>
    </div>
    <p className="pbc-status" role="status" aria-live="polite">{busy ? '正在应用到所有 DSH 配置…' : status ? `${LABELS[status.mode]}${status.mode === 'approval' ? ' · 按允许列表执行构建脚本' : status.mode === 'allow-all' ? ' · 允许全部构建脚本执行' : ''}` : '正在读取设置…'}</p>
    {showRisk && !incompatibility && <div className="pbc-risk" role="group" aria-label="首次关闭审批的风险确认" onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); cancelRisk(); } }}>
      <strong>首次关闭审批：请确认风险</strong><p>{RISK_NOTICE}</p><p>确认后会在当前 DSH 数据目录中记录，后续切换不再重复提示。</p>
      <div className="pbc-actions"><button ref={cancelRef} type="button" disabled={busy} onClick={cancelRisk}>取消，保持原设置</button><button className="pbc-confirm" type="button" disabled={busy} onClick={() => apply('allow-all', true)}>我已了解风险，关闭审批</button></div>
    </div>}
    {(incompatibility || error || status?.error) && <p className="pbc-error" role="alert">{incompatibility || error || status.error}<button type="button" className="pbc-retry" onClick={refresh}>重新检查</button></p>}
    {status?.profiles.length > 0 && <details><summary>查看 {status.profiles.length} 个配置的状态</summary><ul>{status.profiles.map(p => <li key={p.name}>{p.name}：{LABELS[p.mode]}{p.scriptsIgnored ? '（该配置另设了 ignoreScripts，脚本仍被禁用）' : ''}{p.error ? ` · ${p.error}` : ''}</li>)}</ul><p>下次安装或更新时生效。原有允许列表会保留。</p></details>}
  </section>;
}

// DSH 0.2.0-rc.2 的添加插件弹窗没有独立插槽。只在源码中明确标识的
// 安装输入框旁创建本插件的挂载点；通过 shell.overlay 管理组件生命周期。
export function InstallDialogControl({ call }) {
  const [target, setTarget] = useState(null);
  useEffect(() => {
    let owned = null;
    const find = () => {
      const inputs = document.querySelectorAll('[role="dialog"] input[aria-label]');
      const input = [...inputs].find(el => ['包名或地址', 'Package name or address', '插件包名', 'Plugin package name'].includes(el.getAttribute('aria-label')) && el.closest('[class$="_installBody"], [data-dsh-plugin-install-body]'));
      const body = input?.closest('[class$="_installBody"], [data-dsh-plugin-install-body]');
      if (!body) { if (owned) { owned.remove(); owned = null; setTarget(null); } return; }
      if (owned?.isConnected && owned.parentElement === body) return;
      owned?.remove();
      owned = document.createElement('div');
      owned.dataset.dshPnpmBuildControl = 'true';
      const field = input.parentElement;
      if (field?.parentElement === body) field.after(owned); else body.prepend(owned);
      setTarget(owned);
    };
    const observer = new MutationObserver(find);
    observer.observe(document.body, { childList: true, subtree: true });
    find();
    return () => { observer.disconnect(); owned?.remove(); };
  }, []);
  return target ? createPortal(<Control call={call} />, target) : null;
}

export const inject = ['slots', 'remote'];
export async function apply(ctx) {
  ctx.effect(() => { const el = document.createElement('style'); el.dataset.plugin = 'dsh-pnpm-build-control'; el.textContent = STYLE; document.head.append(el); return () => el.remove(); }, 'pnpm-build-control: styles');
  let mountingError;
  try { const dispose = await ctx.remote.$mount(TYPERT_REMOTE); ctx.effect(() => dispose, 'pnpm-build-control: remote contract'); }
  catch (error) { mountingError = error; }
  const register = child => {
    const call = compatibleCaller(async request => {
      if (mountingError) throw new Error(`构建设置接口未就绪：${String(mountingError.message ?? mountingError)}`);
      const response = await child.remote.pnpmBuildControl.request(JSON.stringify(request));
      if (!response.ok) throw new Error(response.error.message);
      return JSON.parse(response.value);
    });
    child.slots.inject('shell.overlay', () => child.slots.register({ name: 'shell.overlay', id: 'pnpm-build-control.install' }, () => <InstallDialogControl call={call} />));
  };
  if (mountingError) register(ctx); else ctx.inject(['remote.pnpmBuildControl'], register);
}
