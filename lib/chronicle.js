/**
 * Bounded, model-free session chronicle.
 *
 * The shape is ported from ComeCode's `packages/core/src/compact/chronicle.ts`:
 * every turn that a human actually opened collapses to one short, sanitized
 * line, and the whole record is held to a fixed capacity by coarsening old
 * entries in layers instead of letting it grow with the session.
 *
 * The DSH fold differs from ComeCode's in three deliberate ways:
 * - It is a pure function over the session's own durable event log, so no new
 *   storage, schema, or migration is introduced: a cold reader recomputes the
 *   same chronicle from the same events.
 * - The turn status vocabulary follows DSH's `TurnEndReason` union
 *   (`completed` / `aborted` / `blocked` / `error` / `max-tokens` /
 *   `interrupted`) instead of ComeCode's four labels.
 * - Paths and URLs are kept rather than redacted. They are the actionable
 *   product of a coding session and the entry budget already bounds them;
 *   secrets, private keys, and code blocks are still removed.
 *
 * @module dsh-session-recall/chronicle
 */

/** Hard ceiling for the serialized chronicle, in characters. */
export const CHRONICLE_MAX_CHARS = 6_000;
/** Hard ceiling for the number of entries, applied before coarsening. */
export const CHRONICLE_MAX_ENTRIES = 22;
/** Entries allowed in each recency layer before that layer coarsens. */
const LAYER_CAPACITY = { recent: 12, earlier: 6, oldest: 4 };
/** How many old entries collapse into one when a layer overflows. */
const MERGE_COUNT = 4;
/** Per-layer summary budget, in characters. */
const SUMMARY_LIMITS = { recent: 160, earlier: 100, oldest: 60 };
/** Longest input text this module will look at, in characters. */
const INPUT_LIMIT = 16_384;
/** Never shrink a merged summary below this, in characters. */
const MIN_SUMMARY_CHARS = 16;
const GOAL_LIMIT = 72;
const RESPONSE_LIMIT = 64;

/** Turn-end labels, keyed by DSH's `TurnEndReason.kind`. */
const STATUS_LABELS = {
	completed: "回合完成（目标未核验）",
	aborted: "回合取消（未完成）",
	blocked: "回合被阻止（未执行）",
	error: "回合失败（未完成）",
	"max-tokens": "回合被输出上限截断（可能未完成）",
	interrupted: "回合被中断（崩溃后闭合）",
	running: "回合进行中"
};

/**
 * Redact and collapse one piece of chronicle text.
 * @param text - raw text taken from the session log.
 * @param maxChars - character budget for the result.
 * @returns single-line, redacted, truncated text.
 */
