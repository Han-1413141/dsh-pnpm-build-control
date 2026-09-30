import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { BuildControl } from '../src/core.js';

const work = resolve('.preview');
await fs.mkdir(work, { recursive: true });
const home = await fs.mkdtemp(join(work,'home-'));
for (const name of ['desktop','web','tui']) {
  const dir = join(home,'profiles',name); await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(join(dir,'package.json'),JSON.stringify({name:`dsh-profile-${name}`,dsh:{profile:{bundles:[]}}}));
  await fs.writeFile(join(dir,'pnpm-workspace.yaml'),'packages:\n  - .\nallowBuilds:\n  example-approved: true\n');
}
const controller = new BuildControl({home});
await controller.start();
const built = await build({entryPoints:['scripts/preview.jsx'],bundle:true,write:false,format:'esm',platform:'browser',define:{'process.env.NODE_ENV':'"development"'}});
const script = built.outputFiles[0].contents;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 构建审批开关验证</title><style>
*{box-sizing:border-box}body{margin:0;font:14px/1.6 system-ui,'Microsoft YaHei',sans-serif;background:#f7f8fa;color:#24262c}header{padding:22px 30px;display:flex;justify-content:space-between;border-bottom:1px solid #ddd}header span{font-size:12px;color:#777}main{padding:36px}h1{font-size:22px}button{font:inherit;cursor:pointer;border:1px solid #ddd;background:white;border-radius:8px;padding:7px 14px;margin-right:8px}button:focus-visible{outline:2px solid #4d6bfe}.backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0005;padding:20px}.dialog{background:white;width:520px;max-width:100%;max-height:90vh;overflow:auto;border:1px solid #ddd;border-radius:18px;padding:24px;box-shadow:0 20px 60px #0002}.heading{display:flex;align-items:center;justify-content:space-between}.heading h2{font-size:19px;margin:0}.heading button{border:0;font-size:23px;padding:0 4px}.description{color:#74777d;font-size:12px;margin:10px 0 18px}.fO69Vq_installBody{display:flex;flex-direction:column;gap:12px}.install-field input{width:100%;border:1px solid #d8dce3;border-radius:10px;padding:12px;font:inherit}.install-field input:focus{outline:2px solid #4d6bfe66;border-color:#4d6bfe}footer{display:flex;justify-content:flex-end;margin-top:24px}.primary{background:#4d6bfe;color:#fff;border-color:#4d6bfe}@media(max-width:500px){header span{display:none}.dialog{padding:18px}.backdrop{padding:12px}}
</style><div id="root"></div><script type="module" src="/preview.js"></script></html>`;
const server = createServer(async(req,res)=>{
  try {
    if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(html);}
    if(req.method==='GET'&&req.url==='/preview.js'){res.setHeader('Content-Type','text/javascript');return res.end(script);}
    if(req.method==='POST'&&req.url==='/rpc'){
      if(req.headers.origin && req.headers.origin !== `http://${req.headers.host}`){res.writeHead(403);return res.end();}
      let bytes=0,body='';for await(const chunk of req){bytes+=chunk.length;if(bytes>1024)throw Error('请求过大');body+=chunk;}
      const args=JSON.parse(body);
      const result=args.action==='status'?await controller.status():args.action==='set'?await controller.setMode(args.mode, { acknowledgeRisk: args.acknowledgeRisk }):(()=>{throw Error('无效操作');})();
      res.setHeader('Content-Type','application/json;charset=utf-8');return res.end(JSON.stringify(result));
    }
    res.writeHead(404);res.end();
  }catch(e){res.writeHead(400,{'Content-Type':'application/json;charset=utf-8'});res.end(JSON.stringify({error:e.message}));}
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,home})));
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>{server.close();controller.dispose();});
