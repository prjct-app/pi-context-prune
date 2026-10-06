// Cache economics for subscriptions: when to warm the provider's prompt cache,
// and what a model switch costs before it is paid.
//
// Subscriptions (Codex, Xiaomi token plan) spend quota, and what matters is the
// ratio between a cache miss and a cache hit, not the dollar amount. Both hooks
// need cost and promptCache on the models (~/.pi/agent/models.json,
// modelOverrides); without prices Pi goes blind to the cache.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Below this, a switch re-sends too little to be worth an interruption. */
export const SWITCH_WARN_TOKENS = Number(process.env.PI_SWITCH_WARN_TOKENS) || 50_000;

type Cost = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
type Model = { provider: string; id: string; name?: string; cost?: Cost };

const perM = (model: Model | undefined, key: keyof Cost): number => model?.cost?.[key] ?? 0;
/** What one uncached prompt token costs: a cache write where the provider bills one. */
const missPrice = (model: Model | undefined): number => perM(model, "cacheWrite") > 0 ? perM(model, "cacheWrite") : perM(model, "input");
const same = (a: Model | undefined, b: Model | undefined): boolean => !!a && !!b && a.provider === b.provider && a.id === b.id;
const label = (model: Model): string => `${model.provider}/${model.id}`;
const k = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

/**
 * Warm when the avoided miss, weighted by the chance another request arrives,
 * is worth at least twice the refresh. Pi's own rule needs $0.05 of savings,
 * sized for API prices: at Xiaomi's prices it never warmed, although a miss
 * costs 120 hits there. Measured 2026-09-28: Xiaomi warms idle and streaming;
 * Codex (~12:1) warms only while a run is active (idle: 0.15 × 11.5 < 2).
 */
export function warmingAction(event: { missCost: number; warmCost: number; continuationProbability: number }): "warm" | "stop" | undefined {
  const { missCost, warmCost, continuationProbability } = event;
  if (!(missCost > 0) || !(warmCost > 0)) return undefined;
  return continuationProbability * missCost >= 2 * warmCost ? "warm" : "stop";
}

/** What switching from `from` to `to` with `tokens` of context costs, in words. */
export function switchCost(from: Model, to: Model, tokens: number): { summary: string; hits: number | undefined } {
  const miss = missPrice(to), hit = perM(to, "cacheRead");
  const hits = miss > 0 && hit > 0 ? Math.round(miss / hit) : undefined;
  const dollars = miss > 0 ? ` (~$${(tokens * miss / 1e6).toFixed(2)})` : "";
  const ratio = hits ? `, like ${hits} requests with cache` : "";
  return { summary: `${label(to)} has no cache for this session: the next request re-sends ${k(tokens)} tokens${dollars}${ratio}.`, hits };
}

export function installCacheGuard(pi: ExtensionAPI): void {
  pi.on("cache_warming_decision", (event: any) => {
    const action = warmingAction(event);
    return action ? { action } : undefined;
  });

  // A model switch preserves the complete context. Cost alone must never
  // recommend replacing the conversation with a summary.
  pi.on("model_select", (event: any, ctx: ExtensionContext) => {
    if (event.source === "restore") return;
    const from = event.previousModel as Model | undefined, to = event.model as Model | undefined;
    if (!from || !to || same(from, to)) return;
    const tokens = ctx.getContextUsage()?.tokens ?? 0;
    if (tokens >= SWITCH_WARN_TOKENS && ctx.hasUI) ctx.ui.notify(switchCost(from, to, tokens).summary, "info");
  });
}