export function sanitizeChronicleText(text, maxChars = 160) {
	const limit = Math.max(0, Math.min(INPUT_LIMIT, Math.floor(maxChars) || 0));
	return String(text ?? "")
		.slice(0, INPUT_LIMIT)
		.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*(?:-----END [^-]*PRIVATE KEY-----|$)/giu, "[已脱敏]")
		.replace(/```[\s\S]*?(?:```|$)/gu, "[代码省略]")
		.replace(/\b(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/giu, "[已脱敏]")
		.replace(
			/(?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|密码|密钥|令牌)["']?\s*[:=：]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;，；}\r\n]+)/giu,
			"[已脱敏]"
		)
		.replace(/\b(?:bearer\s+\S+|(?:sk-|gh[pousr]_|github_pat_|AKIA)[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/giu, "[已脱敏]")
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[邮箱省略]")
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, limit);
}

/** Concatenate the text blocks of one message content value. */
export function visibleText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

/** Cut text to a character budget without collapsing its line structure. */
function truncateText(text, limit) {
	if (limit <= 0) return "";
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** One entry's rendered line, before layer budgets are applied. */
function summarizeEntry(entry) {
	const label = STATUS_LABELS[entry.status] ?? `回合结束（${entry.status}）`;
	const goal = entry.goal.length > 0 ? entry.goal : "未记录";
	const response = entry.response.length > 0 ? `；回复：${entry.response}` : "";
	return sanitizeChronicleText(`${label}；目标：${goal}${response}`, SUMMARY_LIMITS.recent);
}

/** Build one entry from a closed or still-open turn. */
function makeEntry(turn, status, endSeq, endedAt) {
	const entry = {
		turn: turn.turn,
		startSeq: turn.startSeq,
		endSeq,
		status,
		startedAt: turn.startedAt,
		endedAt: endedAt ?? turn.startedAt,
		goal: sanitizeChronicleText(turn.goal, GOAL_LIMIT),
		// A cancelled or failed turn's partial reply may claim success, so only a
		// completed turn contributes its response — the same rule ComeCode uses.
		response: status === "completed" ? sanitizeChronicleText(turn.response, RESPONSE_LIMIT) : "",
		recency: "recent",
		count: 1
	};
	entry.summary = summarizeEntry(entry);
	return entry;
}

/**
 * Fold session events into one entry per human-opened turn.
 * @param events - the session's events in log order.
 * @returns entries in chronological order.
 */
function foldTurns(events) {
	const entries = [];
	let open = null;

	for (const event of events) {
		if (event === null || typeof event !== "object") continue;
		if (event.type === "turn/start") {
			open = {
				turn: Number.isSafeInteger(event.data?.turn) ? event.data.turn : entries.length + 1,
				startSeq: event.seq,
				startedAt: event.time,
				goal: "",
				response: "",
				hasHuman: false
			};
			continue;
		}
		if (open === null) continue;
		if (event.type === "user/message") {
			// Only an explicit human source opens a turn's goal; injected context
			// (workspace instructions, runtime snapshots, skill catalogs) does not.
			if (event.data?.source?.kind !== "user" || open.hasHuman) continue;
			const text = visibleText(event.data?.content);
			if (text.trim().length === 0) continue;
			open.goal = text;
			open.hasHuman = true;
			continue;
		}
		if (event.type === "assistant/message") {
			const text = visibleText(event.data?.message?.content);
			if (text.trim().length > 0) open.response = text;
			continue;
		}
		if (event.type === "turn/end") {
			const status = String(event.data?.reason?.kind ?? "completed");
			if (open.hasHuman) entries.push(makeEntry(open, status, event.seq, event.time));
			open = null;
		}
	}
	// A turn still in flight is worth reporting: the model may ask mid-turn.
	if (open !== null && open.hasHuman) entries.push(makeEntry(open, "running", open.startSeq, open.startedAt));
	return entries;
}

/** Collapse a group of old entries into one coarser entry. */
function mergeEntries(group, target) {
	const first = group[0];
	const last = group[group.length - 1];
	const limit = SUMMARY_LIMITS[target];
	const representatives = [
		...new Set(group.map((entry) => entry.summary.replace(/^[^；]*；目标：/u, "").replace(/；回复：/u, "：")))
	];
	const perItem = Math.max(12, Math.floor(limit / Math.min(3, representatives.length)) - 2);
	const text =
		representatives.length <= 3
			? representatives
			: [representatives[0], representatives[Math.floor(representatives.length / 2)], representatives[representatives.length - 1]];
	return {
		turn: last.turn,
		startSeq: first.startSeq,
		endSeq: last.endSeq,
		status: last.status,
		startedAt: first.startedAt,
		endedAt: last.endedAt,
		goal: "",
		response: "",
		recency: target,
		count: group.reduce((total, entry) => total + (entry.count ?? 1), 0),
		summary: sanitizeChronicleText(text.map((item) => item.slice(0, perItem)).join("；"), limit)
	};
}

/**
 * Hold entries to the chronicle's capacity: coarsen overflowing layers
 * (recent → earlier → oldest), then shrink summaries and finally drop the
 * oldest entries until the serialized record fits.
 * @param entries - chronological entries.
 * @param maxChars - serialized size budget.
 * @returns the bounded entries.
 */
function boundEntries(entries, maxChars) {
	const budget = Math.max(32, Math.min(CHRONICLE_MAX_CHARS, Math.floor(maxChars) || CHRONICLE_MAX_CHARS));
	const list = entries.slice(-CHRONICLE_MAX_ENTRIES);
	const size = () => JSON.stringify(list).length;
	const layerCount = (layer) => list.filter((entry) => entry.recency === layer).length;
	const reduceLayer = (layer, target) => {
		while (layerCount(layer) > LAYER_CAPACITY[layer]) {
			const group = list.filter((entry) => entry.recency === layer).slice(0, MERGE_COUNT);
			if (group.length === 0) return;
			const at = list.indexOf(group[0]);
			for (const entry of group) list.splice(list.indexOf(entry), 1);
			// The oldest layer has nowhere coarser to go, so it just drops its head.
			list.splice(at, 0, ...(layer === target ? [] : [mergeEntries(group, target)]));
		}
	};

	reduceLayer("recent", "earlier");
	reduceLayer("earlier", "oldest");
	reduceLayer("oldest", "oldest");

	for (const entry of list) entry.summary = sanitizeChronicleText(entry.summary, SUMMARY_LIMITS[entry.recency]);
	for (const layer of ["oldest", "earlier", "recent"]) {
		for (const entry of list.filter((item) => item.recency === layer)) {
			const over = size() - budget;
			if (over <= 0) break;
			entry.summary = entry.summary.slice(0, Math.max(MIN_SUMMARY_CHARS, entry.summary.length - over));
		}
	}
	while (list.length > 0 && size() > budget) list.shift();
	return list;
}

/**
 * Build the bounded chronicle for one session's events.
 * @param events - the session's events in log order.
 * @param options - optional `maxChars` serialized-size budget.
 * @returns `{ version, entries }`.
 */
export function buildChronicle(events, options = {}) {
	const entries = boundEntries(foldTurns(Array.isArray(events) ? events : []), options.maxChars ?? CHRONICLE_MAX_CHARS);
	return { version: 1, entries };
}

/** Local `HH:MM` label for one entry's end time. */
function formatTime(time) {
	if (!Number.isFinite(time)) return "";
	const date = new Date(time);
	const pad = (value) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Render a chronicle as bounded text for a model or a human.
 * @param chronicle - the value returned by {@link buildChronicle}.
 * @param options - optional `maxChars` output budget and `lastTurns` window.
 * @returns the rendered text.
 */
export function renderChronicle(chronicle, options = {}) {
	const all = Array.isArray(chronicle?.entries) ? chronicle.entries : [];
	const lastTurns = Number.isSafeInteger(options.lastTurns) && options.lastTurns > 0 ? options.lastTurns : undefined;
	const entries = lastTurns === undefined ? all : all.slice(-lastTurns);
	const budget = Math.max(64, Math.min(CHRONICLE_MAX_CHARS, Math.floor(options.maxChars) || CHRONICLE_MAX_CHARS));
	const coarsened = entries.filter((entry) => (entry.count ?? 1) > 1).length;

	const lines = [`会话史书（本地生成，未调用模型）：${entries.length}/${all.length} 条回合记录`];
	if (entries.length === 0) {
		lines.push("（本会话还没有记录到带真实用户输入的回合。）");
	}
	for (const entry of entries) {
		const merged = (entry.count ?? 1) > 1 ? ` ×${entry.count} 回合` : "";
		const when = formatTime(entry.endedAt);
		lines.push(`- #${entry.turn}${merged}${when.length > 0 ? ` ${when}` : ""} ${entry.summary}`);
	}
	if (coarsened > 0) lines.push(`（其中 ${coarsened} 条是多个早期回合合并后的粗粒度记录。）`);
	lines.push("（需要原文时用 session_event_search / session_event_read 按回合或 seq 定位。）");
	return truncateText(lines.join("\n"), budget);
}
