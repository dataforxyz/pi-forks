import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanForkRuns } from "../src/monitor.ts";

function makeHome(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-forks-mapper-"));
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const NOW = Date.parse("2026-01-01T00:00:30.000Z");
const STARTED = Date.parse("2026-01-01T00:00:10.000Z");
const ENDED = Date.parse("2026-01-01T00:00:25.000Z");

test("mapIntercomRun produces complete golden run via scanForkRuns", () => {
	const home = makeHome();
	writeJson(path.join(home, ".local/state/pi-intercom/handlers.json"), {
		runs: [{
			id: "icfh_golden",
			from: "alice",
			status: "complete",
			startedAt: STARTED,
			endedAt: ENDED,
			pid: process.pid,
			cwd: "/repo/a",
			dir: "/state/a",
			sessionDir: "/sessions/a",
			messageId: "msg-1",
			parentSessionFile: "parent.jsonl",
			parentSessionId: "psid",
			parentSessionName: "psname",
			parentIntercomTarget: "parent-target",
		}],
	});
	const summary = scanForkRuns({ homeDir: home, now: NOW, includeCompleted: true, includeTokens: false });
	assert.equal(summary.runs.length, 1);
	const run = summary.runs[0]!;
	assert.equal(run.source, "intercom");
	assert.equal(run.id, "icfh_golden");
	assert.equal(run.label, "from alice");
	assert.equal(run.status, "complete");
	assert.equal(run.pid, process.pid);
	assert.equal(run.pidAlive, true);
	assert.equal(run.cwd, "/repo/a");
	assert.equal(run.dir, "/state/a");
	assert.equal(run.sessionDir, "/sessions/a");
	assert.equal(run.startedAt, STARTED);
	assert.equal(run.endedAt, ENDED);
	assert.equal(run.durationMs, ENDED - STARTED);
	assert.equal(run.parentSessionFile, "parent.jsonl");
	assert.equal(run.parentSessionId, "psid");
	assert.equal(run.parentSessionName, "psname");
	assert.equal(run.parentIntercomTarget, "parent-target");
	assert.equal(run.detail, "message msg-1");
	assert.equal(run.intercomTarget, "fork-intercom-golden");
	assert.equal(run.intercomStatusTag, "fork-handler:intercom:icfh_golden");
	assert.equal(run.rawStatus, undefined);
});

test("mapIntercomRun without id is skipped, label defaults to id", () => {
	const home = makeHome();
	writeJson(path.join(home, ".local/state/pi-intercom/handlers.json"), {
		runs: [
			{ from: "bob", status: "running" },
			{ id: "icfh_no_from", status: "running", startedAt: STARTED, pid: process.pid },
		],
	});
	const summary = scanForkRuns({ homeDir: home, now: NOW, includeTokens: false });
	assert.equal(summary.runs.length, 1);
	assert.equal(summary.runs[0]!.id, "icfh_no_from");
	assert.equal(summary.runs[0]!.label, "icfh_no_from");
});

test("mapReturnOnRun uses label||jobId||id and emits job detail", () => {
	const home = makeHome();
	writeJson(path.join(home, ".local/state/pi-return-on/handlers.json"), {
		handlers: [
			{ id: "roh_a", jobId: "job-1", label: "human label", status: "running", startedAt: STARTED, pid: process.pid, sessionDir: "/s/a" },
			{ id: "roh_b", jobId: "job-2", status: "running", startedAt: STARTED, pid: process.pid },
			{ id: "roh_c", status: "running", startedAt: STARTED, pid: process.pid },
		],
	});
	const summary = scanForkRuns({ homeDir: home, now: NOW, includeTokens: false });
	const byId = Object.fromEntries(summary.runs.map((r) => [r.id, r]));
	assert.equal(byId.roh_a?.label, "human label");
	assert.equal(byId.roh_a?.detail, "job job-1");
	assert.equal(byId.roh_a?.intercomTarget, "fork-return-on-a");
	assert.equal(byId.roh_a?.intercomStatusTag, "fork-handler:return-on:roh_a");
	assert.equal(byId.roh_b?.label, "job-2");
	assert.equal(byId.roh_b?.detail, "job job-2");
	assert.equal(byId.roh_c?.label, "roh_c");
	assert.equal(byId.roh_c?.detail, undefined);
});

test("mapSubagentRun uses title||id and exposes type as detail", () => {
	const home = makeHome();
	writeJson(path.join(home, ".local/state/pi-subagents/handlers.json"), {
		handlers: [
			{ id: "sbf_a", title: "research task", type: "async-complete", status: "running", startedAt: STARTED, pid: process.pid, parentSessionName: "pname" },
			{ id: "sbf_b", status: "complete", startedAt: STARTED, endedAt: ENDED },
		],
	});
	const summary = scanForkRuns({ homeDir: home, now: NOW, includeCompleted: true, includeTokens: false });
	const byId = Object.fromEntries(summary.runs.map((r) => [r.id, r]));
	assert.equal(byId.sbf_a?.source, "subagents");
	assert.equal(byId.sbf_a?.label, "research task");
	assert.equal(byId.sbf_a?.detail, "async-complete");
	assert.equal(byId.sbf_a?.parentIntercomTarget, "pname");
	assert.equal(byId.sbf_a?.intercomTarget, "fork-subagent-a");
	assert.equal(byId.sbf_a?.intercomStatusTag, "fork-handler:subagent:sbf_a");
	assert.equal(byId.sbf_b?.label, "sbf_b");
	assert.equal(byId.sbf_b?.detail, undefined);
	assert.equal(byId.sbf_b?.durationMs, ENDED - STARTED);
});

test("mappers mark dead pids stale uniformly across sources", () => {
	const home = makeHome();
	writeJson(path.join(home, ".local/state/pi-intercom/handlers.json"), {
		runs: [{ id: "icfh_dead", from: "x", status: "running", startedAt: STARTED, pid: 9_999_999 }],
	});
	writeJson(path.join(home, ".local/state/pi-return-on/handlers.json"), {
		handlers: [{ id: "roh_dead", status: "starting", startedAt: STARTED, pid: 9_999_998 }],
	});
	writeJson(path.join(home, ".local/state/pi-subagents/handlers.json"), {
		handlers: [{ id: "sbf_dead", title: "t", status: "running", startedAt: STARTED, pid: 9_999_997 }],
	});
	const summary = scanForkRuns({ homeDir: home, now: NOW, includeTokens: false });
	assert.equal(summary.runs.length, 3);
	for (const run of summary.runs) {
		assert.equal(run.status, "stale", `${run.source} expected stale`);
		assert.equal(run.pidAlive, false);
		assert.match(run.staleReason ?? "", /not alive/);
	}
});
