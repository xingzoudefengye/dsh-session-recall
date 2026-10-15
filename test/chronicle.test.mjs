import assert from "node:assert/strict";
import test from "node:test";
import {
	CHRONICLE_MAX_CHARS,
	CHRONICLE_MAX_PAYLOAD_CHARS,
	buildChronicle,
	renderChronicle,
	sanitizeChronicleText,
	visibleText
} from "../lib/chronicle.js";

/** Build a realistic event log from a compact turn description. */
function session(turns) {
	const events = [];
	let seq = 0;
	const push = (type, data) => {
		events.push({ type, seq: seq, time: 1_700_000_000_000 + seq * 1000, data });
		seq += 1;
	};
	for (const turn of turns) {
		push("turn/start", { turn: turn.n });
		if (turn.injected) push("user/message", { content: [{ type: "text", text: turn.injected }], source: { kind: "agent-instructions" } });
		if (turn.goal) push("user/message", { content: [{ type: "text", text: turn.goal }], source: { kind: "user" } });
		if (turn.response) push("assistant/message", { message: { role: "assistant", content: [{ type: "text", text: turn.response }] } });
		if (turn.status !== "open") push("turn/end", { turn: turn.n, reason: { kind: turn.status ?? "completed" } });
	}
	return events;
}

test("folds one entry per human-opened turn and ignores injected context", () => {
	const chronicle = buildChronicle(
		session([
			{ n: 1, injected: "<system-reminder>skill catalog</system-reminder>", goal: "把超时改成 30 秒。", response: "改完了。", status: "completed" },
			{ n: 2, goal: "再跑一遍测试。", response: "", status: "aborted" },
			{ n: 3, injected: "runtime context snapshot", status: "completed" }
		])
	);

	assert.equal(chronicle.entries.length, 2, "a turn with no human prompt is not recorded");
	assert.equal(chronicle.entries[0].turn, 1);
	assert.match(chronicle.entries[0].summary, /回合完成/);
	assert.match(chronicle.entries[0].summary, /目标：把超时改成 30 秒/);
	assert.match(chronicle.entries[0].summary, /回复：改完了/);
	assert.ok(!chronicle.entries[0].summary.includes("skill catalog"), "injected context never becomes a goal");
});

test("keeps a response only for a completed turn", () => {
	const chronicle = buildChronicle(
		session([
			{ n: 1, goal: "部署。", response: "已经部署成功了", status: "aborted" },
			{ n: 2, goal: "重试。", response: "这次真的完成", status: "completed" }
		])
	);

	assert.equal(chronicle.entries[0].response, "", "an uncommitted reply must not be recorded");
	assert.ok(!chronicle.entries[0].summary.includes("部署成功"));
	assert.equal(chronicle.entries[1].response, "这次真的完成");
});

test("maps the whole TurnEndReason vocabulary", () => {
	const statuses = ["completed", "aborted", "blocked", "error", "max-tokens", "interrupted"];
	const chronicle = buildChronicle(
		session(statuses.map((status, index) => ({ n: index + 1, goal: `第 ${index + 1} 个回合`, status })))
	);

	assert.deepEqual(
		chronicle.entries.map((entry) => entry.status),
		statuses
	);
	assert.match(chronicle.entries[1].summary, /回合取消/);
	assert.match(chronicle.entries[2].summary, /回合被阻止/);
	assert.match(chronicle.entries[3].summary, /回合失败/);
	assert.match(chronicle.entries[4].summary, /输出上限/);
	assert.match(chronicle.entries[5].summary, /回合被中断/);
});

test("reports a turn that is still in flight", () => {
	const chronicle = buildChronicle(session([{ n: 1, goal: "正在做的事。", status: "open" }]));

	assert.equal(chronicle.entries.length, 1);
	assert.equal(chronicle.entries[0].status, "running");
	assert.match(chronicle.entries[0].summary, /回合进行中/);
});

test("coarsens the deep past instead of growing without bound", () => {
	const turns = Array.from({ length: 60 }, (_, index) => ({
		n: index + 1,
		goal: `第 ${index + 1} 个回合的目标说明`,
		response: `第 ${index + 1} 个回合的结论`,
		status: "completed"
	}));
	const chronicle = buildChronicle(session(turns));

	assert.ok(chronicle.entries.length <= 22, `entries were ${chronicle.entries.length}`);
	const layers = new Set(chronicle.entries.map((entry) => entry.recency));
	assert.ok(layers.has("recent"), "the newest turns stay at full detail");
	assert.ok(layers.has("earlier") || layers.has("oldest"), "older turns are coarsened");
	assert.ok(chronicle.entries.some((entry) => (entry.count ?? 1) > 1), "coarsening merges several turns");
	assert.ok(
		chronicle.entries.some((entry) => entry.turn === 60),
		"the newest turn is always retained"
	);
	assert.ok(
		(!chronicle.entries.some((entry) => entry.turn === 1) || chronicle.entries.some((entry) => (entry.count ?? 1) > 1)),
		"the oldest turn survives only as part of a merge"
	);
});

test("never exceeds the serialized character budget", () => {
	const turns = Array.from({ length: 80 }, (_, index) => ({
		n: index + 1,
		goal: `目标 ${index} `.repeat(120),
		response: `结论 ${index} `.repeat(120),
		status: "completed"
	}));
	const chronicle = buildChronicle(session(turns));

	// Two bounds with two jobs: the rendered text honours the reader's budget,
	// and the returned value honours its own ceiling without ever being the
	// reason a reader loses a turn.
	assert.ok(renderChronicle(chronicle).length <= CHRONICLE_MAX_CHARS);
	const size = JSON.stringify(chronicle).length;
	assert.ok(size <= CHRONICLE_MAX_PAYLOAD_CHARS, `serialized chronicle was ${size} characters`);
	assert.ok(chronicle.entries.length > 0);
});

