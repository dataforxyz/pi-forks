import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	BackgroundEventsStore,
	applyRouterGuardrails,
	isForbiddenRouterDecision,
	namespacedEventId,
	resolveBackgroundRouterConfig,
	resolveBackgroundStateRoot,
	runOptionalRouterDecision,
	snapshotPayload,
	type BackgroundEventEnvelope,
} from "../src/background-events.ts";

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
		...(overrides.expectedReply !== undefined ? { expectedReply: overrides.expectedReply } : {}),
		...(overrides.needsDecision !== undefined ? { needsDecision: overrides.needsDecision } : {}),
		...(overrides.eventType !== undefined ? { eventType: overrides.eventType } : {}),
		...(overrides.origin !== undefined ? { origin: overrides.origin } : {}),
	};
}

async function withStore<T>(fn: (store: BackgroundEventsStore, dir: string) => T | Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-background-events-test-"));
	const store = new BackgroundEventsStore(path.join(dir, "background-events.sqlite"));
	try {
		return await fn(store, dir);
	} finally {
		store.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("resolveBackgroundStateRoot honors PI_BACKGROUND_STATE_DIR and expands home", () => {
	assert.equal(resolveBackgroundStateRoot({ PI_BACKGROUND_STATE_DIR: "~/be" }, "/tmp/home"), "/tmp/home/be");
	assert.equal(resolveBackgroundStateRoot({ PI_FORKS_STATE_ROOT: "/tmp/forks" }, "/tmp/home"), "/tmp/forks");
	assert.equal(resolveBackgroundStateRoot({}, "/tmp/home"), "/tmp/home/.local/state/pi-background-events");
});

test("namespacedEventId enforces source namespace on route", async () => {
	await withStore((store) => {
		assert.equal(namespacedEventId("return_on", "abc"), "return_on:abc");
		assert.throws(() => store.routeEvent(makeEnvelope({ eventId: "abc" })), /must be globally source-namespaced/);
	});
});

test("routeEvent is idempotent for replayed eventId", async () => {
	await withStore((store) => {
		const event = makeEnvelope({ eventId: "return_on:replay", workKey: "return_on:parent-1:job:fired" });
		const first = store.routeEvent(event, { handlerId: "handler-1" });
		assert.equal(first.disposition, "handler-starting");
		const second = store.routeEvent(event, { handlerId: "handler-2" });
		assert.equal(second.disposition, "existing");
		assert.equal(second.existingState, "handler-starting");
		const handlers = store.db.prepare("SELECT handler_id FROM handlers").all() as Array<{ handler_id: string }>;
		assert.deepEqual(handlers.map((row) => row.handler_id), ["handler-1"]);
	});
});

test("same workKey with new event attaches to active handler", async () => {
	await withStore((store) => {
		const first = makeEnvelope({ eventId: "return_on:first", workKey: "return_on:parent-1:job:fired" });
		assert.equal(store.routeEvent(first, { handlerId: "handler-1" }).disposition, "handler-starting");
		const second = makeEnvelope({ eventId: "return_on:second", workKey: first.workKey });
		const result = store.routeEvent(second, { handlerId: "handler-2" });
		assert.equal(result.disposition, "attached-to-handler");
		assert.equal(result.handlerId, "handler-1");
		assert.equal(result.updateSeq, 1);
		const updates = (store.db.prepare("SELECT handler_id, event_id, seq FROM updates").all() as Array<{ handler_id: string; event_id: string; seq: number }>)
			.map((row) => ({ handler_id: row.handler_id, event_id: row.event_id, seq: row.seq }));
		assert.deepEqual(updates, [{ handler_id: "handler-1", event_id: "return_on:second", seq: 1 }]);
	});
});

test("slot reservation is all-or-none and queues when any scope is full", async () => {
	await withStore((store) => {
		const first = makeEnvelope({ eventId: "return_on:slot-1", workKey: "return_on:parent-1:job:fired-1" });
		assert.equal(store.routeEvent(first, { handlerId: "handler-1", limits: { global: 1 } }).disposition, "handler-starting");
		const second = makeEnvelope({ eventId: "return_on:slot-2", workKey: "return_on:parent-1:job:fired-2" });
		const result = store.routeEvent(second, { handlerId: "handler-2", limits: { global: 1 } });
		assert.equal(result.disposition, "queued");
		const reservations = store.db.prepare("SELECT handler_id, scope FROM handler_slot_reservations ORDER BY handler_id, scope").all() as Array<{ handler_id: string; scope: string }>;
		assert.equal(reservations.every((row) => row.handler_id === "handler-1"), true);
		assert.equal(reservations.some((row) => row.handler_id === "handler-2"), false);
		const globalRow = store.db.prepare("SELECT used, limit_value FROM slots WHERE scope = 'global'").get() as { used: number; limit_value: number };
		assert.deepEqual({ used: globalRow.used, limit_value: globalRow.limit_value }, { used: 1, limit_value: 1 });
	});
});

test("queued duplicate merges events and raises priority without losing FIFO position", async () => {
	await withStore((store) => {
		const first = makeEnvelope({ eventId: "return_on:queued-priority-1", workKey: "return_on:parent-1:job:queued-priority", priority: "low", createdAt: 1_000 });
		const queued = store.routeEvent(first, { limits: { global: 0 }, now: 1_000 });
		assert.equal(queued.disposition, "queued");
		const second = makeEnvelope({ eventId: "return_on:queued-priority-2", workKey: first.workKey, priority: "high", createdAt: 2_000 });
		const merged = store.routeEvent(second, { limits: { global: 0 }, now: 2_000 });
		assert.equal(merged.disposition, "queued");
		assert.equal(merged.queueId, queued.queueId);
		const row = store.db.prepare("SELECT priority, created_at FROM queue WHERE queue_id = ?").get(queued.queueId) as { priority: string; created_at: number };
		assert.deepEqual({ priority: row.priority, created_at: row.created_at }, { priority: "high", created_at: 1_000 });
		const eventIds = store.db.prepare("SELECT event_id FROM queued_events WHERE queue_id = ? ORDER BY event_id").all(queued.queueId) as Array<{ event_id: string }>;
		assert.deepEqual(eventIds.map((row) => row.event_id), ["return_on:queued-priority-1", "return_on:queued-priority-2"]);
	});
});

test("dequeueNextQueued claims exactly one queued work item after slots free", async () => {
	await withStore((store) => {
		const first = makeEnvelope({ eventId: "return_on:dequeue-active", workKey: "return_on:parent-1:job:active" });
		assert.equal(store.routeEvent(first, { handlerId: "handler-active", limits: { global: 1 }, now: 1_000 }).disposition, "handler-starting");
		const queuedEvent = makeEnvelope({ eventId: "return_on:dequeue-queued", workKey: "return_on:parent-1:job:queued" });
		const queued = store.routeEvent(queuedEvent, { limits: { global: 1 }, now: 1_100 });
		assert.equal(queued.disposition, "queued");
		assert.equal(store.dequeueNextQueued({ handlerId: "handler-queued", limits: { global: 1 }, now: 1_200 }).disposition, "blocked");
		store.completeHandler("handler-active", { now: 1_300 });
		const claimed = store.dequeueNextQueued({ handlerId: "handler-queued", limits: { global: 1 }, now: 1_400 });
		assert.equal(claimed.disposition, "handler-starting");
		assert.equal(claimed.queueId, queued.queueId);
		assert.deepEqual(claimed.eventIds, ["return_on:dequeue-queued"]);
		const handlers = store.db.prepare("SELECT handler_id FROM handlers WHERE work_key = ?").all(queuedEvent.workKey) as Array<{ handler_id: string }>;
		assert.deepEqual(handlers.map((row) => row.handler_id), ["handler-queued"]);
		const queueRow = store.db.prepare("SELECT state FROM queue WHERE queue_id = ?").get(queued.queueId) as { state: string };
		assert.equal(queueRow.state, "handler-starting");
		const bundle = store.getHandlerLaunchBundle("handler-queued");
		assert.deepEqual(bundle?.events.map((event) => event.eventId), ["return_on:dequeue-queued"]);
	});
});

test("getHandlerLaunchBundle materializes handler work and payload events", async () => {
	await withStore((store) => {
		const first = makeEnvelope({ eventId: "return_on:bundle-1", workKey: "return_on:parent-1:job:bundle", payloadPath: "/tmp/bundle-1.json", payloadBytes: 11 });
		store.routeEvent(first, { handlerId: "handler-bundle", now: 1_000 });
		store.routeEvent(makeEnvelope({ eventId: "return_on:bundle-2", workKey: first.workKey, payloadPath: "/tmp/bundle-2.json", payloadBytes: 22 }), { now: 1_100 });
		const bundle = store.getHandlerLaunchBundle("handler-bundle");
		assert.equal(bundle?.handlerId, "handler-bundle");
		assert.equal(bundle?.source, "return_on");
		assert.equal(bundle?.workKey, first.workKey);
		assert.deepEqual(bundle?.events.map((event) => ({ eventId: event.eventId, payloadPath: event.payloadPath, payloadBytes: event.payloadBytes, state: event.state })), [
			{ eventId: "return_on:bundle-1", payloadPath: "/tmp/bundle-1.json", payloadBytes: 11, state: "handler-starting" },
			{ eventId: "return_on:bundle-2", payloadPath: "/tmp/bundle-2.json", payloadBytes: 22, state: "attached-to-handler" },
		]);
		assert.equal(store.getHandlerLaunchBundle("missing"), undefined);
	});
});

test("source-filtered dequeue does not claim other-source queued work", async () => {
	await withStore((store) => {
		const intercom = makeEnvelope({ source: "intercom", eventId: "intercom:queued-first", workKey: "intercom:parent-1:message:queued-first", createdAt: 1_000 });
		const ret = makeEnvelope({ source: "return_on", eventId: "return_on:queued-second", workKey: "return_on:parent-1:job:queued-second", createdAt: 2_000 });
		assert.equal(store.routeEvent(intercom, { limits: { global: 0 }, now: 1_000 }).disposition, "queued");
		assert.equal(store.routeEvent(ret, { limits: { global: 0 }, now: 2_000 }).disposition, "queued");
		const claimedReturnOn = store.dequeueNextQueued({ source: "return_on", limits: { global: 1 }, handlerId: "handler-return-on", now: 3_000 });
		assert.equal(claimedReturnOn.disposition, "handler-starting");
		assert.equal(claimedReturnOn.handlerId, "handler-return-on");
		const intercomQueue = store.db.prepare("SELECT state FROM queue WHERE source = 'intercom'").get() as { state: string };
		assert.equal(intercomQueue.state, "queued");
		const claimedIntercom = store.dequeueNextQueued({ source: "intercom", limits: { global: 2 }, handlerId: "handler-intercom", now: 4_000 });
		assert.equal(claimedIntercom.disposition, "handler-starting");
		assert.equal(claimedIntercom.handlerId, "handler-intercom");
	});
});

test("dequeueNextQueued attaches queued updates if an active handler appeared", async () => {
	await withStore((store) => {
		const first = makeEnvelope({ eventId: "return_on:queued-attach-1", workKey: "return_on:parent-1:job:queued-attach", createdAt: 1_000 });
		const queued = store.routeEvent(first, { limits: { global: 0 }, now: 1_000 });
		const second = makeEnvelope({ eventId: "return_on:queued-attach-2", workKey: first.workKey, createdAt: 1_100 });
		store.routeEvent(second, { limits: { global: 0 }, now: 1_100 });
		store.db.prepare("INSERT INTO handlers(handler_id, parent_namespace, source, work_key, root_event_id, root_work_key, state, generation, fork_depth, updated_at, started_at) VALUES ('handler-existing', ?, ?, ?, ?, ?, 'handler-running', 1, 0, 1_200, 1_200)")
			.run(first.parentNamespace, first.source, first.workKey, first.eventId, first.workKey);
		const attached = store.dequeueNextQueued({ now: 1_300 });
		assert.equal(attached.disposition, "attached-to-handler");
		assert.equal(attached.queueId, queued.queueId);
		assert.equal(attached.handlerId, "handler-existing");
		assert.deepEqual(attached.eventIds, ["return_on:queued-attach-1", "return_on:queued-attach-2"]);
		assert.equal(attached.updateSeqStart, 1);
		assert.equal(attached.updateSeqEnd, 2);
		const updates = store.db.prepare("SELECT seq, event_id FROM updates WHERE handler_id = 'handler-existing' ORDER BY seq").all() as Array<{ seq: number; event_id: string }>;
		assert.deepEqual(updates.map((row) => ({ seq: row.seq, event_id: row.event_id })), [{ seq: 1, event_id: "return_on:queued-attach-1" }, { seq: 2, event_id: "return_on:queued-attach-2" }]);
	});
});

test("releaseSlots is idempotent across all reserved scopes", async () => {
	await withStore((store) => {
		const event = makeEnvelope({ eventId: "return_on:release", workKey: "return_on:parent-1:job:fired" });
		store.routeEvent(event, { handlerId: "handler-1" });
		const first = store.releaseSlots("handler-1");
		assert.ok(first.includes("global"));
		const second = store.releaseSlots("handler-1");
		assert.deepEqual(second, []);
		const rows = store.db.prepare("SELECT used FROM slots").all() as Array<{ used: number }>;
		assert.equal(rows.every((row) => row.used === 0), true);
	});
});

test("failHandlerLaunch releases slots and requeues handler-starting work", async () => {
	await withStore((store) => {
		const event = makeEnvelope({ eventId: "return_on:launch-fail", workKey: "return_on:parent-1:job:launch-fail" });
		store.routeEvent(event, { handlerId: "handler-launch-fail", now: 1_000 });
		const result = store.failHandlerLaunch("handler-launch-fail", { error: "spawn ENOENT", now: 1_100 });
		assert.equal(result?.requeued, true);
		assert.ok(result?.queueId?.startsWith("beq_"));
		const slots = store.db.prepare("SELECT used FROM slots").all() as Array<{ used: number }>;
		assert.equal(slots.every((row) => row.used === 0), true);
		const handler = store.db.prepare("SELECT state FROM handlers WHERE handler_id = 'handler-launch-fail'").get() as { state: string };
		assert.equal(handler.state, "failed");
		const eventRow = store.db.prepare("SELECT state FROM events WHERE event_id = 'return_on:launch-fail'").get() as { state: string };
		assert.equal(eventRow.state, "queued");
		const bundleBeforeDequeue = store.getHandlerLaunchBundle("handler-launch-fail");
		assert.deepEqual(bundleBeforeDequeue?.events.map((row) => row.eventId), ["return_on:launch-fail"]);
		const dequeued = store.dequeueNextQueued({ handlerId: "handler-retry", now: 1_200 });
		assert.equal(dequeued.disposition, "handler-starting");
		assert.deepEqual(store.getHandlerLaunchBundle("handler-retry")?.events.map((row) => row.eventId), ["return_on:launch-fail"]);
	});
});

test("failHandlerLaunch can fail work without requeue", async () => {
	await withStore((store) => {
		const event = makeEnvelope({ eventId: "return_on:launch-fail-terminal", workKey: "return_on:parent-1:job:launch-fail-terminal" });
		store.routeEvent(event, { handlerId: "handler-launch-fail-terminal", now: 1_000 });
		assert.deepEqual(store.failHandlerLaunch("handler-launch-fail-terminal", { requeue: false, now: 1_100 }), { handlerId: "handler-launch-fail-terminal", requeued: false });
		const eventRow = store.db.prepare("SELECT state FROM events WHERE event_id = 'return_on:launch-fail-terminal'").get() as { state: string };
		const workItem = store.db.prepare("SELECT state, active_handler_id FROM work_items WHERE work_key = ?").get(event.workKey) as { state: string; active_handler_id: string | null };
		assert.equal(eventRow.state, "failed");
		assert.deepEqual({ state: workItem.state, active_handler_id: workItem.active_handler_id }, { state: "failed", active_handler_id: null });
		assert.equal(store.failHandlerLaunch("missing"), undefined);
	});
});

test("handler heartbeat lifecycle releases slots and records one delivered work result", async () => {
	await withStore((store) => {
		const event = makeEnvelope({ eventId: "return_on:lifecycle", workKey: "return_on:parent-1:job:lifecycle" });
		store.routeEvent(event, { handlerId: "handler-1" });
		store.markHandlerRunning("handler-1", { pid: 12345, supervisorPid: 222, leaseMs: 1_000, now: 1_000 });
		let handler = store.db.prepare("SELECT state, heartbeat_at, lease_expires_at FROM handlers WHERE handler_id = 'handler-1'").get() as { state: string; heartbeat_at: number; lease_expires_at: number };
		assert.equal(handler.state, "handler-running");
		assert.equal(handler.heartbeat_at, 1_000);
		assert.equal(handler.lease_expires_at, 2_000);
		assert.equal(store.heartbeatHandler("handler-1", { leaseMs: 1_000, now: 1_500 }), true);
		handler = store.db.prepare("SELECT state, heartbeat_at, lease_expires_at FROM handlers WHERE handler_id = 'handler-1'").get() as { state: string; heartbeat_at: number; lease_expires_at: number };
		assert.equal(handler.heartbeat_at, 1_500);
		assert.equal(handler.lease_expires_at, 2_500);
		const resultId = store.completeHandler("handler-1", { summaryPath: "/tmp/summary.md", now: 2_000 });
		assert.ok(resultId?.startsWith("ber_"));
		const slots = store.db.prepare("SELECT used FROM slots").all() as Array<{ used: number }>;
		assert.equal(slots.every((row) => row.used === 0), true);
		const duplicateResult = store.completeHandler("handler-1", { summaryPath: "/tmp/summary-2.md", now: 3_000 });
		assert.equal(duplicateResult, resultId);
		const results = store.db.prepare("SELECT result_id, summary_path FROM results").all() as Array<{ result_id: string; summary_path: string }>;
		assert.equal(results.length, 1);
		assert.equal(results[0]?.summary_path, "/tmp/summary-2.md");
	});
});

test("reconciler lease is exclusive until expiry", async () => {
	await withStore((store) => {
		assert.equal(store.acquireReconcilerLease("main", "owner-a", 1_000, 1_000), true);
		assert.equal(store.acquireReconcilerLease("main", "owner-b", 1_000, 1_500), false);
		assert.equal(store.acquireReconcilerLease("main", "owner-b", 1_000, 2_001), true);
	});
});

test("stale reconciliation releases slots only after process is not alive", async () => {
	await withStore((store) => {
		const event = makeEnvelope({ eventId: "return_on:stale", workKey: "return_on:parent-1:job:stale" });
		store.routeEvent(event, { handlerId: "handler-1" });
		store.markHandlerRunning("handler-1", { pid: 42, leaseMs: 100, now: 1_000 });
		assert.deepEqual(store.reconcileStaleHandlers({ now: 1_200, isProcessAlive: () => true }), []);
		let slots = store.db.prepare("SELECT used FROM slots").all() as Array<{ used: number }>;
		assert.equal(slots.every((row) => row.used === 1), true);
		assert.deepEqual(store.reconcileStaleHandlers({ now: 1_300, isProcessAlive: () => false }), ["handler-1"]);
		slots = store.db.prepare("SELECT used FROM slots").all() as Array<{ used: number }>;
		assert.equal(slots.every((row) => row.used === 0), true);
		const handler = store.db.prepare("SELECT state FROM handlers WHERE handler_id = 'handler-1'").get() as { state: string };
		assert.equal(handler.state, "stale");
	});
});

test("runReconcilerPass leases, marks stale handlers, and dequeues freed work", async () => {
	await withStore((store) => {
		store.routeEvent(makeEnvelope({ eventId: "return_on:reconcile-active", workKey: "return_on:parent-1:job:reconcile-active" }), { handlerId: "handler-active", limits: { global: 1 }, now: 1_000 });
		store.markHandlerRunning("handler-active", { pid: 42, leaseMs: 100, now: 1_000 });
		store.routeEvent(makeEnvelope({ eventId: "return_on:reconcile-queued", workKey: "return_on:parent-1:job:reconcile-queued" }), { limits: { global: 1 }, now: 1_050 });
		store.acquireReconcilerLease("main", "owner-a", 1_000, 1_100);
		assert.deepEqual(store.runReconcilerPass({ leaseName: "main", ownerId: "owner-b", leaseTtlMs: 1_000, now: 1_200 }), { leaseAcquired: false, staleHandlers: [], dequeued: [], launchBundles: [] });
		const pass = store.runReconcilerPass({ leaseName: "main", ownerId: "owner-b", leaseTtlMs: 1_000, now: 2_200, dequeueLimit: 2, limits: { global: 1 }, isProcessAlive: () => false });
		assert.equal(pass.leaseAcquired, true);
		assert.deepEqual(pass.staleHandlers, ["handler-active"]);
		assert.equal(pass.dequeued.length, 1);
		assert.equal(pass.dequeued[0]?.disposition, "handler-starting");
		assert.deepEqual(pass.dequeued[0]?.eventIds, ["return_on:reconcile-queued"]);
		assert.equal(pass.launchBundles.length, 1);
		assert.equal(pass.launchBundles[0]?.handlerId, pass.dequeued[0]?.handlerId);
		assert.deepEqual(pass.launchBundles[0]?.events.map((event) => event.eventId), ["return_on:reconcile-queued"]);
	});
});

test("canAutoFork blocks max-depth and lineage fork budget", async () => {
	await withStore((store) => {
		assert.deepEqual(store.canAutoFork({ forkDepth: 1, maxForkDepth: 1 }), { allowed: false, reason: "max-depth" });
		store.db.prepare("INSERT INTO lineage_budgets(lineage_id, max_forkable_followups, used_forkable_followups, updated_at) VALUES ('lin-1', 0, 0, 1)").run();
		assert.deepEqual(store.canAutoFork({ forkDepth: 0, maxForkDepth: 1, lineageId: "lin-1" }), { allowed: false, reason: "lineage-fork-budget" });
		assert.deepEqual(store.canAutoFork({ forkDepth: 0, maxForkDepth: 1, lineageId: "lin-1", forkable: false }), { allowed: true });
	});
});

test("routeEvent registers origin lineage metadata for later budget enforcement", async () => {
	await withStore((store) => {
		const event = makeEnvelope({
			eventId: "return_on:lineage-route",
			workKey: "return_on:parent-1:job:lineage-route",
			origin: { lineageId: "lin-route", rootEventId: "return_on:root", rootWorkKey: "root-work", handlerId: "handler-root" },
		});
		store.routeEvent(event, { handlerId: "handler-lineage" });
		const row = store.db.prepare("SELECT root_event_id, root_work_key, origin_handler_id FROM lineage_budgets WHERE lineage_id = 'lin-route'").get() as { root_event_id: string; root_work_key: string; origin_handler_id: string };
		assert.deepEqual({ root_event_id: row.root_event_id, root_work_key: row.root_work_key, origin_handler_id: row.origin_handler_id }, { root_event_id: "return_on:root", root_work_key: "root-work", origin_handler_id: "handler-root" });
	});
});

test("lineage budgets charge followups and forkable followups deterministically", async () => {
	await withStore((store) => {
		store.upsertLineageBudget({ lineageId: "lin-budget", rootEventId: "return_on:root", rootWorkKey: "root-work", originHandlerId: "handler-root", maxFollowups: 2, maxForkableFollowups: 1, now: 1_000 });
		assert.deepEqual(store.chargeLineageFollowup({ lineageId: "lin-budget", forkable: false, now: 1_100 }), { allowed: true });
		assert.deepEqual(store.chargeLineageFollowup({ lineageId: "lin-budget", forkable: true, now: 1_200 }), { allowed: true });
		assert.deepEqual(store.chargeLineageFollowup({ lineageId: "lin-budget", forkable: false, now: 1_300 }), { allowed: false, reason: "lineage-followup-budget" });
		const row = store.db.prepare("SELECT used_followups, used_forkable_followups FROM lineage_budgets WHERE lineage_id = 'lin-budget'").get() as { used_followups: number; used_forkable_followups: number };
		assert.deepEqual({ used_followups: row.used_followups, used_forkable_followups: row.used_forkable_followups }, { used_followups: 2, used_forkable_followups: 1 });
		store.upsertLineageBudget({ lineageId: "lin-no-forks", maxFollowups: 3, maxForkableFollowups: 0 });
		assert.deepEqual(store.chargeLineageFollowup({ lineageId: "lin-no-forks", forkable: true }), { allowed: false, reason: "lineage-fork-budget" });
	});
});

test("chargeAutoForkForLineage atomically registers gates and charges handler-origin forks", async () => {
	await withStore((store) => {
		assert.deepEqual(store.chargeAutoForkForLineage({ lineageId: "lin-auto", rootEventId: "return_on:root", rootWorkKey: "root-work", originHandlerId: "handler-root", maxFollowups: 3, maxForkableFollowups: 1, forkDepth: 0, maxForkDepth: 1, now: 1_000 }), { allowed: true });
		assert.deepEqual(store.chargeAutoForkForLineage({ lineageId: "lin-auto", forkDepth: 0, maxForkDepth: 1, now: 1_100 }), { allowed: false, reason: "lineage-fork-budget" });
		assert.deepEqual(store.chargeAutoForkForLineage({ lineageId: "lin-depth", forkDepth: 1, maxForkDepth: 1, now: 1_200 }), { allowed: false, reason: "max-depth" });
		const row = store.db.prepare("SELECT root_event_id, root_work_key, origin_handler_id, used_followups, used_forkable_followups FROM lineage_budgets WHERE lineage_id = 'lin-auto'").get() as { root_event_id: string; root_work_key: string; origin_handler_id: string; used_followups: number; used_forkable_followups: number };
		assert.deepEqual({ ...row }, { root_event_id: "return_on:root", root_work_key: "root-work", origin_handler_id: "handler-root", used_followups: 1, used_forkable_followups: 1 });
	});
});

test("router guardrails are disabled by default and reject forbidden or rail-blocked decisions", () => {
	assert.deepEqual(applyRouterGuardrails({ fallback: "wake_main", decision: "fork" }), { decision: "wake_main", reason: "disabled" });
	assert.deepEqual(applyRouterGuardrails({ enabled: true, fallback: "wake_main", decision: "drop" }), { decision: "wake_main", reason: "forbidden" });
	assert.deepEqual(applyRouterGuardrails({ enabled: true, fallback: "display", decision: "attach" }), { decision: "display", reason: "forbidden" });
	assert.deepEqual(applyRouterGuardrails({ enabled: true, fallback: "queue", decision: "fork", railsAllowed: ["queue", "display"] }), { decision: "queue", reason: "rails-blocked" });
	assert.deepEqual(applyRouterGuardrails({ enabled: true, fallback: "wake_main", decision: "queue", railsAllowed: ["queue", "display"] }), { decision: "queue", reason: "accepted" });
	assert.equal(isForbiddenRouterDecision("override_depth"), true);
	assert.equal(isForbiddenRouterDecision("fork"), false);
});

test("optional router config is default-off and invocation is bounded by deterministic rails", async () => {
	assert.deepEqual(resolveBackgroundRouterConfig({}, { PI_BACKGROUND_ROUTER_ENABLED: "true", PI_BACKGROUND_ROUTER_TIMEOUT_MS: "5", PI_BACKGROUND_ROUTER_MODEL: "tiny", PI_BACKGROUND_ROUTER_ONLY_WHEN_AMBIGUOUS: "false" }), {
		enabled: true,
		model: "tiny",
		timeoutMs: 5,
		fallback: "deterministic",
		onlyWhenAmbiguous: false,
	});
	assert.deepEqual(await runOptionalRouterDecision({ fallback: "wake_main", decide: () => "fork" }), { decision: "wake_main", reason: "disabled" });
	assert.deepEqual(await runOptionalRouterDecision({ config: { enabled: true }, fallback: "wake_main", ambiguous: false, decide: () => "fork" }), { decision: "wake_main", reason: "not-ambiguous" });
	assert.deepEqual(await runOptionalRouterDecision({ config: { enabled: true, onlyWhenAmbiguous: false }, fallback: "queue", railsAllowed: ["queue"], decide: () => "fork" }), { decision: "queue", reason: "rails-blocked" });
	assert.deepEqual(await runOptionalRouterDecision({ config: { enabled: true, onlyWhenAmbiguous: false }, fallback: "wake_main", railsAllowed: ["fork", "wake_main"], decide: () => "fork" }), { decision: "fork", reason: "accepted" });
	assert.deepEqual(await runOptionalRouterDecision({ config: { enabled: true, onlyWhenAmbiguous: false, timeoutMs: 1 }, fallback: "display", decide: () => new Promise((resolve) => setTimeout(() => resolve("fork"), 20)) }), { decision: "display", reason: "timeout" });
});

test("snapshotPayload copies immutable payload and hashes copied content", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-background-events-snapshot-"));
	try {
		const source = path.join(dir, "source.json");
		const eventDir = path.join(dir, "event");
		await fs.writeFile(source, "original", "utf8");
		const snapshot = await snapshotPayload(source, eventDir);
		await fs.writeFile(source, "mutated", "utf8");
		assert.equal(await fs.readFile(snapshot.path, "utf8"), "original");
		assert.equal(snapshot.bytes, Buffer.byteLength("original"));
		assert.equal(snapshot.sha256.length, 64);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
