import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type BackgroundEventSource = "return_on" | "intercom" | "subagents";
export type BackgroundPriority = "low" | "normal" | "high";
export type BackgroundEventState = "pending" | "queued" | "attached-to-handler" | "handler-starting" | "failed";
export type RouteDisposition = "handler-starting" | "attached-to-handler" | "queued" | "existing";
export type DequeueDisposition = "handler-starting" | "attached-to-handler" | "empty" | "blocked";
export type BackgroundRouterDecision = "fork" | "wake_main" | "display" | "queue";
export type BackgroundRouterForbiddenDecision = "drop" | "attach" | "override_limits" | "override_depth";

export interface BackgroundParentRef {
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	intercomTarget?: string;
	cwd: string;
}

export interface BackgroundEventEnvelope {
	version: 1;
	source: BackgroundEventSource;
	eventId: string;
	workKey: string;
	parentNamespace: string;
	parent: BackgroundParentRef;
	createdAt: number;
	priority: BackgroundPriority;
	payloadPath: string;
	payloadSha256: string;
	payloadBytes: number;
	expectedReply?: boolean;
	needsDecision?: boolean;
	eventType?: string;
	origin?: {
		forkDepth?: number;
		handlerId?: string;
		rootEventId?: string;
		rootWorkKey?: string;
		lineageId?: string;
	};
}

export interface SlotLimitConfig {
	global?: number;
	parent?: number;
	source?: Partial<Record<BackgroundEventSource, number>>;
	parentSource?: Partial<Record<BackgroundEventSource, number>>;
	root?: number;
}

export interface RouteEventOptions {
	limits?: SlotLimitConfig;
	overflow?: "queue" | "fail";
	now?: number;
	handlerId?: string;
}

export interface RouteEventResult {
	disposition: RouteDisposition;
	eventId: string;
	workKey: string;
	handlerId?: string;
	queueId?: string;
	updateSeq?: number;
	existingState?: string;
}

export interface DequeueQueuedOptions {
	limits?: SlotLimitConfig;
	now?: number;
	handlerId?: string;
	source?: BackgroundEventSource;
}

export interface DequeueQueuedResult {
	disposition: DequeueDisposition;
	queueId?: string;
	workKey?: string;
	handlerId?: string;
	eventIds?: string[];
	updateSeqStart?: number;
	updateSeqEnd?: number;
}

export interface HandlerLaunchEvent {
	eventId: string;
	payloadPath: string;
	payloadSha256: string;
	payloadBytes: number;
	state: string;
}

export interface HandlerLaunchBundle {
	handlerId: string;
	parentNamespace: string;
	source: BackgroundEventSource;
	workKey: string;
	rootEventId: string;
	rootWorkKey: string;
	generation: number;
	state: string;
	events: HandlerLaunchEvent[];
}

export interface FailHandlerLaunchOptions {
	requeue?: boolean;
	now?: number;
	error?: string;
}

export interface FailHandlerLaunchResult {
	handlerId: string;
	requeued: boolean;
	queueId?: string;
}

export interface ReconcilerPassOptions {
	leaseName: string;
	ownerId: string;
	leaseTtlMs: number;
	now?: number;
	dequeueLimit?: number;
	limits?: SlotLimitConfig;
	source?: BackgroundEventSource;
	isProcessAlive?: (pid: number) => boolean;
}

export interface ReconcilerPassResult {
	leaseAcquired: boolean;
	staleHandlers: string[];
	dequeued: DequeueQueuedResult[];
	launchBundles: HandlerLaunchBundle[];
}

export interface PayloadSnapshot {
	path: string;
	sha256: string;
	bytes: number;
}

export interface LineageBudgetInput {
	lineageId: string;
	rootEventId?: string;
	rootWorkKey?: string;
	originHandlerId?: string;
	maxFollowups?: number;
	maxForkableFollowups?: number;
	now?: number;
}

export interface ChargeLineageInput {
	lineageId: string;
	forkable?: boolean;
	now?: number;
}

export interface ChargeAutoForkLineageInput extends LineageBudgetInput {
	forkDepth?: number;
	maxForkDepth?: number;
	forkable?: boolean;
}

export interface RouterGuardrailsInput {
	enabled?: boolean;
	decision?: unknown;
	fallback: BackgroundRouterDecision;
	railsAllowed?: BackgroundRouterDecision[];
}

export interface BackgroundRouterConfig {
	enabled: boolean;
	model?: string;
	timeoutMs: number;
	fallback: "deterministic";
	onlyWhenAmbiguous: boolean;
}

export interface OptionalRouterDecisionInput {
	config?: Partial<BackgroundRouterConfig>;
	fallback: BackgroundRouterDecision;
	railsAllowed?: BackgroundRouterDecision[];
	ambiguous?: boolean;
	decide?: (input: { fallback: BackgroundRouterDecision; railsAllowed?: BackgroundRouterDecision[] }) => Promise<unknown> | unknown;
}

const DEFAULT_ROUTER_CONFIG: BackgroundRouterConfig = {
	enabled: false,
	timeoutMs: 12_000,
	fallback: "deterministic",
	onlyWhenAmbiguous: true,
};

const DEFAULT_LIMITS: Required<SlotLimitConfig> = {
	global: 12,
	parent: 4,
	source: { intercom: 2, return_on: 4, subagents: 4 },
	parentSource: { intercom: 2, return_on: 4, subagents: 4 },
	root: 3,
};

function expandHome(input: string, homeDir = os.homedir()): string {
	return input === "~" || input.startsWith("~/") ? path.join(homeDir, input.slice(2)) : input;
}

export function resolveBackgroundStateRoot(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
	const configured = env.PI_BACKGROUND_STATE_DIR?.trim() || env.PI_FORKS_STATE_ROOT?.trim();
	return configured ? path.resolve(expandHome(configured, homeDir)) : path.join(homeDir, ".local", "state", "pi-background-events");
}

export function getBackgroundEventsDbPath(rootDir = resolveBackgroundStateRoot()): string {
	return path.join(rootDir, "background-events.sqlite");
}

export function namespacedEventId(source: BackgroundEventSource, durableId: string): string {
	const trimmed = durableId.trim();
	if (!trimmed) throw new Error("durable event id must not be empty");
	return trimmed.startsWith(`${source}:`) ? trimmed : `${source}:${trimmed}`;
}

export function assertNamespacedEventId(source: BackgroundEventSource, eventId: string): void {
	if (!eventId.startsWith(`${source}:`)) throw new Error(`eventId '${eventId}' must be globally source-namespaced with '${source}:'`);
}

function priorityRank(priority: BackgroundPriority): number {
	return priority === "high" ? 3 : priority === "normal" ? 2 : 1;
}

function highestPriority(a: BackgroundPriority, b: BackgroundPriority): BackgroundPriority {
	return priorityRank(b) > priorityRank(a) ? b : a;
}