test("redacts secrets and code but keeps paths and urls", () => {
	const chronicle = buildChronicle(
		session([
			{
				n: 1,
				goal: "用 sk-1234567890abcdef 调接口，配置在 /repo/src/config.ts，文档在 https://example.com/docs",
				response: "```bash\nrm -rf /\n```\n密钥 sk-abcdefgh12345678 已换",
				status: "completed"
			}
		])
	);

	const summary = chronicle.entries[0].summary;
	assert.ok(!summary.includes("sk-1234567890abcdef"), "provider key must be redacted");
	assert.ok(!summary.includes("sk-abcdefgh12345678"), "response key must be redacted");
	assert.match(summary, /\[代码省略\]/);
	assert.match(summary, /\/repo\/src\/config\.ts/, "paths are the work product and stay");
	assert.match(summary, /https:\/\/example\.com\/docs/, "urls stay");
});

test("renders a bounded, honest view", () => {
	const turns = Array.from({ length: 30 }, (_, index) => ({
		n: index + 1,
		goal: `目标 ${index + 1}`,
		response: `结论 ${index + 1}`,
		status: "completed"
	}));
	const chronicle = buildChronicle(session(turns));

	const text = renderChronicle(chronicle);
	assert.match(text, /会话史书（本地生成，未调用模型）/);
	assert.match(text, /session_event_read/);
	assert.ok(text.length <= CHRONICLE_MAX_CHARS);

	const narrow = renderChronicle(chronicle, { lastTurns: 3 });
	assert.equal(narrow.split("\n").filter((line) => line.startsWith("- ")).length, 3);
	assert.match(narrow, /#30/);

	const tiny = renderChronicle(chronicle, { maxChars: 200 });
	assert.ok(tiny.length <= 200, `rendered ${tiny.length} characters`);
});

test("spends the budget on rendered text, not on the entry payload", () => {
	// The real-world shape that regressed: the handoff backend asks for 2400
	// characters, and the chronicle used to size that budget against
	// `JSON.stringify(entries)` — whose fields rendering never reads. A handful
	// of ordinary turns was enough to overrun it, and then every summary was
	// crushed to its floor: the label survived whole and the goal was reduced to
	// its first character.
	const goalOf = (n) => `第 ${n} 个回合：把超时从 30 秒改成 45 秒，重新跑一遍完整的集成测试，并核对远端 hash 与本机仓库是否一致`;
	const responseOf = (n) => `第 ${n} 个回合的结论：改完并验证通过，远端 hash 与本地一致，测试全绿，改动已提交并推送。`;
	const turns = Array.from({ length: 8 }, (_, index) => ({
		n: index + 1,
		goal: goalOf(index + 1),
		response: responseOf(index + 1),
		status: "completed"
	}));
	const budget = 2_400;
	const chronicle = buildChronicle(session(turns), { maxChars: budget });
	const text = renderChronicle(chronicle, { maxChars: budget });

	assert.ok(text.length <= budget, `rendered ${text.length} characters`);
	assert.equal(chronicle.entries.length, turns.length, "no turn is dropped for a transport bound");
	for (const turn of turns) {
		assert.ok(text.includes(goalOf(turn.n)), `turn ${turn.n}'s goal must survive intact`);
		assert.ok(text.includes(responseOf(turn.n)), `turn ${turn.n}'s conclusion must survive intact`);
	}
	assert.ok(JSON.stringify(chronicle).length <= CHRONICLE_MAX_PAYLOAD_CHARS, "the value stays transportable");
});

test("keeps the goal and gives up the label when the budget is tight", () => {
	const turns = Array.from({ length: 6 }, (_, index) => ({
		n: index + 1,
		goal: `第 ${index + 1} 个回合要处理的完整目标说明文字`,
		status: "completed"
	}));
	const chronicle = buildChronicle(session(turns), { maxChars: 200 });

	for (const entry of chronicle.entries) {
		assert.ok(
			!/^回合完成（目标未核验）；目标：.$/u.test(entry.summary),
			`a squeezed entry must not keep the label and drop the goal: ${entry.summary}`
		);
		assert.match(entry.summary, /目标：/u, "every squeezed entry still names its goal");
	}
	assert.ok(
		chronicle.entries.some((entry) => /目标：第 \d+ 个回合/u.test(entry.summary)),
		"at least one entry carries real goal text, not just its first character"
	);
});

test("sanitize keeps single-line text and honours its budget", () => {
	assert.equal(sanitizeChronicleText("line one\n\nline   two", 100), "line one line two");
	assert.equal(sanitizeChronicleText("x".repeat(50), 10).length, 10);
	assert.equal(sanitizeChronicleText("token: abcdef123456", 100).includes("abcdef123456"), false);
	assert.equal(visibleText([{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }]), "a\nb");
	assert.equal(visibleText(undefined), "");
});

test("ignores malformed events instead of throwing", () => {
	const chronicle = buildChronicle([
		null,
		{ type: "turn/start", seq: 0, time: 1, data: {} },
		{ type: "user/message", seq: 1, time: 2, data: { content: null, source: { kind: "user" } } },
		{ type: "turn/end", seq: 2, time: 3, data: {} },
		42,
		{ type: "assistant/message", seq: 3, time: 4 }
	]);

	assert.equal(chronicle.entries.length, 0, "a turn with no usable human text is dropped");
	assert.deepEqual(buildChronicle(undefined).entries, []);
});
