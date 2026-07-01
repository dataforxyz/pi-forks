import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BackgroundEventsStore, namespacedEventId, type BackgroundEventEnvelope } from "../src/background-events.ts";
import { runSupervisedHandler } from "../src/background-supervisor.ts";

function makeEnvelope(dir: string, overrides: Partial<BackgroundEventEnvelope> = {}): BackgroundEventEnvelope {
	const source = overrides.source ?? "return_on";
	const parentNamespace = overrides.parentNamespace ?? "parent-1";
	const eventId = overrides.eventId ?? namespacedEventId(source, `event-${Math.random().toString(36).slice(2)}`);
	return {
		version: 1,
		source,
		eventId,
		workKey: overrides.workKey ?? `${source}:${parentNamespace}:job-1:fired-1`,
		parentNamespace,
		parent: overrides.parent ?? { sessionId: parentNamespace, cwd: dir },
		createdAt: overrides.createdAt ?? Date.now(),
		priority: overrides.priority ?? "normal",
		payloadPath: overrides.payloadPath ?? path.join(dir, "payload.json"),
		payloadSha256: overrides.payloadSha256 ?? "0".repeat(64),
		payloadBytes: overrides.payloadBytes ?? 2,
	};
}

async function withStore<T>(fn: (store: BackgroundEventsStore, dir: string, dbPath: string) => T | Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-background-supervisor-test-"));
	const dbPath = path.join(dir, "background-events.sqlite");
	const store = new BackgroundEventsStore(dbPath);
	try {
		return await fn(store, dir, dbPath);
	} finally {
		store.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("runSupervisedHandler heartbeats, captures output, completes, and releases slots", async () => {
	await withStore(async (store, dir, dbPath) => {
		const handlerId = "handler-supervised-ok";
		store.routeEvent(makeEnvelope(dir, { eventId: "return_on:supervised-ok" }), { handlerId });
		const script = path.join(dir, "child-ok.mjs");
		await fs.writeFile(script, "console.log('supervised ok');\n", "utf8");
		const stdoutPath = path.join(dir, "stdout.log");
		const stderrPath = path.join(dir, "stderr.log");
		const result = await runSupervisedHandler({
			dbPath,
			handlerId,
			command: process.execPath,
			args: [script],
			cwd: dir,
			stdoutPath,
			stderrPath,
			heartbeatMs: 10,
			leaseMs: 1_000,
		});
		assert.equal(result.exitCode, 0);
		assert.ok(result.resultId?.startsWith("ber_"));
		const inspect = new BackgroundEventsStore(dbPath);
		try {
			assert.match(await fs.readFile(stdoutPath, "utf8"), /supervised ok/);
			const handler = inspect.db.prepare("SELECT state, pid, supervisor_pid, process_group_id FROM handlers WHERE handler_id = ?").get(handlerId) as { state: string; pid: number; supervisor_pid: number; process_group_id: number };
			assert.equal(handler.state, "completed");
			assert.equal(typeof handler.pid, "number");
			assert.equal(typeof handler.supervisor_pid, "number");
			assert.equal(typeof handler.process_group_id, "number");
			const slots = inspect.db.prepare("SELECT used FROM slots").all() as Array<{ used: number }>;
			assert.equal(slots.every((row) => row.used === 0), true);
			const results = inspect.db.prepare("SELECT delivery_state, summary_path FROM results WHERE handler_id = ?").all(handlerId) as Array<{ delivery_state: string; summary_path: string }>;
			assert.deepEqual(results.map((row) => ({ delivery_state: row.delivery_state, summary_path: row.summary_path })), [{ delivery_state: "pending", summary_path: stdoutPath }]);
		} finally {
			inspect.close();
		}
	});
});

test("runSupervisedHandler requeues when process launch fails before running", async () => {
	await withStore(async (store, dir, dbPath) => {
		const handlerId = "handler-supervised-missing-command";
		store.routeEvent(makeEnvelope(dir, { eventId: "return_on:supervised-missing-command" }), { handlerId });
		await assert.rejects(runSupervisedHandler({ dbPath, handlerId, command: path.join(dir, "missing-command"), args: [], cwd: dir, stdoutPath: path.join(dir, "stdout-missing.log"), stderrPath: path.join(dir, "stderr-missing.log") }), /ENOENT|missing-command/);
		const inspect = new BackgroundEventsStore(dbPath);
		try {
			const handler = inspect.db.prepare("SELECT state FROM handlers WHERE handler_id = ?").get(handlerId) as { state: string };
			assert.equal(handler.state, "failed");
			const queued = inspect.db.prepare("SELECT queue_id FROM queue WHERE state = 'queued'").get() as { queue_id: string } | undefined;
			assert.ok(queued?.queue_id.startsWith("beq_"));
			const event = inspect.db.prepare("SELECT state FROM events WHERE event_id = 'return_on:supervised-missing-command'").get() as { state: string };
			assert.equal(event.state, "queued");
			const slots = inspect.db.prepare("SELECT used FROM slots").all() as Array<{ used: number }>;
			assert.equal(slots.every((row) => row.used === 0), true);
		} finally {
			inspect.close();
		}
	});
});

test("runSupervisedHandler marks non-zero child exits failed and releases slots", async () => {
	await withStore(async (store, dir, dbPath) => {
		const handlerId = "handler-supervised-fail";
		store.routeEvent(makeEnvelope(dir, { eventId: "return_on:supervised-fail" }), { handlerId });
		const script = path.join(dir, "child-fail.mjs");
		await fs.writeFile(script, "console.error('supervised fail'); process.exit(7);\n", "utf8");
		const stdoutPath = path.join(dir, "stdout-fail.log");
		const stderrPath = path.join(dir, "stderr-fail.log");
		const result = await runSupervisedHandler({ dbPath, handlerId, command: process.execPath, args: [script], cwd: dir, stdoutPath, stderrPath, heartbeatMs: 10, leaseMs: 1_000 });
		assert.equal(result.exitCode, 7);
		const inspect = new BackgroundEventsStore(dbPath);
		try {
			assert.match(await fs.readFile(stderrPath, "utf8"), /supervised fail/);
			const handler = inspect.db.prepare("SELECT state FROM handlers WHERE handler_id = ?").get(handlerId) as { state: string };
			assert.equal(handler.state, "failed");
			const slots = inspect.db.prepare("SELECT used FROM slots").all() as Array<{ used: number }>;
			assert.equal(slots.every((row) => row.used === 0), true);
		} finally {
			inspect.close();
		}
	});
});
