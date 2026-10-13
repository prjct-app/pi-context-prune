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

import { initialState, planRequest, queueMemoryPrune } from '../index.ts';

const cfg = { memory: true, memoryAdvance: 1, reasoning: true, keep: 1, advance: 1 };
const memorySnapshot = (revision: string) => ({ role: 'user', content: `<memory_snapshot revision="${revision}" trust="untrusted">\nThis snapshot supersedes earlier ones ${'x'.repeat(40)}` });

test('planning a request never changes the state it was given', () => {
  const before = initialState();
  const input = [memorySnapshot('1'), memorySnapshot('2'), { type: 'reasoning', id: 'r1' }, { type: 'reasoning', id: 'r2' }];
  const plan = planRequest(before, input, cfg);
  assert.equal(before.dropped.size, 0);
  assert.equal(before.frontier, 0);
  assert.ok(plan.state.dropped.size > 0, 'the superseded snapshot is retired in the new state');
  assert.ok(plan.drop.has(0), 'the older snapshot is dropped from the payload');
  assert.ok(!plan.drop.has(1), 'the current snapshot stays');
  assert.ok(plan.drop.has(2) && !plan.drop.has(3), 'reasoning keeps the protected window');
});

test('a queued prune is a new state and is consumed by the next request', () => {
  const queued = queueMemoryPrune(initialState());
  assert.equal(initialState().memoryNow, false);
  assert.equal(queued.memoryNow, true);
  const plan = planRequest(queued, [memorySnapshot('1'), memorySnapshot('2')], { ...cfg, reasoning: false, memoryAdvance: 1e9 });
  assert.equal(plan.state.memoryNow, false);
  assert.equal(queued.memoryNow, true);
});

test('a request with nothing to retire returns the same state value', () => {
  const state = initialState();
  const plan = planRequest(state, [{ role: 'user', content: 'hola' }], { ...cfg, memory: false });
  assert.equal(plan.state, state);
  assert.equal(plan.drop.size, 0);
});
