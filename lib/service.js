/**
 * `ctx.sessionChronicle` — the bounded session chronicle as a service.
 *
 * Other plugins (notably the local-handoff compaction backend) consume this to
 * put turn-level history into whatever they render, without depending on this
 * package's file layout. The fold is pure, so any caller can also import
 * {@link buildChronicle} directly when it holds raw events.
 *
 * @module dsh-session-recall/service
 */
import { Service } from "@deepseek-ai/cordis";
import { buildChronicle, renderChronicle } from "./chronicle.js";

export class SessionChronicle extends Service {
	/**
	 * @param ctx - owning cordis context.
	 */
	constructor(ctx) {
		super(ctx, "sessionChronicle");
	}

	/**
	 * Fold one live session's durable log into a bounded chronicle.
	 * @param session - session exposing `snapshotEvents()`.
	 * @param options - optional `maxChars` output-text budget.
	 * @returns `{ version, entries }`.
	 */
	outline(session, options = {}) {
		const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
		return buildChronicle(events, options);
	}

	/**
	 * Render one live session's chronicle as bounded text.
	 * @param session - session exposing `snapshotEvents()`.
	 * @param options - optional `maxChars` and `lastTurns`.
	 * @returns the rendered text.
	 */
	render(session, options = {}) {
		return renderChronicle(this.outline(session, options), options);
	}

	/**
	 * Bounded chronicle text for a caller that already holds raw events.
	 * @param events - session events in log order.
	 * @param options - optional `maxChars` and `lastTurns`.
	 * @returns the rendered text.
	 */
	renderEvents(events, options = {}) {
		return renderChronicle(buildChronicle(events, options), options);
	}
}

export default SessionChronicle;
