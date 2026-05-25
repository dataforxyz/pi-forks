import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { diagnoseForkRuns, parseSessionTokens, scanForkRuns } from "../src/monitor.ts";

function makeHome(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-forks-test-"));
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeSession(sessionDir: string): void {
	fs.mkdirSync(sessionDir, { recursive: true });
	fs.writeFileSync(path.join(sessionDir, "session.jsonl"), [
		JSON.stringify({ usage: { input: 100, output: 50 } }),
		JSON.stringify({ message: { usage: { inputTokens: 10, outputTokens: 5 } } }),
		"",
	].join("\n"), "utf8");
}

test("parseSessionTokens sums direct and nested usage", () => {
	const home = makeHome();
	const sessionDir = path.join(home, "sessions");
	writeSession(sessionDir);
	assert.deepEqual(parseSessionTokens(sessionDir), { input: 110, output: 55, total: 165 });
});

test("scanForkRuns reports running count, durations, and token totals", () => {
	const home = makeHome();
	const now = 10_000;
	const intercomSessionDir = path.join(home, ".local/state/pi-intercom/handlers/icfh_1/sessions");
	const returnSessionDir = path.join(home, ".local/state/pi-return-on/handlers/roh_1/sessions");
	const subagentSessionDir = path.join(home, ".local/state/pi-subagents/handlers/sbf_1/sessions");
	writeSession(intercomSessionDir);
	writeSession(returnSessionDir);
	writeSession(subagentSessionDir);
	writeJson(path.join(home, ".local/state/pi-intercom/handlers.json"), {
		runs: [{ id: "icfh_1", from: "other", status: "running", startedAt: 1_000, pid: process.pid, sessionDir: intercomSessionDir }],
	});
	writeJson(path.join(home, ".local/state/pi-return-on/handlers.json"), {
		handlers: [{ id: "roh_1", label: "build done", status: "complete", startedAt: 2_000, endedAt: 3_000, sessionDir: returnSessionDir }],
	});
	writeJson(path.join(home, ".local/state/pi-subagents/handlers.json"), {
		handlers: [{ id: "sbf_1", title: "review complete", type: "async-complete", status: "running", startedAt: 4_000, pid: process.pid, sessionDir: subagentSessionDir }],
	});

	const active = scanForkRuns({ homeDir: home, now });
	assert.equal(active.running.length, 2);
	assert.equal(active.stale.length, 0);
	assert.equal(active.runs.length, 2);
	assert.equal(active.countsByStatus.running, 2);
	assert.equal(active.maxRunningDurationMs, 9_000);
	assert.equal(active.totalTokens.total, 330);

	const all = scanForkRuns({ homeDir: home, now, includeCompleted: true });
	assert.equal(all.runs.length, 3);
	assert.equal(all.totalTokens.total, 495);

	const scoped = scanForkRuns({ homeDir: home, now, includeCompleted: true, source: "return_on" });
	assert.equal(scoped.runs.length, 1);
	assert.equal(scoped.runs[0]?.source, "return_on");
	assert.equal(scoped.runs[0]?.intercomTarget, "fork-return-on-1");
	assert.equal(scoped.runs[0]?.intercomStatusTag, "fork-handler:return-on:roh_1");
	assert.equal(scoped.totalTokens.total, 165);
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
