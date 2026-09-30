import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { apply } from '../src/client.jsx';

let Overlay = () => null;
const disposers = [];
const ctx = {
  effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose); },
  inject(_names, fn) { fn(ctx); },
  remote: { $mount: async () => () => {}, pnpmBuildControl: { request: async payload => {
    const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: payload });
    const data = await response.json();
    return response.ok ? { ok: true, value: JSON.stringify(data) } : { ok: false, error: { message: data.error } };
  } } },
  slots: { inject(_name, fn) { const dispose = fn(); if (dispose) disposers.push(dispose); }, register(_options, component) { Overlay = component; return () => {}; } },
};
await apply(ctx);
function Preview() {
  const [open, setOpen] = useState(true);
  const [spec, setSpec] = useState('');
  const [english, setEnglish] = useState(false);
  const [checking, setChecking] = useState(false);
  return <><header><strong>DSH 插件界面验证</strong><span>独立测试配置 · 不修改实际 DSH 设置</span></header>
    <main><h1>插件</h1><button onClick={() => { setChecking(false); setOpen(true); }}>添加插件</button><button onClick={() => setEnglish(!english)}>切换语言</button></main>
    {open && <div className="backdrop"><section role="dialog" aria-modal="true" aria-label={english ? 'Add plugin' : '添加插件'} className="dialog">
      <div className="heading"><h2>{english ? 'Add plugin' : '添加插件'}</h2><button aria-label="关闭" onClick={() => setOpen(false)}>×</button></div>
      <p className="description">从 npm、GitHub 或本地目录添加插件。</p>
      {!checking ? <div className="fO69Vq_installBody"><div className="install-field"><input type="text" aria-label={english ? 'Package name or address' : '包名或地址'} value={spec} onChange={e=>setSpec(e.target.value)} placeholder="例如 dsh-plugin-whale-pet" /></div><p className="description">支持包名、GitHub 仓库地址和本地路径。</p></div> : <p>安装流程示例</p>}
      <footer><button onClick={()=>setOpen(false)}>取消</button><button className="primary" onClick={()=>setChecking(!checking)}>{checking ? '返回' : '下一步'}</button></footer>
    </section></div>}
    <Overlay />
  </>;
}
createRoot(document.getElementById('root')).render(<Preview />);
