// The debug status line runs only with PI_PRUNE=1 and PI_PRUNE_DEBUG=1, read when the module loads.
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.PI_PRUNE = '1';
process.env.PI_PRUNE_DEBUG = '1';
const { default: install } = await import('../index.ts');

test('the debug status line renders without throwing', () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = { on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, fn); }, events: { on() {}, emit() {} } };
  install(pi as never);
  const ctx = { hasUI: true, mode: 'tui', ui: { setStatus() {}, setWidget() {}, theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t } } };
  assert.doesNotThrow(() => handlers.get('session_start')?.({}, ctx));
  const snapshot = (revision: string) => ({ role: 'user', content: `<memory_snapshot revision="${revision}" trust="untrusted">\nThis snapshot ${'x'.repeat(20000)}` });
  const result = handlers.get('before_provider_request')?.({ payload: { input: [snapshot('1'), snapshot('2')] } }, ctx) as { input?: unknown[] } | undefined;
  assert.equal(result?.input?.length, 1, 'the superseded snapshot is pruned while the debug line is shown');
});
