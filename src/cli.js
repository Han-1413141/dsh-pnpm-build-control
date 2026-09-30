#!/usr/bin/env node
import { BuildControl } from './core.js';

const args = process.argv.slice(2);
const riskIndex = args.indexOf('--accept-risk');
const acknowledgeRisk = riskIndex >= 0;
if (acknowledgeRisk) args.splice(riskIndex, 1);
const homeIndex = args.indexOf('--home');
const home = homeIndex >= 0 ? args[homeIndex + 1] : undefined;
if (homeIndex >= 0) args.splice(homeIndex, 2);
const [command = 'status'] = args;
if (args.length > 1 || !['status', 'on', 'off', '--help'].includes(command) || (homeIndex >= 0 && !home) || (acknowledgeRisk && command !== 'off')) {
  console.error('用法：dsh-pnpm-build-control status|on|off [--home DSH目录] [--accept-risk（仅 off）]');
  process.exitCode = 1;
} else if (command === '--help') {
  console.log('status：查看所有 DSH 配置；on：开启构建脚本审批；off：关闭审批，允许所有依赖构建。\n可使用 --home 指定 DSH_HOME。首次 off 会显示风险说明，确认后加 --accept-risk 再执行。');
} else {
  const controller = new BuildControl({ home });
  try { console.log(JSON.stringify(command === 'status' ? await controller.status() : await controller.setMode(command === 'on' ? 'approval' : 'allow-all', { acknowledgeRisk }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await controller.dispose(); }
}
