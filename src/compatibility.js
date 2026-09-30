export const RESTART_REQUIRED = '插件界面已更新，但 DSH 后台仍在运行旧版插件。请完整退出 DeepSeek Harness 后重新打开（如有托盘图标，也需退出）；只刷新页面或关闭“添加插件”弹窗不会更新后台。重启前保持当前审批设置。';

export function compatibilityError(status) {
  return status && typeof status.riskAcknowledged !== 'boolean' ? RESTART_REQUIRED : null;
}

export function readableError(error) {
  const message = String(error?.message ?? error);
  try {
    const issues = JSON.parse(message);
    if (Array.isArray(issues) && issues.some(issue => issue?.code === 'unrecognized_keys' && issue.keys?.includes('acknowledgeRisk'))) return RESTART_REQUIRED;
  } catch {}
  if (/unrecognized key[^\n]*acknowledgeRisk/i.test(message)) return RESTART_REQUIRED;
  return message;
}

// 更新界面和更新后台代码不是同一个操作。每次写入前重新查询后台能力，
// 不删除 acknowledgeRisk 字段重试，避免丢失用户的首次确认记录。
export function compatibleCaller(remoteCall) {
  return async request => {
    try {
      if (request.action === 'set') {
        const issue = compatibilityError(await remoteCall({ action: 'status' }));
        if (issue) throw new Error(issue);
      }
      return await remoteCall(request);
    } catch (error) { throw new Error(readableError(error)); }
  };
}
