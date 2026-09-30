import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibilityError, compatibleCaller, readableError, RESTART_REQUIRED } from '../src/compatibility.js';

test('旧后台没有确认能力时给出重启提示，不发送设置请求', async () => {
  const requests = [];
  const call = compatibleCaller(async request => { requests.push(request); return { mode: 'approval', profiles: [] }; });
  const status = await call({ action: 'status' });
  assert.equal(compatibilityError(status), RESTART_REQUIRED);
  await assert.rejects(call({ action: 'set', mode: 'allow-all', acknowledgeRisk: true }), { message: RESTART_REQUIRED });
  assert.ok(requests.every(request => request.action === 'status'));
  assert.equal(compatibilityError(null), null);
});

test('兼容 0.1.1 后台，完整保留用户确认字段', async () => {
  const requests = [];
  const call = compatibleCaller(async request => {
    requests.push(request);
    return { mode: request.action === 'set' ? 'allow-all' : 'approval', riskAcknowledged: request.action === 'set' };
  });
  const result = await call({ action: 'set', mode: 'allow-all', acknowledgeRisk: true });
  assert.equal(result.mode, 'allow-all');
  assert.equal(compatibilityError(result), null);
  assert.deepEqual(requests, [{ action: 'status' }, { action: 'set', mode: 'allow-all', acknowledgeRisk: true }]);
});

test('复现截图中的 Zod 错误，转换提示且不删除确认字段重试', async () => {
  const requests = [];
  const message = JSON.stringify([{ code: 'unrecognized_keys', keys: ['acknowledgeRisk'], path: [], message: 'Unrecognized key: "acknowledgeRisk"' }]);
  const call = compatibleCaller(async request => {
    requests.push(request);
    if (request.action === 'status') return { mode: 'approval', riskAcknowledged: false };
    throw Error(message);
  });
  await assert.rejects(call({ action: 'set', mode: 'allow-all', acknowledgeRisk: true }), { message: RESTART_REQUIRED });
  assert.equal(requests.filter(request => request.action === 'set').length, 1);
  assert.equal(requests[1].acknowledgeRisk, true);
  assert.equal(readableError(Error('Unrecognized key: "acknowledgeRisk"')), RESTART_REQUIRED);
});

test('其他错误保留原始信息，不误报成升级问题', () => {
  const message = JSON.stringify([{ code: 'unrecognized_keys', keys: ['home'], path: [] }]);
  assert.equal(readableError(Error(message)), message);
  assert.equal(readableError(Error('网络连接已断开')), '网络连接已断开');
});
