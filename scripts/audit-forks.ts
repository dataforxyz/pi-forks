#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	BackgroundEventsStore,
	getBackgroundEventsDbPath,
	resolveBackgroundStateRoot,
} from "../src/background-events.ts";
import {
	diagnoseForkRuns,
	scanBackgroundEvents,
	scanForkRuns,
	type BackgroundEventsStatus,
	type ForkRun,
	type ForkSource,
} from "../src/monitor.ts";
import { formatDuration, formatTokens } from "../src/formatting.ts";
import { getForkHandlersFile, getForkStateDir } from "../src/runtime.ts";

type OutputMode = "text" | "json";

interface CliOptions {
	mode: OutputMode;
	includeCompleted: boolean;
	limit: number;
	runLimit: number;
	source?: ForkSource;
	dbPath?: string;
}

interface AuditRow {
	audit_id: string;
	at: number;
	actor_id: string;
	transition_name: string;
	parent_namespace?: string | null;
	source?: string | null;
	work_key?: string | null;
	event_id?: string | null;
	handler_id?: string | null;
	details_json?: string | null;
}

interface DbHandlerRow {
	handler_id: string;
	parent_namespace: string;
	source: string;
	work_key: string;
	root_event_id: string;
	state: string;
	pid?: number | null;
	supervisor_pid?: number | null;
	process_group_id?: number | null;
	generation: number;
	fork_depth: number;
	started_at?: number | null;
	updated_at: number;
	ended_at?: number | null;
	heartbeat_at?: number | null;
	lease_expires_at?: number | null;
	dir?: string | null;
	session_dir?: string | null;
}

interface DbQueueRow {
	queue_id: string;
	parent_namespace: string;
	source: string;
	work_key: string;
	priority: string;
	state: string;
	created_at: number;
	updated_at: number;
	event_count: number;
}

interface DbResultRow {
	result_id: string;
	handler_id: string;
	status: string;
	delivery_state: string;
	attempts: number;
	created_at: number;
	updated_at: number;
	summary_path: string;
	included_event_ids_json: string;
}

interface DbLineageRow {
	lineage_id: string;
	root_event_id?: string | null;
	root_work_key?: string | null;
	origin_handler_id?: string | null;
	max_followups?: number | null;
	used_followups: number;
	max_forkable_followups?: number | null;
	used_forkable_followups: number;
	updated_at: number;
}

interface AuditReport {
	generatedAt: number;
	env: {
		home: string;
		backgroundStateRoot: string;
		backgroundEventsDbPath: string;
		forkStateDirs: Record<ForkSource, string>;
		handlerFiles: Record<ForkSource, string>;
	};
	backgroundEvents: BackgroundEventsStatus;
	runs: ForkRun[];
	diagnostics: ReturnType<typeof diagnoseForkRuns>;
	db: {
		exists: boolean;
		handlers: DbHandlerRow[];
		queue: DbQueueRow[];
		results: DbResultRow[];
		lineageBudgets: DbLineageRow[];
		audit: AuditRow[];
	};
}

const SOURCES: ForkSource[] = ["intercom", "return_on", "subagents"];

