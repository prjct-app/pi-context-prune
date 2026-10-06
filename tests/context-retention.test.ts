import assert from 'node:assert/strict';
import { test } from 'node:test';
import install, { memoryItems } from '../index.ts';

test('default installation leaves provider payload and reasoning to Pi', () => {
  assert.equal(process.env.PI_PRUNE, undefined, 'run this regression without an explicit pruning override');
  const handlers = new Map<string, Function[]>();
  const pi = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    events: { on() {} },
    registerCommand() {},
  };
  install(pi as never);
  assert.equal(handlers.has('before_provider_request'), false, 'no payload pruning is registered');
});

test('quoted memory markup in an ordinary request is not automatic memory', () => {
  assert.deepEqual(memoryItems([
    { role: 'user', content: 'Fix the <memory_snapshot revision="x"> parser and retain this constraint.' },
    { role: 'assistant', type: 'message', content: '<retained_memory trust="untrusted">\nquoted source' },
  ]), []);
});
