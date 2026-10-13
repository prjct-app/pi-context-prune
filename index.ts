// pi-context-prune
// Poda del payload antes de cada request, sin perdida semantica. Dos podas
// independientes:
//
// 1. MEMORIA (activa por defecto). pi-memory mete en cada turno un mensaje con
//    un <memory_snapshot> y/o un recall <retained_memory>. El snapshot dice que
//    "supersedes ALL earlier automatic memory snapshots and recalls", pero los
//    anteriores se quedan en el contexto para siempre. Medido: 5 snapshots,
//    4.392 tokens de los cuales solo el ultimo esta vigente. Aqui se tiran:
//    - por lotes, solos: cuando lo superado (todo lo anterior al ultimo
//      snapshot) llega a `memoryAdvance` tokens;
//    - a mano desde /memory (tecla p del panel, o `/memory prune`): todo menos el ultimo snapshot y el ultimo
//      recall, en el siguiente request. Una sesion que nunca se cierra no tiene
//      que esperar a nada.
//    Antes esta poda colgaba de la de reasoning y, al apagar esa, se apago tambien.
//
// 2. REASONING cifrado de la Responses API (apagada por defecto, ver CFG).
//
// FRONTERA POR LOTES: podar en cada request cambiaria el prefijo serializado en
// cada llamada y destruiria la cache del provider en todas. Lo podado solo
// cambia cuando se avanza un lote (o a mano); entre avances el prefijo es
// identico byte a byte. Los items de memoria se recuerdan por contenido, asi que
// la decision se mantiene aunque la historia crezca o se compacte.
//
// Solo se ELIMINAN items de reasoning; nunca se toca el `function_call` que les
// sigue. Esa es la direccion segura: la Responses API se queja de un reasoning
// sin su item siguiente, no de un function_call sin su reasoning previo.
//
// Env: PI_PRUNE=0 desactiva todo · PI_PRUNE_MEMORY=0 desactiva la de memoria
//      PI_PRUNE_MEMORY_ADVANCE=3000 tokens superados para podar memoria sola
//      PI_PRUNE_REASONING=1 activa la de reasoning · PI_PRUNE_KEEP=10 items
//      PI_PRUNE_ADVANCE=20000 tokens de reasoning podable para avanzar
//      PI_PRUNE_DEBUG=1 muestra lo podado en el status
//
// ESTADO: una linea en la barra de modos de pi-tui-kit, arriba del editor. No
// bloquea nada. La linea "memory" es de pi-memory; esta solo aparece con
// PI_PRUNE_DEBUG=1 (tokens de snapshots en contexto y los retirados).
//
// @ts-nocheck
import { installCacheGuard } from "./cache-guard.ts";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setMode } from "@prjct.app/pi-tui-kit";

const CFG = {
	// Pi owns compaction. Payload pruning requires an explicit opt-in.
	enabled: process.env.PI_PRUNE === "1",
	memory: process.env.PI_PRUNE_MEMORY !== "0",
	memoryAdvance: Math.max(1, Number(process.env.PI_PRUNE_MEMORY_ADVANCE || 3_000)),
	// MEDIDO 2026-09-20: el encrypted_content del reasoning NO se factura como
	// contexto. En 7 puntos de una sesion real, "todo menos reasoning" sigue al
	// contexto facturado con ratio 0,87-0,98x estable mientras el reasoning crecia
	// de 19.726 a 72.327 tokens estimados sin mover la cifra facturada. Podarlo no
	// ahorra tokens: solo bytes de subida, y arriesga la continuidad del
	// razonamiento entre turnos. Por eso va APAGADO salvo peticion explicita.
	reasoning: process.env.PI_PRUNE_REASONING === "1",
	keep: Math.max(1, Number(process.env.PI_PRUNE_KEEP || 10)),
	advance: Math.max(1, Number(process.env.PI_PRUNE_ADVANCE || 20_000)),
	debug: process.env.PI_PRUNE_DEBUG === "1",
};

const tokensOf = (value: unknown): number => {
	try {
		return Math.round((JSON.stringify(value)?.length ?? 0) / 4);
	} catch {
		return 0;
	}
};