function usage(): string {
	return [
		"Usage: npm run audit -- [options]",
		"       node --experimental-strip-types scripts/audit-forks.ts [options]",
		"",
		"Options:",
		"  --json                 Emit machine-readable JSON",
		"  --completed, --all     Include completed handlers in the run list",
		"  --source <source>      Limit runs/diagnostics to intercom, return_on, or subagents",
		"  --limit <n>            Limit DB timeline sections (default: 50)",
		"  --run-limit <n>        Limit text handler/run rows (default: 50; JSON is complete)",
		"  --db <path>            Inspect a specific background-events SQLite DB",
		"  -h, --help             Show this help",
	].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { mode: "text", includeCompleted: false, limit: 50, runLimit: 50 };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--json") options.mode = "json";
		else if (arg === "--completed" || arg === "--all") options.includeCompleted = true;
		else if (arg === "--limit") {
			const raw = argv[++i];
			const value = Number(raw);
			if (!Number.isSafeInteger(value) || value < 1) throw new Error("--limit must be a positive integer");
			options.limit = value;
		} else if (arg === "--run-limit") {
			const raw = argv[++i];
			const value = Number(raw);
			if (!Number.isSafeInteger(value) || value < 1) throw new Error("--run-limit must be a positive integer");
			options.runLimit = value;
		} else if (arg === "--source") {
			const raw = argv[++i] as ForkSource | undefined;
			if (!raw || !SOURCES.includes(raw)) throw new Error("--source must be one of: intercom, return_on, subagents");
			options.source = raw;
		} else if (arg === "--db") {
			const raw = argv[++i];
			if (!raw) throw new Error("--db requires a path");
			options.dbPath = path.resolve(raw.replace(/^~(?=\/|$)/, os.homedir()));
		} else if (arg === "-h" || arg === "--help") {
			console.log(usage());
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

function nowish(value: number | undefined | null): string {
	if (!value) return "n/a";
	const iso = new Date(value).toISOString();
	const age = Date.now() >= value ? `${formatDuration(Date.now() - value)} ago` : `in ${formatDuration(value - Date.now())}`;
	return `${iso} (${age})`;
}

function compactPath(value: string | undefined | null): string | undefined {
	if (!value) return undefined;
	const home = os.homedir();
	return value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;
}

function queryDb<T>(store: BackgroundEventsStore, sql: string, ...params: unknown[]): T[] {
	return store.db.prepare(sql).all(...params) as T[];
}

function readDbSnapshot(dbPath: string, limit: number): AuditReport["db"] {
	if (!fs.existsSync(dbPath)) return { exists: false, handlers: [], queue: [], results: [], lineageBudgets: [], audit: [] };
	const store = new BackgroundEventsStore(dbPath);
	try {
		return {
			exists: true,
			handlers: queryDb<DbHandlerRow>(store, `
				SELECT handler_id, parent_namespace, source, work_key, root_event_id, state, pid, supervisor_pid,
					process_group_id, generation, fork_depth, started_at, updated_at, ended_at, heartbeat_at,
					lease_expires_at, dir, session_dir
				FROM handlers
				ORDER BY COALESCE(started_at, updated_at) DESC, handler_id
				LIMIT ?
			`, limit),
			queue: queryDb<DbQueueRow>(store, `
				SELECT q.queue_id, q.parent_namespace, q.source, q.work_key, q.priority, q.state, q.created_at, q.updated_at,
					COUNT(qe.event_id) AS event_count
				FROM queue q
				LEFT JOIN queued_events qe ON qe.queue_id = q.queue_id
				GROUP BY q.queue_id
				ORDER BY q.updated_at DESC, q.queue_id
				LIMIT ?
			`, limit),
			results: queryDb<DbResultRow>(store, `
				SELECT result_id, handler_id, status, delivery_state, attempts, created_at, updated_at, summary_path, included_event_ids_json
				FROM results
				ORDER BY updated_at DESC, result_id
				LIMIT ?
			`, limit),
			lineageBudgets: queryDb<DbLineageRow>(store, `
				SELECT lineage_id, root_event_id, root_work_key, origin_handler_id, max_followups, used_followups,
					max_forkable_followups, used_forkable_followups, updated_at
				FROM lineage_budgets
				ORDER BY updated_at DESC, lineage_id
				LIMIT ?
			`, limit),
			audit: queryDb<AuditRow>(store, `
				SELECT audit_id, at, actor_id, transition_name, parent_namespace, source, work_key, event_id, handler_id, details_json
				FROM audit
				ORDER BY at DESC, audit_id
				LIMIT ?
			`, limit),
		};
	} finally {
		store.close();
	}
}

function buildReport(options: CliOptions): AuditReport {
	const home = os.homedir();
	const backgroundStateRoot = resolveBackgroundStateRoot(process.env, home);
	const backgroundEventsDbPath = options.dbPath ?? getBackgroundEventsDbPath(backgroundStateRoot);
	const forkStateDirs = Object.fromEntries(SOURCES.map((source) => [source, getForkStateDir(source, home)])) as Record<ForkSource, string>;
	const handlerFiles = Object.fromEntries(SOURCES.map((source) => [source, getForkHandlersFile(source, home)])) as Record<ForkSource, string>;
	const scanOptions = {
		includeCompleted: options.includeCompleted,
		includeTokens: true,
		...(options.source ? { source: options.source } : {}),
	};
	return {
		generatedAt: Date.now(),
		env: { home, backgroundStateRoot, backgroundEventsDbPath, forkStateDirs, handlerFiles },
		backgroundEvents: scanBackgroundEvents({ dbPath: backgroundEventsDbPath }),
		runs: scanForkRuns(scanOptions).runs,
		diagnostics: diagnoseForkRuns({ ...scanOptions, includeCompleted: true }),
		db: readDbSnapshot(backgroundEventsDbPath, options.limit),
	};
}

function sourceCounts(runs: ForkRun[]): string[] {
	return SOURCES.map((source) => {
		const sourceRuns = runs.filter((run) => run.source === source);
		const running = sourceRuns.filter((run) => run.status === "running").length;
		const stale = sourceRuns.filter((run) => run.status === "stale").length;
		const failed = sourceRuns.filter((run) => run.status === "failed").length;
		return `${source}: ${sourceRuns.length} tracked, ${running} running, ${stale} stale, ${failed} failed`;
	});
}

function runLine(run: ForkRun): string {
	const parts = [
		`${run.source}/${run.id}`,
		`status=${run.status}${run.rawStatus ? ` raw=${run.rawStatus}` : ""}`,
		`label=${JSON.stringify(run.label)}`,
		run.startedAt ? `activated=${nowish(run.startedAt)}` : undefined,
		run.endedAt ? `ended=${nowish(run.endedAt)}` : undefined,
		run.durationMs !== undefined ? `duration=${formatDuration(run.durationMs)}` : undefined,
		run.pid ? `pid=${run.pid}${run.pidAlive === false ? "(dead)" : ""}` : undefined,
		run.intercomTarget ? `intercom=${run.intercomTarget}` : undefined,
		run.parentIntercomTarget ? `parent=${run.parentIntercomTarget}` : undefined,
		run.parentSessionName ? `parentSession=${run.parentSessionName}` : undefined,
		run.detail ? `detail=${run.detail}` : undefined,
		compactPath(run.dir),
	].filter(Boolean);
	return `- ${parts.join(" | ")}`;
}

function formatDetails(json: string | undefined | null): string {
	if (!json) return "";
	try {
		const parsed = JSON.parse(json) as unknown;
		return JSON.stringify(parsed);
	} catch {
		return json;
	}
}

function renderText(report: AuditReport, options: CliOptions): string {
	const lines: string[] = [];
	const totals = report.diagnostics.totals;
	lines.push(`# pi-forks background audit`);
	lines.push(`generated: ${nowish(report.generatedAt)}`);
	lines.push("");
	lines.push(`state root: ${compactPath(report.env.backgroundStateRoot)}`);
	lines.push(`background-events db: ${compactPath(report.env.backgroundEventsDbPath)}${report.backgroundEvents.exists ? "" : " (not initialized)"}`);
	for (const source of SOURCES) lines.push(`${source} state: ${compactPath(report.env.forkStateDirs[source])} · handlers: ${compactPath(report.env.handlerFiles[source])}`);
	lines.push("");
	lines.push(`summary: ${totals.tracked} tracked · ${totals.running} running · ${totals.stale} stale · ${totals.failed} failed · ${formatTokens(totals.totalTokens)} tokens`);
	lines.push(`background-events: ${report.backgroundEvents.activeHandlers} active · ${report.backgroundEvents.queuedItems} queued · ${report.backgroundEvents.attachedUpdates} attached updates · ${report.backgroundEvents.staleLeases} stale leases · ${report.backgroundEvents.failedDeliveries} failed deliveries · slots ${report.backgroundEvents.slotUsed}/${report.backgroundEvents.slotLimit}`);
	lines.push(...sourceCounts(report.runs));
	lines.push("");
	const visibleRuns = report.runs.slice(0, options.runLimit);
	lines.push(`## handlers/runs${report.runs.length === 0 ? "" : ` (${report.runs.length}${report.runs.length > visibleRuns.length ? `, showing ${visibleRuns.length}` : ""})`}`);
	if (report.runs.length === 0) lines.push("No matching handler runs found.");
	else {
		for (const run of visibleRuns) lines.push(runLine(run));
		if (report.runs.length > visibleRuns.length) lines.push(`- … ${report.runs.length - visibleRuns.length} more omitted from text output; rerun with --run-limit ${report.runs.length} or --json.`);
	}
	lines.push("");
	lines.push(`## shared DB active/recent handlers`);
	if (!report.db.exists) lines.push("background-events DB does not exist yet.");
	else if (report.db.handlers.length === 0) lines.push("No shared DB handlers recorded.");
	else for (const row of report.db.handlers) {
		lines.push(`- ${row.source}/${row.handler_id} | state=${row.state} | work=${row.work_key} | parent=${row.parent_namespace} | activated=${nowish(row.started_at)} | updated=${nowish(row.updated_at)}${row.pid ? ` | pid=${row.pid}` : ""}${row.supervisor_pid ? ` | supervisor=${row.supervisor_pid}` : ""}${row.fork_depth ? ` | depth=${row.fork_depth}` : ""}`);
	}
	lines.push("");
	lines.push(`## queue`);
	if (report.db.queue.length === 0) lines.push("No queued work.");
	else for (const row of report.db.queue) lines.push(`- ${row.queue_id} | ${row.source} | state=${row.state} | priority=${row.priority} | events=${row.event_count} | work=${row.work_key} | queued=${nowish(row.created_at)} | updated=${nowish(row.updated_at)}`);
	lines.push("");
	lines.push(`## results / parent summary delivery`);
	if (report.db.results.length === 0) lines.push("No shared DB results recorded.");
	else for (const row of report.db.results) lines.push(`- ${row.result_id} | handler=${row.handler_id} | status=${row.status} | delivery=${row.delivery_state} | attempts=${row.attempts} | created=${nowish(row.created_at)} | summary=${compactPath(row.summary_path)} | events=${row.included_event_ids_json}`);
	lines.push("");
	lines.push(`## lineage budgets`);
	if (report.db.lineageBudgets.length === 0) lines.push("No lineage budgets recorded.");
	else for (const row of report.db.lineageBudgets) lines.push(`- ${row.lineage_id} | followups=${row.used_followups}/${row.max_followups ?? "∞"} | forkable=${row.used_forkable_followups}/${row.max_forkable_followups ?? "∞"} | origin=${row.origin_handler_id ?? "n/a"} | updated=${nowish(row.updated_at)}`);
	lines.push("");
	lines.push(`## transition audit log`);
	if (report.db.audit.length === 0) lines.push("No shared DB audit transitions recorded.");
	else for (const row of report.db.audit) lines.push(`- ${nowish(row.at)} | ${row.transition_name} | actor=${row.actor_id} | source=${row.source ?? "n/a"} | handler=${row.handler_id ?? "n/a"} | event=${row.event_id ?? "n/a"} | work=${row.work_key ?? "n/a"}${row.details_json ? ` | ${formatDetails(row.details_json)}` : ""}`);
	lines.push("");
	lines.push(`## health issues`);
	const visibleIssues = report.diagnostics.issues.slice(0, options.limit);
	if (report.diagnostics.issues.length === 0) lines.push("No health issues found.");
	else {
		for (const issue of visibleIssues) {
			lines.push(`- [${issue.severity}] ${issue.kind}: ${issue.message}`);
			if (issue.detail) lines.push(`  ${issue.detail}`);
		}
		if (report.diagnostics.issues.length > visibleIssues.length) lines.push(`- … ${report.diagnostics.issues.length - visibleIssues.length} more health issues omitted from text output; rerun with --limit ${report.diagnostics.issues.length} or --json.`);
	}
	return lines.join("\n");
}

try {
	const options = parseArgs(process.argv.slice(2));
	const report = buildReport(options);
	if (options.mode === "json") console.log(JSON.stringify(report, null, 2));
	else console.log(renderText(report, options));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	console.error(usage());
	process.exit(1);
}
