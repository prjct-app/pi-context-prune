// Cache economics for subscriptions: when to warm the provider's prompt cache,
// and what a model switch costs before it is paid.
//
// Subscriptions (Codex, Xiaomi token plan) spend quota, and what matters is the
// ratio between a cache miss and a cache hit, not the dollar amount. Both hooks
// need cost and promptCache on the models (~/.pi/agent/models.json,
// modelOverrides); without prices Pi goes blind to the cache.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SYMBOL, openPanel, type PanelItem } from "@prjct.app/pi-tui-kit";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** Tokens compaction keeps verbatim; the rest becomes a summary. */
function keepRecentTokens(): number {
  try {
    const settings = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json"), "utf8"));
    return Number(settings?.compaction?.keepRecentTokens) || 20_000;
  } catch { return 20_000; }
}

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

  // Our own setModel calls fire model_select too; they are not a person's switch.
  const own = { active: false };
  const setModel = async (model: Model): Promise<boolean> => {
    own.active = true;
    try { return await pi.setModel(model as never); } finally { own.active = false; }
  };

  const ask = async (ctx: ExtensionContext, from: Model, to: Model, tokens: number): Promise<void> => {
    const { summary } = switchCost(from, to, tokens);
    const keep = keepRecentTokens();
    const options: (PanelItem & { run: () => Promise<void> | void; note: string })[] = [
      {
        id: "compact", label: `Compact with ${from.id} first, then switch`, symbol: SYMBOL.ok, tone: "success", meta: "recommended",
        note: `The summary is written by ${from.id} while its cache is warm; ${to.id} then reads about ${k(Math.min(tokens, keep + 8_000))} instead of ${k(tokens)}.`,
        run: async () => {
          if (!(await setModel(from))) { ctx.ui.notify(`Could not return to ${label(from)}; nothing was compacted.`, "error"); return; }
          ctx.ui.notify(`Compacting with ${from.id}; ${to.id} takes over when it finishes.`, "info");
          ctx.compact({
            onComplete: () => { void setModel(to).then(ok => ctx.ui.notify(ok ? `Compacted. Now on ${label(to)}.` : `Compacted, but could not switch to ${label(to)}.`, ok ? "info" : "error")); },
            onError: (error: Error) => { void setModel(to); ctx.ui.notify(`Compaction failed (${error.message}); switched to ${label(to)} anyway.`, "warning"); },
          });
        },
      },
      {
        id: "back", label: `Stay on ${from.id}`, symbol: SYMBOL.idle, tone: "muted", meta: "no cost",
        note: `Keeps the warm cache of ${from.id}. Switch later, right after a compaction or in a new session.`,
        run: async () => { if (!(await setModel(from))) ctx.ui.notify(`Could not return to ${label(from)}.`, "error"); },
      },
      {
        id: "switch", label: `Switch to ${to.id} anyway`, symbol: SYMBOL.attention, tone: "warning", meta: `re-sends ${k(tokens)}`,
        note: summary,
        run: () => {},
      },
    ];
    await openPanel(ctx as unknown as Parameters<typeof openPanel>[0], {
      title: "Model switch",
      summary: () => `${k(tokens)} of context · ${from.id} → ${to.id}`,
      items: () => options,
      detail: item => {
        const option = options.find(o => o.id === item.id)!;
        return { title: option.label, fields: [{ label: "cost", value: summary, tone: "warning" }], sections: [{ title: "What happens", lines: [option.note] }] };
      },
      activate: {
        label: "Choose",
        run: async (item, panel) => {
          panel.close();
          await options.find(o => o.id === item?.id)?.run();
        },
      },
      initial: "compact",
    });
  };

  pi.on("model_select", (event: any, ctx: ExtensionContext) => {
    if (own.active || event.source === "restore") return;
    const from = event.previousModel as Model | undefined, to = event.model as Model | undefined;
    if (!from || !to || same(from, to)) return;
    const tokens = ctx.getContextUsage()?.tokens ?? 0;
    if (tokens < SWITCH_WARN_TOKENS) return;
    if (!ctx.hasUI || ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify(switchCost(from, to, tokens).summary, "warning");
      return;
    }
    // Opened after the switch settles: a docked panel inside the event would hold it up.
    setTimeout(() => { void ask(ctx, from, to, tokens).catch(error => ctx.ui.notify(`Model switch guard: ${error instanceof Error ? error.message : String(error)}`, "error")); }, 0);
  });
}
