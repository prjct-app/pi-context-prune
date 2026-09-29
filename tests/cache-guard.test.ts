import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installCacheGuard, switchCost, warmingAction } from '../cache-guard.ts';

const sol = { provider: 'openai-codex', id: 'gpt-6-sol', cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } };
const mimo = { provider: 'xiaomi-token-plan-sgp', id: 'mimo-v2.6-pro', cost: { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 } };

test('warming follows the miss/hit ratio, not a dollar threshold', () => {
  // Xiaomi, idle, 150k: miss 120x a ping.
  assert.equal(warmingAction({ missCost: 0.065, warmCost: 0.00054, continuationProbability: 0.15 }), 'warm');
  // Codex, idle: 0.15 x 11.5 < 2.
  assert.equal(warmingAction({ missCost: 0.345, warmCost: 0.03, continuationProbability: 0.15 }), 'stop');
  // Codex, during a run.
  assert.equal(warmingAction({ missCost: 0.345, warmCost: 0.03, continuationProbability: 1 }), 'warm');
  // Unpriced model: Pi decides.
  assert.equal(warmingAction({ missCost: 0, warmCost: 0, continuationProbability: 1 }), undefined);
});

test('the switch cost names tokens, dollars and cached requests', () => {
  const { summary, hits } = switchCost(sol, mimo, 117_000);
  assert.match(summary, /re-sends 117k tokens \(~\$0\.05\)/);
  assert.equal(hits, 121);
});

function harness(tokens: number, mode = 'tui') {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const notes: string[] = []; const opened: any[] = []; const set: string[] = [];
  const pi: any = {
    on: (name: string, handler: any) => handlers.set(name, handler),
    setModel: async (model: any) => { set.push(model.id); await handlers.get('model_select')!({ model, previousModel: undefined, source: 'set' }, ctx); return true; },
  };
  const ctx: any = {
    hasUI: true, mode,
    getContextUsage: () => ({ tokens }),
    ui: { notify: (text: string) => notes.push(text), custom: async (factory: any) => { opened.push(factory); return null; } },
    compact: (options: any) => options.onComplete({}),
  };
  installCacheGuard(pi);
  const select = async (model: any, previousModel: any, source = 'set') => {
    await handlers.get('model_select')!({ model, previousModel, source }, ctx);
    await new Promise(resolve => setTimeout(resolve, 5));
  };
  return { select, notes, opened, set };
}

test('a switch with a large context opens the docked choice; small ones and restores do not', async () => {
  const big = harness(117_000);
  await big.select(mimo, sol);
  assert.equal(big.opened.length, 1);
  const small = harness(20_000);
  await small.select(mimo, sol);
  assert.equal(small.opened.length, 0);
  const restore = harness(117_000);
  await restore.select(mimo, sol, 'restore');
  assert.equal(restore.opened.length, 0);
});

test('without the terminal UI the cost is still said', async () => {
  const rpc = harness(117_000, 'rpc');
  await rpc.select(mimo, sol);
  assert.equal(rpc.opened.length, 0);
  assert.match(rpc.notes[0]!, /re-sends 117k/);
});
