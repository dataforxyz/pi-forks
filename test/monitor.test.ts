import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BackgroundEventsStore, namespacedEventId, type BackgroundEventEnvelope } from "../src/background-events.ts";
import { diagnoseForkRuns, parseSessionTokens, scanAgentSpend, scanBackgroundEvents, scanForkRuns, scanObservationalMemorySpend } from "../src/monitor.ts";

function makeHome(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-forks-test-"));
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeEnvelope(overrides: Partial<BackgroundEventEnvelope> = {}): BackgroundEventEnvelope {
	const source = overrides.source ?? "return_on";
	const parentNamespace = overrides.parentNamespace ?? "parent-1";
	const eventId = overrides.eventId ?? namespacedEventId(source, `event-${Math.random().toString(36).slice(2)}`);
	const workKey = overrides.workKey ?? `${source}:${parentNamespace}:job-1:fired-1`;
	return {
		version: 1,
		source,
		eventId,
		workKey,
		parentNamespace,
		parent: overrides.parent ?? { sessionId: parentNamespace, cwd: "/tmp/project" },
		createdAt: overrides.createdAt ?? Date.now(),
		priority: overrides.priority ?? "normal",
		payloadPath: overrides.payloadPath ?? "/tmp/payload.json",
		payloadSha256: overrides.payloadSha256 ?? "0".repeat(64),
		payloadBytes: overrides.payloadBytes ?? 2,
		...(overrides.origin !== undefined ? { origin: overrides.origin } : {}),
	};
}

function writeSession(sessionDir: string, timestamps = false): void {
	fs.mkdirSync(sessionDir, { recursive: true });
	const lines = timestamps
		? [
			JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", usage: { input: 999, output: 1, cost: 9 } }),
			JSON.stringify({ timestamp: "2026-01-01T00:00:10.000Z", usage: { input: 100, output: 50, cost: { total: 0.15 } } }),
			JSON.stringify({ timestamp: "2026-01-01T00:00:11.000Z", message: { usage: { inputTokens: 10, outputTokens: 5, cost: 0.015 } } }),
		]
		: [
			JSON.stringify({ usage: { input: 100, output: 50, cost: { total: 0.15 } } }),
			JSON.stringify({ message: { usage: { inputTokens: 10, outputTokens: 5, cost: 0.015 } } }),
		];
	fs.writeFileSync(path.join(sessionDir, "session.jsonl"), [...lines, ""].join("\n"), "utf8");
}

test("parseSessionTokens sums direct and nested usage", () => {
	const home = makeHome();
	const sessionDir = path.join(home, "sessions");
	writeSession(sessionDir);
	const tokens = parseSessionTokens(sessionDir);
	assert.equal(tokens?.input, 110);
	assert.equal(tokens?.output, 55);
	assert.equal(tokens?.total, 165);
	assert.ok(Math.abs((tokens?.cost ?? 0) - 0.165) < 0.000001);
});

test("scanForkRuns reports running count, durations, and token totals", () => {
	const home = makeHome();
	const now = Date.parse("2026-01-01T00:00:20.000Z");
	const intercomSessionDir = path.join(home, ".local/state/pi-intercom/handlers/icfh_1/sessions");
	const returnSessionDir = path.join(home, ".local/state/pi-return-on/handlers/roh_1/sessions");
	const subagentSessionDir = path.join(home, ".local/state/pi-subagents/handlers/sbf_1/sessions");
	writeSession(intercomSessionDir, true);
	writeSession(returnSessionDir, true);
	writeSession(subagentSessionDir, true);
	writeJson(path.join(home, ".local/state/pi-intercom/handlers.json"), {
		runs: [{ id: "icfh_1", from: "other", status: "running", startedAt: Date.parse("2026-01-01T00:00:09.000Z"), pid: process.pid, sessionDir: intercomSessionDir }],
	});
	writeJson(path.join(home, ".local/state/pi-return-on/handlers.json"), {
		handlers: [{ id: "roh_1", label: "build done", status: "complete", startedAt: Date.parse("2026-01-01T00:00:09.000Z"), endedAt: Date.parse("2026-01-01T00:00:12.000Z"), sessionDir: returnSessionDir }],
	});
	writeJson(path.join(home, ".local/state/pi-subagents/handlers.json"), {
		handlers: [{ id: "sbf_1", title: "review complete", type: "async-complete", status: "running", startedAt: Date.parse("2026-01-01T00:00:09.000Z"), pid: process.pid, sessionDir: subagentSessionDir }],
	});

	const active = scanForkRuns({ homeDir: home, now });
	assert.equal(active.running.length, 2);
	assert.equal(active.stale.length, 0);
	assert.equal(active.runs.length, 2);
	assert.equal(active.countsByStatus.running, 2);
	assert.equal(active.maxRunningDurationMs, 11_000);
	assert.equal(active.totalTokens.total, 330);
	assert.ok(Math.abs((active.totalTokens.cost ?? 0) - 0.33) < 0.000001);

	const all = scanForkRuns({ homeDir: home, now, includeCompleted: true });
	assert.equal(all.runs.length, 3);
	assert.equal(all.totalTokens.total, 495);
	assert.ok(Math.abs((all.totalTokens.cost ?? 0) - 0.495) < 0.000001);

	const scoped = scanForkRuns({ homeDir: home, now, includeCompleted: true, source: "return_on" });
	assert.equal(scoped.runs.length, 1);
	assert.equal(scoped.runs[0]?.source, "return_on");
	assert.equal(scoped.runs[0]?.intercomTarget, "fork-return-on-1");
	assert.equal(scoped.runs[0]?.intercomStatusTag, "fork-handler:return-on:roh_1");
	assert.equal(scoped.totalTokens.total, 165);
	assert.ok(Math.abs((scoped.totalTokens.cost ?? 0) - 0.165) < 0.000001);

	const withoutTokens = scanForkRuns({ homeDir: home, now, includeCompleted: true, includeTokens: false });
	assert.equal(withoutTokens.runs.length, 3);
	assert.equal(withoutTokens.totalTokens.total, 0);
	assert.equal(withoutTokens.runs.some((run) => run.tokens), false);
});

test("scanForkRuns marks dead running pids as stale and preserves raw status", () => {
	const home = makeHome();
	writeJson(path.join(home, ".local/state/pi-intercom/handlers.json"), {
		runs: [{ id: "icfh_dead", from: "other", status: "running", startedAt: 1_000, pid: 9_999_999 }],
	});

	const summary = scanForkRuns({ homeDir: home, now: 10_000 });
	assert.equal(summary.runs.length, 1);
	assert.equal(summary.runs[0]?.status, "stale");
	assert.equal(summary.runs[0]?.rawStatus, "running");
	assert.match(summary.runs[0]?.staleReason ?? "", /pid 9999999 is not alive/);
	assert.equal(summary.running.length, 0);
	assert.equal(summary.stale.length, 1);
	assert.equal(summary.countsByStatus.stale, 1);
});

test("scanForkRuns leaves running records without pid as running", () => {
	const home = makeHome();
	writeJson(path.join(home, ".local/state/pi-intercom/handlers.json"), {
		runs: [{ id: "icfh_missing_pid", from: "other", status: "running", startedAt: 1_000 }],
	});

	const summary = scanForkRuns({ homeDir: home, now: 10_000 });
	assert.equal(summary.runs.length, 1);
	assert.equal(summary.runs[0]?.status, "running");
	assert.equal(summary.runs[0]?.pidAlive, undefined);
	assert.equal(summary.runs[0]?.staleReason, undefined);
	assert.equal(summary.running.length, 1);
	assert.equal(summary.stale.length, 0);
});

test("diagnoseForkRuns labels legacy untracked subagent handler dirs", () => {
	const home = makeHome();
	const handlerDir = path.join(home, ".local/state/pi-subagents/handlers/sbf_legacy");
	writeJson(path.join(handlerDir, "event.json"), { type: "async-complete", title: "old completion" });
	fs.writeFileSync(path.join(handlerDir, "prompt.md"), "old prompt", "utf8");

	const diagnostics = diagnoseForkRuns({ homeDir: home, now: 10_000 });
	assert.equal(diagnostics.totals.unknown, 1);
	const issue = diagnostics.issues.find((candidate) => candidate.kind === "unknown");
	assert.match(issue?.message ?? "", /legacy untracked handler dir/);
	assert.equal(issue?.detail, "legacy untracked handler dir (async-complete)");
	assert.equal(diagnostics.summary.runs[0]?.detail, "legacy untracked handler dir (async-complete)");
});

test("diagnoseForkRuns reports stale records and duplicate active cwd groups", () => {
	const home = makeHome();
	const cwd = path.join(home, "repo");
	writeJson(path.join(home, ".local/state/pi-intercom/handlers.json"), {
		runs: [
			{ id: "icfh_dead", from: "other", status: "running", startedAt: 1_000, pid: 9_999_999, cwd },
			{ id: "icfh_live", from: "other", status: "running", startedAt: 2_000, pid: process.pid, cwd },
		],
	});

	const diagnostics = diagnoseForkRuns({ homeDir: home, now: 10_000 });
	assert.equal(diagnostics.totals.deadPidRunningRecords, 1);
	assert.equal(diagnostics.totals.stale, 1);
	assert.equal(diagnostics.totals.running, 1);
	assert.ok(diagnostics.issues.some((issue) => issue.kind === "stale_pid" && issue.runIds.includes("icfh_dead")));
	assert.ok(diagnostics.issues.some((issue) => issue.kind === "duplicate_active_cwd" && issue.cwd === cwd));
});

test("scanBackgroundEvents reports active queued attached stale failed slot and lineage usage", () => {
	const home = makeHome();
	const dbPath = path.join(home, "background-events.sqlite");
	assert.equal(scanBackgroundEvents({ dbPath: path.join(home, "missing.sqlite") }).exists, false);
	const store = new BackgroundEventsStore(dbPath);
	try {
		store.routeEvent(makeEnvelope({ eventId: "return_on:monitor-active", workKey: "return_on:parent-1:monitor-active", origin: { lineageId: "lin-1" } }), { handlerId: "handler-active", now: 1_000 });
		store.markHandlerRunning("handler-active", { leaseMs: 100, now: 1_000 });
		store.routeEvent(makeEnvelope({ eventId: "return_on:monitor-attached", workKey: "return_on:parent-1:monitor-active" }), { now: 1_010 });
		store.routeEvent(makeEnvelope({ eventId: "return_on:monitor-queued", workKey: "return_on:parent-1:monitor-queued" }), { limits: { global: 0 }, now: 1_020 });
		store.routeEvent(makeEnvelope({ eventId: "return_on:monitor-failed", workKey: "return_on:parent-1:monitor-failed" }), { handlerId: "handler-failed", now: 1_030 });
		const resultId = store.completeHandler("handler-failed", { status: "failed", now: 1_040 });
		store.db.prepare("UPDATE results SET delivery_state = 'failed' WHERE result_id = ?").run(resultId);
		store.db.prepare("UPDATE lineage_budgets SET max_forkable_followups = 1, used_forkable_followups = 1 WHERE lineage_id = 'lin-1'").run();
	} finally {
		store.close();
	}

	const status = scanBackgroundEvents({ dbPath, now: 1_200 });
	assert.equal(status.exists, true);
	assert.equal(status.activeHandlers, 1);
	assert.equal(status.queuedItems, 1);
	assert.equal(status.attachedUpdates, 1);
	assert.equal(status.staleLeases, 1);
	assert.equal(status.failedDeliveries, 1);
	assert.ok(status.slotUsed > 0);
	assert.ok(status.slotLimit >= status.slotUsed);
	assert.equal(status.lineageBudgets, 1);
	assert.equal(status.exhaustedForkableLineages, 1);
});

test("scanObservationalMemorySpend reports visible and full memory token footprint", () => {
	const entries = [
		{ type: "custom", customType: "om.observations.recorded", data: { observations: [{ id: "obs-a", tokenCount: 100 }, { id: "obs-b", tokenCount: 250 }] } },
		{ type: "custom", customType: "om.reflections.recorded", data: { reflections: [{ id: "ref-a", tokenCount: 75 }] } },
		{ type: "compaction", details: { type: "om.folded", version: 1, observations: [{ id: "obs-a", tokenCount: 100 }], reflections: [] } },
		{ type: "custom", customType: "om.observations.dropped", data: { observationIds: ["obs-a"] } },
	];

	const spend = scanObservationalMemorySpend(entries);

	assert.equal(spend.visibleTokens.total, 100);
	assert.equal(spend.fullTokens.total, 325);
	assert.equal(spend.visibleObservations, 1);
	assert.equal(spend.visibleReflections, 0);
	assert.equal(spend.fullObservations, 1);
	assert.equal(spend.fullReflections, 1);
	assert.equal(spend.droppedObservations, 1);
});

test("scanAgentSpend totals async subagent runs for a parent session", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-forks-agents-"));
	const parentSessionFile = path.join(root, "parent.jsonl");
	writeJson(path.join(root, "run-1/status.json"), {
		runId: "run-1",
		sessionId: parentSessionFile,
		state: "complete",
		cwd: "/repo",
		steps: [
			{
				tokens: { input: 100, output: 25, total: 125 },
				modelAttempts: [{ usage: { input: 100, output: 25, cost: { total: 0.125 } } }],
			},
			{
				modelAttempts: [{ usage: { input: 10, output: 5, cost: 0.015 } }],
			},
		],
	});
	writeJson(path.join(root, "run-2/status.json"), {
		runId: "run-2",
		sessionId: parentSessionFile,
		state: "running",
		steps: [{ tokens: { input: 1, output: 2, total: 3, cost: 0.003 } }],
	});
	writeJson(path.join(root, "run-3/status.json"), {
		runId: "run-3",
		sessionId: parentSessionFile,
		state: "paused",
		endedAt: 123,
		steps: [{ tokens: { input: 7, output: 8, total: 15, cost: 0.015 } }],
	});
	writeJson(path.join(root, "other/status.json"), {
		runId: "other",
		sessionId: "different.jsonl",
		state: "complete",
		steps: [{ tokens: { input: 999, output: 999, total: 1998, cost: 9 } }],
	});

	const spend = scanAgentSpend({ rootDir: root, parentSessionFile });
	assert.equal(spend.runs.length, 3);
	assert.equal(spend.active.length, 1);
	assert.equal(spend.steps, 4);
	assert.equal(spend.totalTokens.total, 158);
	assert.ok(Math.abs((spend.totalCost ?? 0) - 0.158) < 0.000001);
});
