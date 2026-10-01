import { dirname } from 'node:path';
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { BuildControl } from './core.js';
import { installGitUpdateCompatibility } from './git-update.js';

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('set'), mode: z.enum(['approval', 'allow-all']), acknowledgeRisk: z.boolean().optional() }).strict(),
]);

export class PnpmBuildControlService extends TypertRemoteService {
  constructor(ctx: any, private controller: BuildControl) { super(ctx, 'pnpmBuildControl'); }
  @Remote
  async request(payload: string): Promise<string> {
    if (Buffer.byteLength(payload, 'utf8') > 1024) throw new Error('请求过大。');
    const request = requestSchema.parse(JSON.parse(payload));
    const result = request.action === 'status' ? await this.controller.status() : await this.controller.setMode(request.mode, { acknowledgeRisk: request.acknowledgeRisk });
    return JSON.stringify(result);
  }
}

export const name = 'dsh-pnpm-build-control';
export const inject = ['profileContext'];
export async function apply(ctx: any) {
  const homePath = ctx.get('dshHomePath');
  const home = typeof homePath === 'function' ? homePath() : dirname(dirname(ctx.profileContext.dir));
  const controller = new BuildControl({ home, onError: (error: Error) => console.warn(`[${name}] ${error.message}`) });
  new PnpmBuildControlService(ctx, controller);
  ctx.effect(() => () => controller.dispose(), `${name}: close file watchers`);
  // ./typert 由 DSH 的 typert-loader 统一注册；手动注册会与完整启动过程
  // 竞争同一个 package face，导致加载器回滚其他插件的远程接口。
  await controller.start();
  ctx.inject(['pluginManager'], (child: any) => {
    child.effect(() => installGitUpdateCompatibility(child.pluginManager), `${name}: same-source Git updates`);
  });
}
