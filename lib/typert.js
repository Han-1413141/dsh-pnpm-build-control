import { string } from 'zod';

const pkg = 'dsh-pnpm-build-control';
const service = 'pnpmBuildControl';
const id = `${pkg}#${service}/request`;
const codec = label => { const schema = string(); return { mode: 'strict', typeSymbol: `${id}:${label}`, create: () => schema, schema }; };
const descriptor = {
  id, service, namespace: service, method: 'request', invocation: { kind: 'direct' },
  parameters: [{ name: 'payload', wire: 'payload', source: 'json', codec: codec('payload') }], result: codec('result'),
};
export const TYPERT = { package: pkg, face: 'host', schemas: [], invocations: [descriptor], model: { services: [], events: [], objects: [] } };
export const TYPERT_REMOTE = { package: pkg, descriptors: [descriptor] };