const short = (tokens: number): string => (tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`);

const keyOf = (item: unknown): string => createHash("sha1").update(JSON.stringify(item ?? null)).digest("hex");

type MemoryItem = { index: number; key: string; snapshot: boolean; tokens: number };

/** Mensajes de pi-memory en el payload, en orden. */
export const memoryItems = (input: any[]): MemoryItem[] => {
	const found: MemoryItem[] = [];
	for (const [i, item] of input.entries()) {
		if (item?.role !== "user") continue;
		const content = item?.content;
		const text = typeof content === "string" ? content : Array.isArray(content)
			? content.map(block => block?.type === "input_text" || block?.type === "text" ? block.text ?? "" : "").join("\n") : "";
		const snapshot = /^<memory_snapshot revision="[^"\n]+" trust="untrusted">\nThis snapshot /u.test(text);
		if (!snapshot && !/^<retained_memory trust="untrusted">\n/u.test(text)) continue;
		found.push({ index: i, key: keyOf(item), snapshot, tokens: Math.round(text.length / 4) });
	}
	return found;
};

/**
 * Estado de la poda como valor inmutable. Cada request produce un estado nuevo a partir del anterior;
 * nada se modifica en sitio. La unica celda que cambia es la que guarda el estado vigente.
 */
export type PruneState = Readonly<{
	/** Ordinal del ultimo reasoning podado. La historia es append-only: los N primeros son estables. */
	frontier: number;
	/** Items de memoria ya retirados, por contenido. */
	dropped: ReadonlySet<string>;
	/** Limpieza pedida desde /memory: se aplica en el siguiente request. */
	memoryNow: boolean;
	/** Tokens de memoria retirados en esta sesion, por contenido (no se cuentan dos veces). */
	retired: ReadonlyMap<string, number>;
	inContext: number;
	advances: number;
	memoryAdvances: number;
}>;

export type PruneConfig = Readonly<{ memory: boolean; memoryAdvance: number; reasoning: boolean; keep: number; advance: number }>;

export const initialState = (): PruneState => ({
	frontier: 0, dropped: new Set(), memoryNow: false, retired: new Map(), inContext: 0, advances: 0, memoryAdvances: 0,
});

export const queueMemoryPrune = (state: PruneState): PruneState => ({ ...state, memoryNow: true });

export const retiredTokens = (state: PruneState): number => [...state.retired.values()].reduce((sum, tokens) => sum + tokens, 0);

/** Que memoria se retira en este request. Solo crece en un lote o a mano. */
function memoryStep(state: PruneState, input: any[], cfg: PruneConfig): PruneState {
	const items = memoryItems(input).filter((item) => !state.dropped.has(item.key));
	const lastSnapshot = items.map((item) => item.snapshot).lastIndexOf(true);
	if (state.memoryNow) {
		// Todo menos el ultimo snapshot (las reglas vigentes) y el ultimo recall.
		const keep = new Set([items[lastSnapshot]?.key, items.at(-1)?.key]);
		const gone = items.filter((item) => !keep.has(item.key));
		return gone.length
			? { ...state, memoryNow: false, dropped: new Set([...state.dropped, ...gone.map((item) => item.key)]), memoryAdvances: state.memoryAdvances + 1 }
			: { ...state, memoryNow: false };
	}
	// Solo, lo que el ultimo snapshot declara superado, cuando pesa lo bastante.
	const superseded = lastSnapshot > 0 ? items.slice(0, lastSnapshot).filter((item) => item.snapshot) : [];
	const pending = superseded.reduce((sum, item) => sum + item.tokens, 0);
	return pending >= cfg.memoryAdvance
		? { ...state, dropped: new Set([...state.dropped, ...superseded.map((item) => item.key)]), memoryAdvances: state.memoryAdvances + 1 }
		: state;
}

/** La frontera del reasoning: nunca toca los `keep` mas recientes y solo avanza por lotes. */
function reasoningFrontier(state: PruneState, reasoning: readonly number[], input: any[], cfg: PruneConfig): PruneState {
	const boundary = reasoning.length - cfg.keep;
	// La historia encogio (compactacion, /tree, sesion reemplazada): una frontera vieja podaria la ventana protegida.
	if (boundary <= 0) return state.frontier === 0 ? state : { ...state, frontier: 0 };
	// Nunca por delante de la frontera valida actual, por el mismo motivo.
	const frontier = Math.min(state.frontier, boundary);
	if (boundary <= frontier) return frontier === state.frontier ? state : { ...state, frontier };
	const pending = reasoning.slice(frontier, boundary).reduce((sum, index) => sum + tokensOf(input[index]), 0);
	return pending >= cfg.advance ? { ...state, frontier: boundary, advances: state.advances + 1 } : { ...state, frontier };
}

export type RequestPlan = Readonly<{ state: PruneState; drop: ReadonlySet<number> }>;

/** Un request como transicion pura: el estado siguiente y los indices del payload que se retiran. */
export function planRequest(state: PruneState, input: any[], cfg: PruneConfig): RequestPlan {
	const afterMemory = cfg.memory ? memoryStep(state, input, cfg) : state;
	const memory = cfg.memory ? memoryItems(input) : [];
	const memoryDrops = memory.filter((item) => afterMemory.dropped.has(item.key));
	const withMemory: PruneState = cfg.memory
		? {
			...afterMemory,
			inContext: memory.filter((item) => !afterMemory.dropped.has(item.key)).reduce((sum, item) => sum + item.tokens, 0),
			retired: new Map([...afterMemory.retired, ...memoryDrops.map((item) => [item.key, item.tokens] as const)]),
		}
		: afterMemory;
	if (!cfg.reasoning) return { state: withMemory, drop: new Set(memoryDrops.map((item) => item.index)) };
	const reasoning = input.flatMap((item, i) => item?.type === "reasoning" ? [i] : []);
	const next = reasoningFrontier(withMemory, reasoning, input, cfg);
	return { state: next, drop: new Set([...memoryDrops.map((item) => item.index), ...reasoning.slice(0, next.frontier)]) };
}

export default function (pi: ExtensionAPI) {
	// Calentamiento de cache y aviso al cambiar de modelo: ver cache-guard.ts.
	// Van antes de PI_PRUNE=0, que apaga solo las podas.
	installCacheGuard(pi);
	if (!CFG.enabled) return;

	// La unica celda que cambia: guarda el estado vigente, que siempre se reemplaza por uno nuevo.
	const session = { state: initialState() };

	/**
	 * La linea "memory" arriba del editor es de pi-memory. Aqui solo se ven los tokens de snapshots
	 * y lo podado, con PI_PRUNE_DEBUG=1.
	 */
	const showStatus = (ctx: any): void => {
		if (!CFG.memory || !CFG.debug) return;
		const { inContext, memoryNow } = session.state;
		const pruned = retiredTokens(session.state);
		const parts = [`memory snapshots ${short(inContext)}`];
		if (pruned) parts.push(`-${short(pruned)} pruned`);
		if (memoryNow) parts.push("prune queued");
		setMode(ctx, "prune", inContext || pruned || memoryNow ? parts.join(" · ") : undefined);
	};

	pi.on("session_start", (_event: any, ctx: any) => {
		session.state = initialState();
		showStatus(ctx);
	});

	pi.on("before_provider_request", (event: any, ctx: any) => {
		try {
			const payload = event.payload;
			const input = payload?.input;
			if (!Array.isArray(input)) return undefined; // solo payloads estilo Responses API
			const plan = planRequest(session.state, input, CFG);
			session.state = plan.state;
			showStatus(ctx);
			if (!plan.drop.size) return undefined;
			// One pass over the payload: this runs on every provider request.
			const kept: unknown[] = [];
			const freed = input.reduce((sum: number, item: unknown, i: number) => {
				if (plan.drop.has(i)) return sum + tokensOf(item);
				kept.push(item);
				return sum;
			}, 0);
			if (CFG.debug && ctx?.hasUI) ctx.ui.setStatus("prune", `prune: -${freed} tok (${plan.drop.size} items)`);
			return { ...payload, input: kept };
		} catch {
			return undefined; // ante cualquier duda, payload intacto
		}
	});

	// /memory (pi-memory) es donde una persona llega a esto: el panel (tecla p) y `/memory prune`.
	// Cada extension tiene su propio grafo de modulos, asi que se encuentran en un simbolo del proceso.
	const space = globalThis as Record<symbol, any>;
	space[Symbol.for("prjct.context-prune")] = {
		memory: {
			queue: (ctx: any) => {
				if (!CFG.memory) return;
				session.state = queueMemoryPrune(session.state);
				showStatus(ctx);
			},
			status: () => ({
				inContext: session.state.inContext,
				pruned: retiredTokens(session.state),
				queued: session.state.memoryNow,
			}),
		},
	};
}
