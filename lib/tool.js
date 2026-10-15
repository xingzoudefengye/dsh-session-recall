/**
 * `session_chronicle` — the model-facing bounded history tool.
 *
 * This is the cheap, pre-digested half of session recall: one call returns the
 * whole session's shape (status, goal, and the settled conclusion per turn)
 * inside a fixed character budget, with no index, no search, and no model call.
 * Event-level and cross-session detail belongs to the workspace-authorized
 * session-history tools when a deployment enables them.
 *
 * @module dsh-session-recall/tool
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { CHRONICLE_MAX_CHARS, buildChronicle, renderChronicle } from "./chronicle.js";

/** Loader row identity. */
export const name = "tool-session-chronicle";
/** The tool registry is the only service this row needs. */
export const inject = ["tools"];

const DESCRIPTION = [
	"Read this session's bounded turn-by-turn history (its chronicle).",
	"Each line is one turn a human opened: how it ended, what the user asked for, and — when the turn completed — the conclusion it settled on.",
	"Use it to recover what earlier work established after the conversation was compacted, or to orient inside a long task.",
	"Older turns are merged into coarser lines, so a line with a xN count represents several turns.",
	"It deliberately returns only this compact digest: for exact wording or event-level detail, read the original files and commands again, or use the session history tools when this deployment enables them."
].join(" ");

/**
 * Register `session_chronicle` on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 */
export function apply(ctx) {
	ctx.tools.register(
		defineTool({
			name: "session_chronicle",
			description: DESCRIPTION,
			parameters: {
				lastTurns: {
					type: "integer",
					description: "Return only the newest N turn records. Omit for the whole bounded chronicle."
				},
				maxChars: {
					type: "integer",
					description: `Character budget for the returned text. Defaults to ${CHRONICLE_MAX_CHARS} and is capped there.`
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						text: {
							type: "string",
							required: true,
							description: "The rendered chronicle."
						},
						entries: {
							type: "integer",
							required: true,
							description: "How many turn records the text carries."
						},
						chars: {
							type: "integer",
							required: true,
							description: "Length of the rendered text in characters."
						}
					}
				},
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			execute(args, exec) {
				const session = exec.agent?.session;
				if (session === undefined) throw new Error("session_chronicle requires an owning agent session");
				const options = {};
				if (Number.isSafeInteger(args.maxChars) && args.maxChars > 0) options.maxChars = args.maxChars;
				if (Number.isSafeInteger(args.lastTurns) && args.lastTurns > 0) options.lastTurns = args.lastTurns;
				const chronicle = buildChronicle(session.snapshotEvents(), options);
				const text = renderChronicle(chronicle, options);
				const shown = options.lastTurns === undefined ? chronicle.entries : chronicle.entries.slice(-options.lastTurns);
				return Promise.resolve({ text, entries: shown.length, chars: text.length });
			},
			presentCall: () => ({
				card: "generic",
				title: "Read session chronicle",
				kind: "other",
				rawInput: {}
			})
		})
	);
}