const ROUTER_ALLOWED_DECISIONS = new Set<BackgroundRouterDecision>(["fork", "wake_main", "display", "queue"]);
const ROUTER_FORBIDDEN_DECISIONS = new Set<BackgroundRouterForbiddenDecision>(["drop", "attach", "override_limits", "override_depth"]);

export function parseRouterDecision(decision: unknown): BackgroundRouterDecision | undefined {
	if (typeof decision !== "string") return undefined;
	return ROUTER_ALLOWED_DECISIONS.has(decision as BackgroundRouterDecision) ? decision as BackgroundRouterDecision : undefined;
}

export function isForbiddenRouterDecision(decision: unknown): decision is BackgroundRouterForbiddenDecision {
	return typeof decision === "string" && ROUTER_FORBIDDEN_DECISIONS.has(decision as BackgroundRouterForbiddenDecision);
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function resolveBackgroundRouterConfig(input: Partial<BackgroundRouterConfig> = {}, env: NodeJS.ProcessEnv = process.env): BackgroundRouterConfig {
	const enabled = input.enabled ?? parseBooleanEnv(env.PI_BACKGROUND_ROUTER_ENABLED) ?? DEFAULT_ROUTER_CONFIG.enabled;
	const onlyWhenAmbiguous = input.onlyWhenAmbiguous ?? parseBooleanEnv(env.PI_BACKGROUND_ROUTER_ONLY_WHEN_AMBIGUOUS) ?? DEFAULT_ROUTER_CONFIG.onlyWhenAmbiguous;
	const timeoutMs = positiveInteger(input.timeoutMs ?? env.PI_BACKGROUND_ROUTER_TIMEOUT_MS, DEFAULT_ROUTER_CONFIG.timeoutMs);
	const model = input.model ?? env.PI_BACKGROUND_ROUTER_MODEL;
	return {
		enabled,
		...(model?.trim() ? { model: model.trim() } : {}),
		timeoutMs,
		fallback: "deterministic",
		onlyWhenAmbiguous,
	};
}

export async function runOptionalRouterDecision(input: OptionalRouterDecisionInput): Promise<{ decision: BackgroundRouterDecision; reason: "disabled" | "invalid" | "forbidden" | "rails-blocked" | "accepted" | "not-ambiguous" | "timeout" | "error" }> {
	const config = resolveBackgroundRouterConfig(input.config);
	if (!config.enabled) return { decision: input.fallback, reason: "disabled" };
	if (config.onlyWhenAmbiguous && input.ambiguous !== true) return { decision: input.fallback, reason: "not-ambiguous" };
	if (!input.decide) return { decision: input.fallback, reason: "disabled" };
	try {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<"__timeout__">((resolve) => {
			timer = setTimeout(() => resolve("__timeout__"), config.timeoutMs);
			timer.unref?.();
		});
		const raw = await Promise.race([Promise.resolve(input.decide({ fallback: input.fallback, railsAllowed: input.railsAllowed })), timeout]);
		if (timer) clearTimeout(timer);
		if (raw === "__timeout__") return { decision: input.fallback, reason: "timeout" };
		return applyRouterGuardrails({ enabled: true, decision: raw, fallback: input.fallback, railsAllowed: input.railsAllowed });
	} catch {
		return { decision: input.fallback, reason: "error" };
	}
}

export function applyRouterGuardrails(input: RouterGuardrailsInput): { decision: BackgroundRouterDecision; reason: "disabled" | "invalid" | "forbidden" | "rails-blocked" | "accepted" } {
	if (!input.enabled) return { decision: input.fallback, reason: "disabled" };
	if (isForbiddenRouterDecision(input.decision)) return { decision: input.fallback, reason: "forbidden" };
	const parsed = parseRouterDecision(input.decision);
	if (!parsed) return { decision: input.fallback, reason: "invalid" };
	if (input.railsAllowed && !input.railsAllowed.includes(parsed)) return { decision: input.fallback, reason: "rails-blocked" };
	return { decision: parsed, reason: "accepted" };
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function snapshotPayload(inputPath: string, eventDir: string, options: { maxBytes?: number } = {}): Promise<PayloadSnapshot> {
	const realInput = await fsp.realpath(inputPath);
	const stat = await fsp.stat(realInput);
	if (!stat.isFile()) throw new Error(`payload is not a file: ${inputPath}`);
	const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
	if (stat.size > maxBytes) throw new Error(`payload exceeds max snapshot size (${stat.size} > ${maxBytes}): ${inputPath}`);
	await fsp.mkdir(eventDir, { recursive: true, mode: 0o700 });
	const target = path.join(eventDir, path.basename(inputPath));
	await fsp.copyFile(realInput, target);
	const data = await fsp.readFile(target);
	return { path: target, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.byteLength };
}

export class BackgroundEventsStore {
	readonly db: DatabaseSync;
	readonly dbPath: string;

	constructor(dbPath = getBackgroundEventsDbPath()) {
		this.dbPath = dbPath;
		fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
		// Set the open timeout before any PRAGMA/migration work. Monitor/status paths
		// can instantiate the store while another handler owns a write lock; without
		// a constructor timeout the first PRAGMA can throw SQLITE_BUSY immediately.
		this.db = new DatabaseSync(dbPath, { timeout: 5_000 });
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.migrate();
	}

	close(): void {
		this.db.close();
	}

	migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS parents(
				parent_namespace TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				session_file TEXT,
				session_name TEXT,
				intercom_target TEXT,
				cwd TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS events(
				event_id TEXT PRIMARY KEY,
				parent_namespace TEXT NOT NULL,
				source TEXT NOT NULL,
				work_key TEXT NOT NULL,
				state TEXT NOT NULL,
				priority TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				payload_path TEXT NOT NULL,
				payload_sha256 TEXT NOT NULL,
				payload_bytes INTEGER NOT NULL,
				expected_reply INTEGER,
				needs_decision INTEGER,
				event_type TEXT,
				root_event_id TEXT,
				root_work_key TEXT,
				lineage_id TEXT,
				origin_handler_id TEXT
			);
			CREATE TABLE IF NOT EXISTS work_items(
				parent_namespace TEXT NOT NULL,
				source TEXT NOT NULL,
				work_key TEXT NOT NULL,
				state TEXT NOT NULL,
				active_handler_id TEXT,
				queue_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY(parent_namespace, source, work_key)
			);
			CREATE TABLE IF NOT EXISTS handlers(
				handler_id TEXT PRIMARY KEY,
				parent_namespace TEXT NOT NULL,
				source TEXT NOT NULL,
				work_key TEXT NOT NULL,
				root_event_id TEXT NOT NULL,
				root_work_key TEXT NOT NULL,
				state TEXT NOT NULL,
				pid INTEGER,
				pid_start_time INTEGER,
				supervisor_pid INTEGER,
				supervisor_pid_start_time INTEGER,
				process_group_id INTEGER,
				generation INTEGER NOT NULL,
				lease_expires_at INTEGER,
				heartbeat_at INTEGER,
				fork_depth INTEGER NOT NULL,
				session_dir TEXT,
				dir TEXT,
				intercom_target TEXT,
				started_at INTEGER,
				updated_at INTEGER NOT NULL,
				ended_at INTEGER,
				superseded_by_handler_id TEXT
			);
			CREATE UNIQUE INDEX IF NOT EXISTS active_handler_once ON handlers(parent_namespace, source, work_key) WHERE state IN ('claimed','handler-starting','handler-running','closing');
			CREATE TABLE IF NOT EXISTS handler_slot_reservations(
				handler_id TEXT NOT NULL,
				scope TEXT NOT NULL,
				released_at INTEGER,
				PRIMARY KEY(handler_id, scope)
			);
			CREATE TABLE IF NOT EXISTS slots(
				scope TEXT PRIMARY KEY,
				used INTEGER NOT NULL,
				limit_value INTEGER NOT NULL,
				generation INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS queue(
				queue_id TEXT PRIMARY KEY,
				parent_namespace TEXT NOT NULL,
				source TEXT NOT NULL,
				work_key TEXT NOT NULL,
				priority TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				state TEXT NOT NULL
			);
			CREATE UNIQUE INDEX IF NOT EXISTS queued_work_once ON queue(parent_namespace, source, work_key) WHERE state='queued';
			CREATE TABLE IF NOT EXISTS queued_events(
				queue_id TEXT NOT NULL,
				event_id TEXT NOT NULL,
				PRIMARY KEY(queue_id, event_id)
			);
			CREATE TABLE IF NOT EXISTS updates(
				handler_id TEXT NOT NULL,
				seq INTEGER NOT NULL,
				event_id TEXT NOT NULL,
				work_key TEXT NOT NULL,
				payload_path TEXT NOT NULL,
				payload_sha256 TEXT NOT NULL,
				attached_at INTEGER NOT NULL,
				attach_transport TEXT NOT NULL,
				PRIMARY KEY(handler_id, seq)
			);
			CREATE TABLE IF NOT EXISTS results(
				result_id TEXT PRIMARY KEY,
				handler_id TEXT NOT NULL,
				root_event_id TEXT NOT NULL,
				root_work_key TEXT NOT NULL,
				work_key TEXT NOT NULL,
				generation INTEGER NOT NULL,
				status TEXT NOT NULL,
				summary_path TEXT NOT NULL,
				included_event_ids_json TEXT NOT NULL,
				included_seq_start INTEGER,
				included_seq_end INTEGER,
				excluded_late_event_ids_json TEXT,
				ack_key TEXT NOT NULL UNIQUE,
				delivery_state TEXT NOT NULL,
				attempts INTEGER NOT NULL,
				next_attempt_at INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS work_results(
				parent_namespace TEXT NOT NULL,
				source TEXT NOT NULL,
				work_key TEXT NOT NULL,
				delivered_result_id TEXT,
				delivered_generation INTEGER,
				delivered_at INTEGER,
				PRIMARY KEY(parent_namespace, source, work_key)
			);
			CREATE TABLE IF NOT EXISTS lineage_budgets(
				lineage_id TEXT PRIMARY KEY,
				root_event_id TEXT,
				root_work_key TEXT,
				origin_handler_id TEXT,
				max_followups INTEGER,
				used_followups INTEGER NOT NULL DEFAULT 0,
				max_forkable_followups INTEGER,
				used_forkable_followups INTEGER NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS reconciler_leases(
				lease_name TEXT PRIMARY KEY,
				owner_id TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				heartbeat_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS audit(
				audit_id TEXT PRIMARY KEY,
				at INTEGER NOT NULL,
				actor_id TEXT NOT NULL,
				transition_name TEXT NOT NULL,
				parent_namespace TEXT,
				source TEXT,
				work_key TEXT,
				event_id TEXT,
				handler_id TEXT,
				details_json TEXT
			);
		`);
	}

	routeEvent(envelope: BackgroundEventEnvelope, options: RouteEventOptions = {}): RouteEventResult {
		assertNamespacedEventId(envelope.source, envelope.eventId);
		if (!envelope.parentNamespace || envelope.parentNamespace !== envelope.parent.sessionId) throw new Error("parentNamespace must be the stable parent session id");
		const now = options.now ?? Date.now();
		const overflow = options.overflow ?? "queue";
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.upsertParent(envelope, now);
			const existingEvent = this.db.prepare("SELECT state, work_key FROM events WHERE event_id = ?").get(envelope.eventId) as { state: string; work_key: string } | undefined;
			if (existingEvent) {
				this.db.exec("COMMIT");
				return { disposition: "existing", eventId: envelope.eventId, workKey: existingEvent.work_key, existingState: existingEvent.state };
			}
			this.insertEvent(envelope, "pending", now);
			this.upsertWorkItem(envelope, now);
			if (envelope.origin?.lineageId) {
				this.upsertLineageBudgetInOpenTransaction({
					lineageId: envelope.origin.lineageId,
					rootEventId: envelope.origin.rootEventId ?? envelope.eventId,
					rootWorkKey: envelope.origin.rootWorkKey ?? envelope.workKey,
					originHandlerId: envelope.origin.handlerId,
					now,
				});
			}

			const active = this.db.prepare("SELECT handler_id FROM handlers WHERE parent_namespace = ? AND source = ? AND work_key = ? AND state IN ('claimed','handler-starting','handler-running','closing') ORDER BY generation DESC LIMIT 1")
				.get(envelope.parentNamespace, envelope.source, envelope.workKey) as { handler_id: string } | undefined;
			if (active) {
				const seq = this.nextUpdateSeq(active.handler_id);
				this.db.prepare("INSERT INTO updates(handler_id, seq, event_id, work_key, payload_path, payload_sha256, attached_at, attach_transport) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
					.run(active.handler_id, seq, envelope.eventId, envelope.workKey, envelope.payloadPath, envelope.payloadSha256, now, "file");
				this.db.prepare("UPDATE events SET state = ?, updated_at = ? WHERE event_id = ?").run("attached-to-handler", now, envelope.eventId);
				this.audit("attached-to-handler", envelope, now, active.handler_id, { seq });
				this.db.exec("COMMIT");
				return { disposition: "attached-to-handler", eventId: envelope.eventId, workKey: envelope.workKey, handlerId: active.handler_id, updateSeq: seq };
			}

			const queued = this.db.prepare("SELECT queue_id FROM queue WHERE parent_namespace = ? AND source = ? AND work_key = ? AND state = 'queued'")
				.get(envelope.parentNamespace, envelope.source, envelope.workKey) as { queue_id: string } | undefined;
			if (queued) {
				const currentQueue = this.db.prepare("SELECT priority FROM queue WHERE queue_id = ?").get(queued.queue_id) as { priority: BackgroundPriority };
				const mergedPriority = highestPriority(currentQueue.priority, envelope.priority);
				this.db.prepare("INSERT OR IGNORE INTO queued_events(queue_id, event_id) VALUES (?, ?)").run(queued.queue_id, envelope.eventId);
				this.db.prepare("UPDATE queue SET priority = ?, updated_at = ? WHERE queue_id = ?").run(mergedPriority, now, queued.queue_id);
				this.db.prepare("UPDATE events SET state = ?, updated_at = ? WHERE event_id = ?").run("queued", now, envelope.eventId);
				this.audit("queued-merge", envelope, now, undefined, { queueId: queued.queue_id, priority: mergedPriority });
				this.db.exec("COMMIT");
				return { disposition: "queued", eventId: envelope.eventId, workKey: envelope.workKey, queueId: queued.queue_id };
			}

			const handlerId = options.handlerId ?? `beh_${randomUUID()}`;
			const scopes = this.slotScopes(envelope);
			if (!this.reserveAllSlots(handlerId, scopes, options.limits ?? {}, now)) {
				if (overflow === "fail") throw new Error("background handler slot limit exceeded");
				const queueId = `beq_${randomUUID()}`;
				this.db.prepare("INSERT INTO queue(queue_id, parent_namespace, source, work_key, priority, created_at, updated_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')")
					.run(queueId, envelope.parentNamespace, envelope.source, envelope.workKey, envelope.priority, now, now);
				this.db.prepare("INSERT INTO queued_events(queue_id, event_id) VALUES (?, ?)").run(queueId, envelope.eventId);
				this.db.prepare("UPDATE events SET state = ?, updated_at = ? WHERE event_id = ?").run("queued", now, envelope.eventId);
				this.db.prepare("UPDATE work_items SET state = ?, queue_id = ?, updated_at = ? WHERE parent_namespace = ? AND source = ? AND work_key = ?")
					.run("queued", queueId, now, envelope.parentNamespace, envelope.source, envelope.workKey);
				this.audit("queued", envelope, now, undefined, { queueId });
				this.db.exec("COMMIT");
				return { disposition: "queued", eventId: envelope.eventId, workKey: envelope.workKey, queueId };
			}

			this.db.prepare("INSERT INTO handlers(handler_id, parent_namespace, source, work_key, root_event_id, root_work_key, state, generation, fork_depth, updated_at, started_at) VALUES (?, ?, ?, ?, ?, ?, 'handler-starting', 1, ?, ?, ?)")
				.run(handlerId, envelope.parentNamespace, envelope.source, envelope.workKey, envelope.origin?.rootEventId ?? envelope.eventId, envelope.origin?.rootWorkKey ?? envelope.workKey, envelope.origin?.forkDepth ?? 0, now, now);
			this.db.prepare("UPDATE events SET state = ?, updated_at = ? WHERE event_id = ?").run("handler-starting", now, envelope.eventId);
			this.db.prepare("UPDATE work_items SET state = ?, active_handler_id = ?, updated_at = ? WHERE parent_namespace = ? AND source = ? AND work_key = ?")
				.run("handler-starting", handlerId, now, envelope.parentNamespace, envelope.source, envelope.workKey);
			this.audit("handler-starting", envelope, now, handlerId, { scopes: scopes.map((scope) => scope.scope) });
			this.db.exec("COMMIT");
			return { disposition: "handler-starting", eventId: envelope.eventId, workKey: envelope.workKey, handlerId };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	dequeueNextQueued(options: DequeueQueuedOptions = {}): DequeueQueuedResult {
		const now = options.now ?? Date.now();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const queued = (options.source
				? this.db.prepare(`
					SELECT queue_id, parent_namespace, source, work_key, priority
					FROM queue
					WHERE state = 'queued' AND source = ?
					ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at, queue_id
					LIMIT 1
				`).get(options.source)
				: this.db.prepare(`
					SELECT queue_id, parent_namespace, source, work_key, priority
					FROM queue
					WHERE state = 'queued'
					ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at, queue_id
					LIMIT 1
				`).get()) as { queue_id: string; parent_namespace: string; source: BackgroundEventSource; work_key: string; priority: BackgroundPriority } | undefined;
			if (!queued) {
				this.db.exec("COMMIT");
				return { disposition: "empty" };
			}

			const active = this.db.prepare("SELECT handler_id FROM handlers WHERE parent_namespace = ? AND source = ? AND work_key = ? AND state IN ('claimed','handler-starting','handler-running','closing') ORDER BY generation DESC LIMIT 1")
				.get(queued.parent_namespace, queued.source, queued.work_key) as { handler_id: string } | undefined;
			const eventRows = this.db.prepare(`
				SELECT e.event_id, e.payload_path, e.payload_sha256
				FROM queued_events qe
				JOIN events e ON e.event_id = qe.event_id
				WHERE qe.queue_id = ?
				ORDER BY e.created_at, e.event_id
			`).all(queued.queue_id) as Array<{ event_id: string; payload_path: string; payload_sha256: string }>;
			if (active) {
				let firstSeq: number | undefined;
				let lastSeq: number | undefined;
				for (const row of eventRows) {
					const seq = this.nextUpdateSeq(active.handler_id);
					firstSeq ??= seq;
					lastSeq = seq;
					this.db.prepare("INSERT INTO updates(handler_id, seq, event_id, work_key, payload_path, payload_sha256, attached_at, attach_transport) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
						.run(active.handler_id, seq, row.event_id, queued.work_key, row.payload_path, row.payload_sha256, now, "file");
					this.db.prepare("UPDATE events SET state = ?, updated_at = ? WHERE event_id = ?").run("attached-to-handler", now, row.event_id);
				}
				this.db.prepare("UPDATE queue SET state = ?, updated_at = ? WHERE queue_id = ?").run("attached-to-handler", now, queued.queue_id);
				this.db.prepare("UPDATE work_items SET state = ?, active_handler_id = ?, queue_id = NULL, updated_at = ? WHERE parent_namespace = ? AND source = ? AND work_key = ?")
					.run("handler-starting", active.handler_id, now, queued.parent_namespace, queued.source, queued.work_key);
				this.auditQueued("queued-attached-to-handler", queued, now, active.handler_id, { eventIds: eventRows.map((row) => row.event_id), seqStart: firstSeq, seqEnd: lastSeq });
				this.db.exec("COMMIT");
				return { disposition: "attached-to-handler", queueId: queued.queue_id, workKey: queued.work_key, handlerId: active.handler_id, eventIds: eventRows.map((row) => row.event_id), updateSeqStart: firstSeq, updateSeqEnd: lastSeq };
			}

			const firstEvent = this.db.prepare(`
				SELECT event_id, root_event_id, root_work_key, lineage_id
				FROM events
				WHERE event_id IN (SELECT event_id FROM queued_events WHERE queue_id = ?)
				ORDER BY created_at, event_id
				LIMIT 1
			`).get(queued.queue_id) as { event_id: string; root_event_id: string | null; root_work_key: string | null; lineage_id: string | null } | undefined;
			if (!firstEvent) {
				this.db.prepare("UPDATE queue SET state = ?, updated_at = ? WHERE queue_id = ?").run("failed", now, queued.queue_id);
				this.auditQueued("queued-empty-failed", queued, now, undefined, {});
				this.db.exec("COMMIT");
				return { disposition: "empty", queueId: queued.queue_id, workKey: queued.work_key };
			}

			const handlerId = options.handlerId ?? `beh_${randomUUID()}`;
			const scopes = this.slotScopesFor(queued.parent_namespace, queued.source, firstEvent.lineage_id ?? undefined);
			if (!this.reserveAllSlots(handlerId, scopes, options.limits ?? {}, now)) {
				this.auditQueued("dequeue-blocked", queued, now, undefined, { scopes: scopes.map((scope) => scope.scope) });
				this.db.exec("COMMIT");
				return { disposition: "blocked", queueId: queued.queue_id, workKey: queued.work_key, eventIds: eventRows.map((row) => row.event_id) };
			}

			this.db.prepare("INSERT INTO handlers(handler_id, parent_namespace, source, work_key, root_event_id, root_work_key, state, generation, fork_depth, updated_at, started_at) VALUES (?, ?, ?, ?, ?, ?, 'handler-starting', 1, 0, ?, ?)")
				.run(handlerId, queued.parent_namespace, queued.source, queued.work_key, firstEvent.root_event_id ?? firstEvent.event_id, firstEvent.root_work_key ?? queued.work_key, now, now);
			this.db.prepare("UPDATE queue SET state = ?, updated_at = ? WHERE queue_id = ? AND state = 'queued'").run("handler-starting", now, queued.queue_id);
			this.db.prepare("UPDATE events SET state = ?, updated_at = ? WHERE event_id IN (SELECT event_id FROM queued_events WHERE queue_id = ?)").run("handler-starting", now, queued.queue_id);
			this.db.prepare("UPDATE work_items SET state = ?, active_handler_id = ?, queue_id = NULL, updated_at = ? WHERE parent_namespace = ? AND source = ? AND work_key = ?")
				.run("handler-starting", handlerId, now, queued.parent_namespace, queued.source, queued.work_key);
			this.auditQueued("dequeue-handler-starting", queued, now, handlerId, { eventIds: eventRows.map((row) => row.event_id), scopes: scopes.map((scope) => scope.scope) });
			this.db.exec("COMMIT");
			return { disposition: "handler-starting", queueId: queued.queue_id, workKey: queued.work_key, handlerId, eventIds: eventRows.map((row) => row.event_id) };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	getHandlerLaunchBundle(handlerId: string): HandlerLaunchBundle | undefined {
		const handler = this.db.prepare("SELECT handler_id, parent_namespace, source, work_key, root_event_id, root_work_key, generation, state FROM handlers WHERE handler_id = ?")
			.get(handlerId) as { handler_id: string; parent_namespace: string; source: BackgroundEventSource; work_key: string; root_event_id: string; root_work_key: string; generation: number; state: string } | undefined;
		if (!handler) return undefined;
		const events = this.db.prepare(`
			SELECT event_id, payload_path, payload_sha256, payload_bytes, state
			FROM events
			WHERE parent_namespace = ? AND source = ? AND work_key = ?
			ORDER BY created_at, event_id
		`).all(handler.parent_namespace, handler.source, handler.work_key) as Array<{ event_id: string; payload_path: string; payload_sha256: string; payload_bytes: number; state: string }>;
		return {
			handlerId: handler.handler_id,
			parentNamespace: handler.parent_namespace,
			source: handler.source,
			workKey: handler.work_key,
			rootEventId: handler.root_event_id,
			rootWorkKey: handler.root_work_key,
			generation: handler.generation,
			state: handler.state,
			events: events.map((event) => ({ eventId: event.event_id, payloadPath: event.payload_path, payloadSha256: event.payload_sha256, payloadBytes: event.payload_bytes, state: event.state })),
		};
	}

	releaseSlots(handlerId: string, now = Date.now()): string[] {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const rows = this.db.prepare("SELECT scope FROM handler_slot_reservations WHERE handler_id = ? AND released_at IS NULL").all(handlerId) as Array<{ scope: string }>;
			for (const row of rows) {
				this.db.prepare("UPDATE slots SET used = CASE WHEN used > 0 THEN used - 1 ELSE 0 END, generation = generation + 1 WHERE scope = ?").run(row.scope);
				this.db.prepare("UPDATE handler_slot_reservations SET released_at = ? WHERE handler_id = ? AND scope = ? AND released_at IS NULL").run(now, handlerId, row.scope);
			}
			this.db.exec("COMMIT");
			return rows.map((row) => row.scope);
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	failHandlerLaunch(handlerId: string, options: FailHandlerLaunchOptions = {}): FailHandlerLaunchResult | undefined {
		const now = options.now ?? Date.now();
		const requeue = options.requeue !== false;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const handler = this.db.prepare("SELECT handler_id, parent_namespace, source, work_key FROM handlers WHERE handler_id = ?")
				.get(handlerId) as { handler_id: string; parent_namespace: string; source: BackgroundEventSource; work_key: string } | undefined;
			if (!handler) {
				this.db.exec("COMMIT");
				return undefined;
			}
			this.releaseSlotsInOpenTransaction(handlerId, now);
			this.db.prepare("UPDATE handlers SET state = 'failed', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE handler_id = ? AND state IN ('claimed','handler-starting','handler-running')")
				.run(now, now, handlerId);
			if (!requeue) {
				this.db.prepare("UPDATE events SET state = 'failed', updated_at = ? WHERE parent_namespace = ? AND source = ? AND work_key = ? AND state IN ('pending','queued','handler-starting')")
					.run(now, handler.parent_namespace, handler.source, handler.work_key);
				this.db.prepare("UPDATE work_items SET state = 'failed', active_handler_id = NULL, updated_at = ? WHERE parent_namespace = ? AND source = ? AND work_key = ?")
					.run(now, handler.parent_namespace, handler.source, handler.work_key);
				this.auditHandler("handler-launch-failed", handler, now, handlerId, { requeued: false, error: options.error });
				this.db.exec("COMMIT");
				return { handlerId, requeued: false };
			}
			let queueId = (this.db.prepare("SELECT queue_id FROM queue WHERE parent_namespace = ? AND source = ? AND work_key = ? AND state = 'queued'")
				.get(handler.parent_namespace, handler.source, handler.work_key) as { queue_id: string } | undefined)?.queue_id;
			if (!queueId) {
				queueId = `beq_${randomUUID()}`;
				const priority = (this.db.prepare("SELECT priority FROM events WHERE parent_namespace = ? AND source = ? AND work_key = ? ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at LIMIT 1")
					.get(handler.parent_namespace, handler.source, handler.work_key) as { priority: BackgroundPriority } | undefined)?.priority ?? "normal";
				this.db.prepare("INSERT INTO queue(queue_id, parent_namespace, source, work_key, priority, created_at, updated_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')")
					.run(queueId, handler.parent_namespace, handler.source, handler.work_key, priority, now, now);
			}
			const eventRows = this.db.prepare("SELECT event_id FROM events WHERE parent_namespace = ? AND source = ? AND work_key = ? ORDER BY created_at, event_id")
				.all(handler.parent_namespace, handler.source, handler.work_key) as Array<{ event_id: string }>;
			for (const row of eventRows) this.db.prepare("INSERT OR IGNORE INTO queued_events(queue_id, event_id) VALUES (?, ?)").run(queueId, row.event_id);
			this.db.prepare("UPDATE events SET state = 'queued', updated_at = ? WHERE parent_namespace = ? AND source = ? AND work_key = ? AND state IN ('pending','handler-starting','attached-to-handler','queued')")
				.run(now, handler.parent_namespace, handler.source, handler.work_key);
			this.db.prepare("UPDATE work_items SET state = 'queued', active_handler_id = NULL, queue_id = ?, updated_at = ? WHERE parent_namespace = ? AND source = ? AND work_key = ?")
				.run(queueId, now, handler.parent_namespace, handler.source, handler.work_key);
			this.auditHandler("handler-launch-failed-requeued", handler, now, handlerId, { requeued: true, queueId, error: options.error, eventIds: eventRows.map((row) => row.event_id) });
			this.db.exec("COMMIT");
			return { handlerId, requeued: true, queueId };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	markHandlerRunning(handlerId: string, input: { pid?: number; supervisorPid?: number; processGroupId?: number; leaseMs?: number; now?: number } = {}): void {
		const now = input.now ?? Date.now();
		const leaseMs = input.leaseMs ?? 60_000;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("UPDATE handlers SET state = 'handler-running', pid = COALESCE(?, pid), supervisor_pid = COALESCE(?, supervisor_pid), process_group_id = COALESCE(?, process_group_id), heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE handler_id = ? AND state IN ('handler-starting','handler-running')")
				.run(input.pid ?? null, input.supervisorPid ?? null, input.processGroupId ?? null, now, now + leaseMs, now, handlerId);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	heartbeatHandler(handlerId: string, input: { leaseMs?: number; now?: number } = {}): boolean {
		const now = input.now ?? Date.now();
		const leaseMs = input.leaseMs ?? 60_000;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = this.db.prepare("UPDATE handlers SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE handler_id = ? AND state = 'handler-running'")
				.run(now, now + leaseMs, now, handlerId);
			this.db.exec("COMMIT");
			return result.changes > 0;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	completeHandler(handlerId: string, input: { status?: "complete" | "failed" | "cancelled" | "stale"; summaryPath?: string; now?: number } = {}): string | undefined {
		const now = input.now ?? Date.now();
		const status = input.status ?? "complete";
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const handler = this.db.prepare("SELECT handler_id, parent_namespace, source, work_key, root_event_id, root_work_key, generation FROM handlers WHERE handler_id = ?")
				.get(handlerId) as { handler_id: string; parent_namespace: string; source: string; work_key: string; root_event_id: string; root_work_key: string; generation: number } | undefined;
			if (!handler) {
				this.db.exec("COMMIT");
				return undefined;
			}
			this.releaseSlotsInOpenTransaction(handlerId, now);
			this.db.prepare("UPDATE handlers SET state = ?, ended_at = ?, updated_at = ? WHERE handler_id = ?").run(status === "complete" ? "completed" : status, now, now, handlerId);
			this.db.prepare("UPDATE work_items SET state = ?, active_handler_id = NULL, updated_at = ? WHERE parent_namespace = ? AND source = ? AND work_key = ?")
				.run(status === "complete" ? "completed" : status, now, handler.parent_namespace, handler.source, handler.work_key);
			const alreadyDelivered = this.db.prepare("SELECT delivered_result_id FROM work_results WHERE parent_namespace = ? AND source = ? AND work_key = ? AND delivered_result_id IS NOT NULL")
				.get(handler.parent_namespace, handler.source, handler.work_key) as { delivered_result_id: string } | undefined;
			let resultId: string | undefined;
			if (!alreadyDelivered) {
				resultId = `ber_${randomUUID()}`;
				const ackKey = `${handlerId}:${resultId}`;
				const eventRows = this.db.prepare("SELECT event_id FROM events WHERE parent_namespace = ? AND source = ? AND work_key = ? ORDER BY created_at, event_id")
					.all(handler.parent_namespace, handler.source, handler.work_key) as Array<{ event_id: string }>;
				this.db.prepare("INSERT INTO results(result_id, handler_id, root_event_id, root_work_key, work_key, generation, status, summary_path, included_event_ids_json, excluded_late_event_ids_json, ack_key, delivery_state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 'pending', 0, ?, ?)")
					.run(resultId, handlerId, handler.root_event_id, handler.root_work_key, handler.work_key, handler.generation, status, input.summaryPath ?? "", JSON.stringify(eventRows.map((row) => row.event_id)), ackKey, now, now);
				this.db.prepare("INSERT INTO work_results(parent_namespace, source, work_key, delivered_result_id, delivered_generation, delivered_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(parent_namespace, source, work_key) DO UPDATE SET delivered_result_id=COALESCE(work_results.delivered_result_id, excluded.delivered_result_id), delivered_generation=COALESCE(work_results.delivered_generation, excluded.delivered_generation), delivered_at=COALESCE(work_results.delivered_at, excluded.delivered_at)")
					.run(handler.parent_namespace, handler.source, handler.work_key, resultId, handler.generation, now);
			}
			this.db.exec("COMMIT");
			return resultId;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	acquireReconcilerLease(leaseName: string, ownerId: string, ttlMs: number, now = Date.now()): boolean {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const current = this.db.prepare("SELECT owner_id, expires_at FROM reconciler_leases WHERE lease_name = ?").get(leaseName) as { owner_id: string; expires_at: number } | undefined;
			if (current && current.expires_at > now && current.owner_id !== ownerId) {
				this.db.exec("COMMIT");
				return false;
			}
			this.db.prepare("INSERT INTO reconciler_leases(lease_name, owner_id, expires_at, heartbeat_at) VALUES (?, ?, ?, ?) ON CONFLICT(lease_name) DO UPDATE SET owner_id=excluded.owner_id, expires_at=excluded.expires_at, heartbeat_at=excluded.heartbeat_at")
				.run(leaseName, ownerId, now + ttlMs, now);
			this.db.exec("COMMIT");
			return true;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	reconcileStaleHandlers(input: { now?: number; isProcessAlive?: (pid: number) => boolean } = {}): string[] {
		const now = input.now ?? Date.now();
		const isAlive = input.isProcessAlive ?? isProcessAlive;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const rows = this.db.prepare("SELECT handler_id, pid FROM handlers WHERE state = 'handler-running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?")
				.all(now) as Array<{ handler_id: string; pid: number | null }>;
			const stale: string[] = [];
			for (const row of rows) {
				if (row.pid && isAlive(row.pid)) continue;
				this.releaseSlotsInOpenTransaction(row.handler_id, now);
				this.db.prepare("UPDATE handlers SET state = 'stale', ended_at = ?, updated_at = ? WHERE handler_id = ? AND state = 'handler-running'").run(now, now, row.handler_id);
				stale.push(row.handler_id);
			}
			this.db.exec("COMMIT");
			return stale;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	runReconcilerPass(options: ReconcilerPassOptions): ReconcilerPassResult {
		const now = options.now ?? Date.now();
		if (!this.acquireReconcilerLease(options.leaseName, options.ownerId, options.leaseTtlMs, now)) {
			return { leaseAcquired: false, staleHandlers: [], dequeued: [], launchBundles: [] };
		}
		const staleHandlers = this.reconcileStaleHandlers({ now, isProcessAlive: options.isProcessAlive });
		const dequeued: DequeueQueuedResult[] = [];
		const launchBundles: HandlerLaunchBundle[] = [];
		const limit = Math.max(0, options.dequeueLimit ?? 1);
		for (let index = 0; index < limit; index += 1) {
			const result = this.dequeueNextQueued({ limits: options.limits, now, source: options.source });
			if (result.disposition === "empty") break;
			dequeued.push(result);
			if (result.disposition === "handler-starting" && result.handlerId) {
				const bundle = this.getHandlerLaunchBundle(result.handlerId);
				if (bundle) launchBundles.push(bundle);
			}
			if (result.disposition === "blocked") break;
		}
		return { leaseAcquired: true, staleHandlers, dequeued, launchBundles };
	}

	upsertLineageBudget(input: LineageBudgetInput): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.upsertLineageBudgetInOpenTransaction(input);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	chargeLineageFollowup(input: ChargeLineageInput): { allowed: boolean; reason?: string } {
		const now = input.now ?? Date.now();
		const forkable = input.forkable !== false;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db.prepare("SELECT max_followups, used_followups, max_forkable_followups, used_forkable_followups FROM lineage_budgets WHERE lineage_id = ?")
				.get(input.lineageId) as { max_followups: number | null; used_followups: number; max_forkable_followups: number | null; used_forkable_followups: number } | undefined;
			const maxFollowups = row?.max_followups ?? 3;
			const usedFollowups = row?.used_followups ?? 0;
			if (usedFollowups >= maxFollowups) {
				this.db.exec("COMMIT");
				return { allowed: false, reason: "lineage-followup-budget" };
			}
			if (forkable) {
				const maxForkable = row?.max_forkable_followups ?? 0;
				const usedForkable = row?.used_forkable_followups ?? 0;
				if (usedForkable >= maxForkable) {
					this.db.exec("COMMIT");
					return { allowed: false, reason: "lineage-fork-budget" };
				}
			}
			this.db.prepare(`
				INSERT INTO lineage_budgets(lineage_id, used_followups, used_forkable_followups, updated_at)
				VALUES (?, 1, ?, ?)
				ON CONFLICT(lineage_id) DO UPDATE SET
					used_followups=lineage_budgets.used_followups + 1,
					used_forkable_followups=lineage_budgets.used_forkable_followups + excluded.used_forkable_followups,
					updated_at=excluded.updated_at
			`).run(input.lineageId, forkable ? 1 : 0, now);
			this.db.exec("COMMIT");
			return { allowed: true };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	canAutoFork(input: { forkDepth?: number; maxForkDepth?: number; lineageId?: string; forkable?: boolean }): { allowed: boolean; reason?: string } {
		const forkDepth = input.forkDepth ?? 0;
		const maxForkDepth = input.maxForkDepth ?? 1;
		if (forkDepth >= maxForkDepth) return { allowed: false, reason: "max-depth" };
		if (input.lineageId && input.forkable !== false) {
			const row = this.db.prepare("SELECT max_forkable_followups, used_forkable_followups FROM lineage_budgets WHERE lineage_id = ?").get(input.lineageId) as { max_forkable_followups: number | null; used_forkable_followups: number } | undefined;
			const max = row?.max_forkable_followups ?? 0;
			const used = row?.used_forkable_followups ?? 0;
			if (used >= max) return { allowed: false, reason: "lineage-fork-budget" };
		}
		return { allowed: true };
	}

	chargeAutoForkForLineage(input: ChargeAutoForkLineageInput): { allowed: boolean; reason?: string } {
		const now = input.now ?? Date.now();
		const forkDepth = input.forkDepth ?? 0;
		const maxForkDepth = input.maxForkDepth ?? 1;
		const forkable = input.forkable !== false;
		if (forkDepth >= maxForkDepth) return { allowed: false, reason: "max-depth" };
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.upsertLineageBudgetInOpenTransaction({ ...input, now });
			const row = this.db.prepare("SELECT max_followups, used_followups, max_forkable_followups, used_forkable_followups FROM lineage_budgets WHERE lineage_id = ?")
				.get(input.lineageId) as { max_followups: number | null; used_followups: number; max_forkable_followups: number | null; used_forkable_followups: number };
			const maxFollowups = row.max_followups ?? 3;
			if (row.used_followups >= maxFollowups) {
				this.db.exec("COMMIT");
				return { allowed: false, reason: "lineage-followup-budget" };
			}
			if (forkable) {
				const maxForkable = row.max_forkable_followups ?? 0;
				if (row.used_forkable_followups >= maxForkable) {
					this.db.exec("COMMIT");
					return { allowed: false, reason: "lineage-fork-budget" };
				}
			}
			this.db.prepare("UPDATE lineage_budgets SET used_followups = used_followups + 1, used_forkable_followups = used_forkable_followups + ?, updated_at = ? WHERE lineage_id = ?")
				.run(forkable ? 1 : 0, now, input.lineageId);
			this.db.exec("COMMIT");
			return { allowed: true };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private upsertLineageBudgetInOpenTransaction(input: LineageBudgetInput): void {
		const now = input.now ?? Date.now();
		this.db.prepare(`
			INSERT INTO lineage_budgets(lineage_id, root_event_id, root_work_key, origin_handler_id, max_followups, max_forkable_followups, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(lineage_id) DO UPDATE SET
				root_event_id=COALESCE(excluded.root_event_id, lineage_budgets.root_event_id),
				root_work_key=COALESCE(excluded.root_work_key, lineage_budgets.root_work_key),
				origin_handler_id=COALESCE(excluded.origin_handler_id, lineage_budgets.origin_handler_id),
				max_followups=COALESCE(excluded.max_followups, lineage_budgets.max_followups),
				max_forkable_followups=COALESCE(excluded.max_forkable_followups, lineage_budgets.max_forkable_followups),
				updated_at=excluded.updated_at
		`).run(input.lineageId, input.rootEventId ?? null, input.rootWorkKey ?? null, input.originHandlerId ?? null, input.maxFollowups ?? null, input.maxForkableFollowups ?? null, now);
	}

	private releaseSlotsInOpenTransaction(handlerId: string, now: number): string[] {
		const rows = this.db.prepare("SELECT scope FROM handler_slot_reservations WHERE handler_id = ? AND released_at IS NULL").all(handlerId) as Array<{ scope: string }>;
		for (const row of rows) {
			this.db.prepare("UPDATE slots SET used = CASE WHEN used > 0 THEN used - 1 ELSE 0 END, generation = generation + 1 WHERE scope = ?").run(row.scope);
			this.db.prepare("UPDATE handler_slot_reservations SET released_at = ? WHERE handler_id = ? AND scope = ? AND released_at IS NULL").run(now, handlerId, row.scope);
		}
		return rows.map((row) => row.scope);
	}

	private upsertParent(envelope: BackgroundEventEnvelope, now: number): void {
		this.db.prepare("INSERT INTO parents(parent_namespace, session_id, session_file, session_name, intercom_target, cwd, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(parent_namespace) DO UPDATE SET session_id=excluded.session_id, session_file=excluded.session_file, session_name=excluded.session_name, intercom_target=excluded.intercom_target, cwd=excluded.cwd, updated_at=excluded.updated_at")
			.run(envelope.parentNamespace, envelope.parent.sessionId, envelope.parent.sessionFile ?? null, envelope.parent.sessionName ?? null, envelope.parent.intercomTarget ?? null, envelope.parent.cwd, now);
	}

	private insertEvent(envelope: BackgroundEventEnvelope, state: BackgroundEventState, now: number): void {
		this.db.prepare("INSERT INTO events(event_id, parent_namespace, source, work_key, state, priority, created_at, updated_at, payload_path, payload_sha256, payload_bytes, expected_reply, needs_decision, event_type, root_event_id, root_work_key, lineage_id, origin_handler_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(envelope.eventId, envelope.parentNamespace, envelope.source, envelope.workKey, state, envelope.priority, envelope.createdAt, now, envelope.payloadPath, envelope.payloadSha256, envelope.payloadBytes, envelope.expectedReply ? 1 : 0, envelope.needsDecision ? 1 : 0, envelope.eventType ?? null, envelope.origin?.rootEventId ?? null, envelope.origin?.rootWorkKey ?? null, envelope.origin?.lineageId ?? null, envelope.origin?.handlerId ?? null);
	}

	private upsertWorkItem(envelope: BackgroundEventEnvelope, now: number): void {
		this.db.prepare("INSERT INTO work_items(parent_namespace, source, work_key, state, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?) ON CONFLICT(parent_namespace, source, work_key) DO UPDATE SET updated_at=excluded.updated_at")
			.run(envelope.parentNamespace, envelope.source, envelope.workKey, now, now);
	}

	private nextUpdateSeq(handlerId: string): number {
		const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM updates WHERE handler_id = ?").get(handlerId) as { seq: number };
		return row.seq;
	}

	private slotScopes(envelope: BackgroundEventEnvelope): Array<{ scope: string; limit: number }> {
		return this.slotScopesFor(envelope.parentNamespace, envelope.source, envelope.origin?.lineageId);
	}

	private slotScopesFor(parentNamespace: string, source: BackgroundEventSource, lineageId?: string): Array<{ scope: string; limit: number }> {
		return [
			{ scope: "global", limit: DEFAULT_LIMITS.global },
			{ scope: `parent:${parentNamespace}`, limit: DEFAULT_LIMITS.parent },
			{ scope: `source:${source}`, limit: DEFAULT_LIMITS.source[source] },
			{ scope: `parent-source:${parentNamespace}:${source}`, limit: DEFAULT_LIMITS.parentSource[source] },
			...(lineageId ? [{ scope: `root:${lineageId}`, limit: DEFAULT_LIMITS.root }] : []),
		];
	}

	private reserveAllSlots(handlerId: string, scopes: Array<{ scope: string; limit: number }>, overrides: SlotLimitConfig, now: number): boolean {
		const effective = scopes.map((entry) => ({ ...entry, limit: this.overrideLimit(entry.scope, entry.limit, overrides) }));
		for (const entry of effective) {
			this.db.prepare("INSERT INTO slots(scope, used, limit_value, generation) VALUES (?, 0, ?, 0) ON CONFLICT(scope) DO UPDATE SET limit_value=excluded.limit_value").run(entry.scope, entry.limit);
		}
		const current = effective.map((entry) => this.db.prepare("SELECT scope, used, limit_value FROM slots WHERE scope = ?").get(entry.scope) as { scope: string; used: number; limit_value: number });
		if (current.some((entry) => entry.used >= entry.limit_value)) return false;
		for (const entry of current) {
			this.db.prepare("UPDATE slots SET used = used + 1, generation = generation + 1 WHERE scope = ?").run(entry.scope);
			this.db.prepare("INSERT INTO handler_slot_reservations(handler_id, scope) VALUES (?, ?)").run(handlerId, entry.scope);
		}
		return true;
	}

	private overrideLimit(scope: string, fallback: number, overrides: SlotLimitConfig): number {
		if (scope === "global") return overrides.global ?? fallback;
		if (scope.startsWith("parent:")) return overrides.parent ?? fallback;
		if (scope.startsWith("source:")) return overrides.source?.[scope.slice("source:".length) as BackgroundEventSource] ?? fallback;
		if (scope.includes(":") && scope.startsWith("parent-source:")) {
			const source = scope.split(":").at(-1) as BackgroundEventSource;
			return overrides.parentSource?.[source] ?? fallback;
		}
		if (scope.startsWith("root:")) return overrides.root ?? fallback;
		return fallback;
	}

	private audit(transition: string, envelope: BackgroundEventEnvelope, now: number, handlerId: string | undefined, details: unknown): void {
		this.db.prepare("INSERT INTO audit(audit_id, at, actor_id, transition_name, parent_namespace, source, work_key, event_id, handler_id, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(randomUUID(), now, "background-events", transition, envelope.parentNamespace, envelope.source, envelope.workKey, envelope.eventId, handlerId ?? null, JSON.stringify(details ?? {}));
	}

	private auditQueued(transition: string, queued: { queue_id: string; parent_namespace: string; source: BackgroundEventSource; work_key: string }, now: number, handlerId: string | undefined, details: unknown): void {
		this.db.prepare("INSERT INTO audit(audit_id, at, actor_id, transition_name, parent_namespace, source, work_key, event_id, handler_id, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)")
			.run(randomUUID(), now, "background-events", transition, queued.parent_namespace, queued.source, queued.work_key, handlerId ?? null, JSON.stringify({ queueId: queued.queue_id, ...(details && typeof details === "object" ? details : { details }) }));
	}

	private auditHandler(transition: string, handler: { parent_namespace: string; source: BackgroundEventSource; work_key: string }, now: number, handlerId: string, details: unknown): void {
		this.db.prepare("INSERT INTO audit(audit_id, at, actor_id, transition_name, parent_namespace, source, work_key, event_id, handler_id, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)")
			.run(randomUUID(), now, "background-events", transition, handler.parent_namespace, handler.source, handler.work_key, handlerId, JSON.stringify(details ?? {}));
	}
}
