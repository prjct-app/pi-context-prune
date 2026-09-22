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
// bloquea nada: dice cuanta memoria hay en contexto y cuanta se ha retirado.
//
// @ts-nocheck
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setMode } from "@prjct.app/pi-tui-kit";

const CFG = {
	enabled: process.env.PI_PRUNE !== "0",
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
	for (let i = 0; i < input.length; i++) {
		const item = input[i];
		if (item?.role !== "user" && item?.type !== "message") continue;
		const text = JSON.stringify(item?.content ?? "");
		const snapshot = text.includes("<memory_snapshot");
		if (!snapshot && !text.includes("<retained_memory")) continue;
		found.push({ index: i, key: keyOf(item), snapshot, tokens: Math.round(text.length / 4) });
	}
	return found;
};

export default function (pi: ExtensionAPI) {
	if (!CFG.enabled) return;

	// Ordinal del ultimo reasoning podado. La historia es append-only, asi que
	// los N primeros items de reasoning son estables y el ordinal no se desplaza.
	let frontier = 0;
	// Items de memoria ya retirados, por contenido.
	let droppedMemory = new Set<string>();
	// Limpieza pedida desde /memory: se aplica en el siguiente request.
	let memoryNow = false;
	let lastDropped = 0;
	let lastTokens = 0;
	let advances = 0;
	let memoryAdvances = 0;
	// Tokens de memoria retirados en esta sesion, por contenido (no se cuentan dos veces).
	let retired = new Map<string, number>();
	let inContext = 0;

	/** La linea de estado: memoria viva y retirada. Nada mientras no hay memoria. */
	const showStatus = (ctx: any): void => {
		if (!CFG.memory) return;
		const pruned = [...retired.values()].reduce((sum, tokens) => sum + tokens, 0);
		const parts = [`memory ${short(inContext)}`];
		if (pruned) parts.push(`-${short(pruned)} pruned`);
		if (memoryNow) parts.push("prune queued");
		setMode(ctx, "memory", inContext || pruned || memoryNow ? parts.join(" · ") : undefined);
	};

	pi.on("session_start", (_event: any, ctx: any) => {
		frontier = 0;
		droppedMemory = new Set();
		memoryNow = false;
		lastDropped = 0;
		lastTokens = 0;
		advances = 0;
		memoryAdvances = 0;
		retired = new Map();
		inContext = 0;
		showStatus(ctx);
	});

	/** Decide que memoria se retira en este request. Solo crece en un lote o a mano. */
	const pruneMemory = (input: any[]): void => {
		const items = memoryItems(input).filter((item) => !droppedMemory.has(item.key));
		const lastSnapshot = items.map((item) => item.snapshot).lastIndexOf(true);
		if (memoryNow) {
			memoryNow = false;
			// Todo menos el ultimo snapshot (las reglas vigentes) y el ultimo recall.
			const keep = new Set([items[lastSnapshot]?.key, items.at(-1)?.key]);
			const gone = items.filter((item) => !keep.has(item.key));
			if (gone.length) {
				for (const item of gone) droppedMemory.add(item.key);
				memoryAdvances++;
			}
			return;
		}
		// Solo, lo que el ultimo snapshot declara superado, cuando pesa lo bastante.
		const superseded = lastSnapshot > 0 ? items.slice(0, lastSnapshot) : [];
		const pending = superseded.reduce((sum, item) => sum + item.tokens, 0);
		if (pending >= CFG.memoryAdvance) {
			for (const item of superseded) droppedMemory.add(item.key);
			memoryAdvances++;
		}
	};

	pi.on("before_provider_request", (event: any, ctx: any) => {
		try {
			const payload = event.payload;
			const input = payload?.input;
			if (!Array.isArray(input)) return undefined; // solo payloads estilo Responses API

			const drop = new Set<number>();

			if (CFG.memory) {
				pruneMemory(input);
				inContext = 0;
				for (const item of memoryItems(input)) {
					if (droppedMemory.has(item.key)) {
						drop.add(item.index);
						retired.set(item.key, item.tokens);
					} else inContext += item.tokens;
				}
				showStatus(ctx);
			}

			if (CFG.reasoning) {
				const reasoning: number[] = [];
				for (let i = 0; i < input.length; i++) if (input[i]?.type === "reasoning") reasoning.push(i);
				// La ventana protegida son los `keep` mas recientes: esos nunca se tocan.
				const boundary = reasoning.length - CFG.keep;
				if (boundary <= 0) {
					// La historia encogio (compactacion, /tree, sesion reemplazada): una
					// frontera vieja podaria la ventana protegida. Retrocede con ella.
					frontier = 0;
				} else {
					// Nunca por delante de la frontera valida actual, por el mismo motivo.
					if (frontier > boundary) frontier = boundary;
					if (boundary > frontier) {
						let pending = 0;
						for (let k = frontier; k < boundary; k++) pending += tokensOf(input[reasoning[k]]);
						if (pending >= CFG.advance) {
							frontier = boundary;
							advances++;
						}
					}
					for (const index of reasoning.slice(0, frontier)) drop.add(index);
				}
			}

			if (!drop.size) return undefined;
			let freed = 0;
			const pruned = input.filter((item: unknown, i: number) => {
				if (!drop.has(i)) return true;
				freed += tokensOf(item);
				return false;
			});

			lastDropped = drop.size;
			lastTokens = freed;
			if (CFG.debug && ctx?.hasUI) {
				ctx.ui.setStatus("prune", `prune: -${freed} tok (${drop.size} items)`);
			}
			return { ...payload, input: pruned };
		} catch {
			return undefined; // ante cualquier duda, payload intacto
		}
	});

	// /memory (pi-memory) es donde una persona llega a esto: el panel (tecla p) y
	// `/memory prune`. Cada extension tiene su propio grafo de modulos, asi que se
	// encuentran en un simbolo del proceso.
	const space = globalThis as Record<symbol, any>;
	space[Symbol.for("prjct.context-prune")] = {
		memory: {
			queue: (ctx: any) => {
				if (!CFG.memory) return;
				memoryNow = true;
				showStatus(ctx);
			},
			status: () => ({
				inContext,
				pruned: [...retired.values()].reduce((sum, tokens) => sum + tokens, 0),
				queued: memoryNow,
			}),
		},
	};
}
