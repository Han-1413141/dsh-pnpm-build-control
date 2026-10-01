import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('lib', { recursive: true });
await build({ entryPoints: ['src/index.ts'], outdir: 'lib', platform: 'node', format: 'esm', target: 'node22.19', bundle: false });
for (const file of ['core.js', 'typert.js', 'cli.js', 'risk.js', 'git-update.js']) await copyFile(`src/${file}`, `lib/${file}`);
await build({ entryPoints: ['src/client.jsx'], outfile: 'lib/client.js', platform: 'browser', format: 'cjs', target: 'es2022', bundle: true, minify: true,
  external: ['react', 'react-dom', 'react/jsx-runtime'], define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-pnpm-build-control",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
});
console.log('Built host, client, CLI and Typert contract.');
