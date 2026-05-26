import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildForkIntercomIdentity, getForkHandlersDir, getForkHandlersFile, getForkStateDir, isProcessAlive, type ForkSource, type ForkStatus } from "./runtime.ts";

export type { ForkSource, ForkStatus } from "./runtime.ts";

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
	cost?: number;
}

const SESSION_TOKEN_CACHE_VERSION = 1;
const SESSION_TOKEN_CACHE_LIMIT = 5_000;

interface SessionTokenCacheEntry {
	mtimeMs: number;
	size: number;
	tokens?: TokenUsage;
	lastAccessedAt?: number;
}

const sessionTokenCache = new Map<string, SessionTokenCacheEntry>();
let persistentSessionTokenCacheLoaded = false;
let persistentSessionTokenCacheDirty = false;
let persistentSessionTokenCacheSaveTimer: NodeJS.Timeout | undefined;
let persistentSessionTokenCacheExitHookRegistered = false;

export interface ParseSessionTokenOptions {
	sinceMs?: number;
}

export interface ForkRun {
	source: ForkSource;
	id: string;
	label: string;
	status: ForkStatus;
	rawStatus?: ForkStatus;
	staleReason?: string;
	pid?: number;
	pidAlive?: boolean;
	cwd?: string;
	dir?: string;
	sessionDir?: string;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	tokens?: TokenUsage;
	intercomTarget?: string;
	intercomStatusTag?: string;
	parentIntercomTarget?: string;
	parentSessionFile?: string;
	parentSessionId?: string;
	parentSessionName?: string;
	detail?: string;
}

export interface ForkSummary {
	runs: ForkRun[];
	running: ForkRun[];
	stale: ForkRun[];
	countsByStatus: Record<ForkStatus, number>;
	totalTokens: TokenUsage;
	maxRunningDurationMs: number;
}

export type ForkHealthSeverity = "info" | "warning" | "error";
export type ForkHealthIssueKind = "stale_pid" | "failed" | "unknown" | "duplicate_active_cwd" | "high_cost_incomplete";

export interface ForkHealthIssue {
	kind: ForkHealthIssueKind;
	severity: ForkHealthSeverity;
	message: string;
	runIds: string[];
	source?: ForkSource;
	cwd?: string;
	detail?: string;
}

export interface ForkDiagnostics {
	summary: ForkSummary;
	issues: ForkHealthIssue[];
	totals: {
		tracked: number;
		running: number;
		stale: number;
		failed: number;
		complete: number;
		unknown: number;
		deadPidRunningRecords: number;
		totalTokens: number;
	};
}

export interface ScanOptions {
	now?: number;
	homeDir?: string;
	includeCompleted?: boolean;
	limit?: number;
	source?: ForkSource | ForkSource[];
	parentSessionFile?: string;
	parentSessionId?: string;
	parentSessionName?: string;
	userOnly?: boolean;
	includeTokens?: boolean;
}

export interface AgentSpendRun {
	id: string;
	state?: string;
	steps: number;
	active: boolean;
	tokens: TokenUsage;
	cost?: number;
	cwd?: string;
	startedAt?: number;
	endedAt?: number;
}

export interface AgentSpendSummary {
	runs: AgentSpendRun[];
	active: AgentSpendRun[];
	steps: number;
	totalTokens: TokenUsage;
	totalCost?: number;
}

export interface AgentSpendOptions {
	parentSessionFile?: string;
	rootDir?: string;
}

interface IntercomHandlersState {
	runs?: Array<Record<string, unknown>>;
}

interface ReturnOnHandlersState {
	handlers?: Array<Record<string, unknown>>;
}

interface SubagentHandlersState {
	handlers?: Array<Record<string, unknown>>;
}

function readJsonFile<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return undefined;
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function statusValue(value: unknown): ForkStatus {
	if (value === "starting" || value === "running" || value === "complete" || value === "failed") return value;
	return "unknown";
}

function intercomMetadata(source: ForkSource, id: string): Pick<ForkRun, "intercomTarget" | "intercomStatusTag"> {
	const identity = buildForkIntercomIdentity(source, id);
	return {
		intercomTarget: identity.sessionName,
		intercomStatusTag: identity.statusTag,
	};
}

function effectiveStatus(status: ForkStatus, pidAlive: boolean | undefined): ForkStatus {
	if ((status === "starting" || status === "running") && pidAlive === false) return "stale";
	return status;
}

function staleReason(rawStatus: ForkStatus, pid: number | undefined, pidAlive: boolean | undefined): string | undefined {
	if ((rawStatus === "starting" || rawStatus === "running") && pidAlive === false) return `pid ${pid ?? "unknown"} is not alive while raw status is ${rawStatus}`;
	return undefined;
}

function computeDuration(startedAt: number | undefined, endedAt: number | undefined, now: number): number | undefined {
	if (startedAt === undefined) return undefined;
	return Math.max(0, (endedAt ?? now) - startedAt);
}

function findLatestSessionFile(sessionDir: string): string | undefined {
	try {
		const files = fs.readdirSync(sessionDir)
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => path.join(sessionDir, file));
		if (files.length === 0) return undefined;
		files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		return files[0];
	} catch {
		return undefined;
	}
}

function costValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		return numberValue(record.total) ?? [record.input, record.output, record.cacheRead, record.cacheWrite]
			.map(numberValue)
			.reduce<number>((sum, item) => sum + (item ?? 0), 0);
	}
	return undefined;
}

function usageNumbers(usage: Record<string, unknown>): Pick<TokenUsage, "input" | "output" | "cost"> {
	const input = numberValue(usage.inputTokens) ?? numberValue(usage.input) ?? 0;
	const output = numberValue(usage.outputTokens) ?? numberValue(usage.output) ?? 0;
	const cost = costValue(usage.cost);
	return { input, output, ...(cost !== undefined ? { cost } : {}) };
}

function entryTimestampMs(entry: Record<string, unknown>): number | undefined {
	const direct = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : numberValue(entry.timestamp);
	if (direct !== undefined && Number.isFinite(direct)) return direct;
	if (typeof entry.message === "object" && entry.message !== null) {
		const nested = (entry.message as Record<string, unknown>).timestamp;
		const value = typeof nested === "string" ? Date.parse(nested) : numberValue(nested);
		if (value !== undefined && Number.isFinite(value)) return value;
	}
	return undefined;
}

function sessionTokenCacheKey(sessionFile: string, options: ParseSessionTokenOptions): string {
	return JSON.stringify([path.resolve(sessionFile), options.sinceMs ?? 0]);
}

function sessionTokenCacheFile(homeDir = os.homedir()): string {
	return process.env.PI_FORKS_TOKEN_CACHE_FILE?.trim() || path.join(homeDir, ".local", "state", "pi-forks", "session-token-cache.json");
}

function shouldPersistSessionTokenCache(sessionFile: string): boolean {
	if (process.env.PI_FORKS_TOKEN_CACHE === "0" || process.env.PI_FORKS_TOKEN_CACHE === "false") return false;
	const home = path.resolve(os.homedir());
	const resolved = path.resolve(sessionFile);
	return resolved === home || resolved.startsWith(`${home}${path.sep}`);
}

function cloneTokens(tokens: TokenUsage | undefined): TokenUsage | undefined {
	return tokens ? { ...tokens } : undefined;
}

function loadPersistentSessionTokenCache(): void {
	if (persistentSessionTokenCacheLoaded) return;
	persistentSessionTokenCacheLoaded = true;
	try {
		const raw = JSON.parse(fs.readFileSync(sessionTokenCacheFile(), "utf8")) as Record<string, unknown>;
		if (numberValue(raw.version) !== SESSION_TOKEN_CACHE_VERSION || typeof raw.entries !== "object" || raw.entries === null) return;
		for (const [key, value] of Object.entries(raw.entries as Record<string, unknown>)) {
			if (typeof value !== "object" || value === null) continue;
			const entry = value as Record<string, unknown>;
			const mtimeMs = numberValue(entry.mtimeMs);
			const size = numberValue(entry.size);
			if (mtimeMs === undefined || size === undefined) continue;
			const rawTokens = typeof entry.tokens === "object" && entry.tokens !== null ? entry.tokens as Record<string, unknown> : undefined;
			const input = rawTokens ? numberValue(rawTokens.input) : undefined;
			const output = rawTokens ? numberValue(rawTokens.output) : undefined;
			const total = rawTokens ? numberValue(rawTokens.total) : undefined;
			const cost = rawTokens ? numberValue(rawTokens.cost) : undefined;
			const tokens = input !== undefined && output !== undefined && total !== undefined ? { input, output, total, ...(cost ? { cost } : {}) } : undefined;
			sessionTokenCache.set(key, { mtimeMs, size, ...(tokens ? { tokens } : {}), ...(numberValue(entry.lastAccessedAt) ? { lastAccessedAt: numberValue(entry.lastAccessedAt) } : {}) });
		}
	} catch {
		// Missing or corrupt cache just means the next scan rebuilds it.
	}
}

function flushPersistentSessionTokenCache(): void {
	if (!persistentSessionTokenCacheDirty) return;
	persistentSessionTokenCacheDirty = false;
	if (persistentSessionTokenCacheSaveTimer) {
		clearTimeout(persistentSessionTokenCacheSaveTimer);
		persistentSessionTokenCacheSaveTimer = undefined;
	}
	try {
		const entries = [...sessionTokenCache.entries()]
			.sort((a, b) => (b[1].lastAccessedAt ?? 0) - (a[1].lastAccessedAt ?? 0))
			.slice(0, SESSION_TOKEN_CACHE_LIMIT);
		const filePath = sessionTokenCacheFile();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify({ version: SESSION_TOKEN_CACHE_VERSION, updatedAt: Date.now(), entries: Object.fromEntries(entries) })}\n`, "utf8");
		fs.renameSync(tmp, filePath);
	} catch {
		// Token cache is an optimization; never break fork monitoring if it cannot be written.
	}
}

function schedulePersistentSessionTokenCacheSave(): void {
	persistentSessionTokenCacheDirty = true;
	if (!persistentSessionTokenCacheExitHookRegistered) {
		persistentSessionTokenCacheExitHookRegistered = true;
		process.once("beforeExit", flushPersistentSessionTokenCache);
	}
	if (persistentSessionTokenCacheSaveTimer) return;
	persistentSessionTokenCacheSaveTimer = setTimeout(flushPersistentSessionTokenCache, 1_000);
	persistentSessionTokenCacheSaveTimer.unref?.();
}

export function parseSessionTokenFile(sessionFile: string | undefined, options: ParseSessionTokenOptions = {}): TokenUsage | undefined {
	if (!sessionFile) return undefined;
	let stat: fs.Stats;
	try {
		stat = fs.statSync(sessionFile);
	} catch {
		return undefined;
	}
	const persistCache = shouldPersistSessionTokenCache(sessionFile);
	if (persistCache) loadPersistentSessionTokenCache();
	const cacheKey = sessionTokenCacheKey(sessionFile, options);
	const cached = sessionTokenCache.get(cacheKey);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		cached.lastAccessedAt = Date.now();
		if (persistCache) schedulePersistentSessionTokenCacheSave();
		return cloneTokens(cached.tokens);
	}
	let input = 0;
	let output = 0;
	let cost = 0;
	try {
		const content = fs.readFileSync(sessionFile, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				if (options.sinceMs !== undefined) {
					const timestamp = entryTimestampMs(entry);
					if (timestamp !== undefined && timestamp < options.sinceMs) continue;
				}
				const direct = entry.usage;
				const nested = typeof entry.message === "object" && entry.message !== null
					? (entry.message as Record<string, unknown>).usage
					: undefined;
				const usage = (typeof direct === "object" && direct !== null ? direct : nested) as Record<string, unknown> | undefined;
				if (!usage) continue;
				const values = usageNumbers(usage);
				input += values.input;
				output += values.output;
				cost += values.cost ?? 0;
			} catch {
				// Ignore malformed jsonl entries while collecting telemetry.
			}
		}
	} catch {
		return undefined;
	}
	const total = input + output;
	const tokens = total > 0 ? { input, output, total, ...(cost > 0 ? { cost } : {}) } : undefined;
	sessionTokenCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, ...(tokens ? { tokens } : {}), lastAccessedAt: Date.now() });
	if (persistCache) schedulePersistentSessionTokenCacheSave();
	return cloneTokens(tokens);
}

export function parseSessionTokens(sessionDir: string | undefined, options: ParseSessionTokenOptions = {}): TokenUsage | undefined {
	if (!sessionDir) return undefined;
	return parseSessionTokenFile(findLatestSessionFile(sessionDir), options);
}

interface RunMapperSpec {
	source: ForkSource;
	label: (run: Record<string, unknown>, id: string) => string;
	detail?: (run: Record<string, unknown>) => string | undefined;
}

function mapForkRun(run: Record<string, unknown>, now: number, spec: RunMapperSpec): ForkRun | undefined {
	const id = stringValue(run.id);
	if (!id) return undefined;
	const startedAt = numberValue(run.startedAt);
	const endedAt = numberValue(run.endedAt);
	const pid = numberValue(run.pid);
	const pidAlive = isProcessAlive(pid);
	const rawStatus = statusValue(run.status);
	const status = effectiveStatus(rawStatus, pidAlive);
	const reason = staleReason(rawStatus, pid, pidAlive);
	const cwd = stringValue(run.cwd);
	const dir = stringValue(run.dir);
	const sessionDir = stringValue(run.sessionDir);
	const parentIntercomTarget = stringValue(run.parentIntercomTarget) ?? stringValue(run.parentSessionName);
	const parentSessionFile = stringValue(run.parentSessionFile);
	const parentSessionId = stringValue(run.parentSessionId);
	const parentSessionName = stringValue(run.parentSessionName);
	const duration = computeDuration(startedAt, endedAt, now);
	const detail = spec.detail?.(run);
	return {
		source: spec.source,
		id,
		label: spec.label(run, id),
		status,
		...(rawStatus !== status ? { rawStatus } : {}),
		...(reason ? { staleReason: reason } : {}),
		...intercomMetadata(spec.source, id),
		...(pid !== undefined ? { pid } : {}),
		...(pidAlive !== undefined ? { pidAlive } : {}),
		...(cwd ? { cwd } : {}),
		...(dir ? { dir } : {}),
		...(sessionDir ? { sessionDir } : {}),
		...(parentIntercomTarget ? { parentIntercomTarget } : {}),
		...(parentSessionFile ? { parentSessionFile } : {}),
		...(parentSessionId ? { parentSessionId } : {}),
		...(parentSessionName ? { parentSessionName } : {}),
		...(startedAt !== undefined ? { startedAt } : {}),
		...(endedAt !== undefined ? { endedAt } : {}),
		...(duration !== undefined ? { durationMs: duration } : {}),
		...(detail ? { detail } : {}),
	};
}

function mapIntercomRun(run: Record<string, unknown>, now: number): ForkRun | undefined {
	return mapForkRun(run, now, {
		source: "intercom",
		label: (entry, id) => {
			const from = stringValue(entry.from);
			return from ? `from ${from}` : id;
		},
		detail: (entry) => {
			const messageId = stringValue(entry.messageId);
			return messageId ? `message ${messageId}` : undefined;
		},
	});
}

function mapReturnOnRun(run: Record<string, unknown>, now: number): ForkRun | undefined {
	return mapForkRun(run, now, {
		source: "return_on",
		label: (entry, id) => stringValue(entry.label) ?? stringValue(entry.jobId) ?? id,
		detail: (entry) => {
			const jobId = stringValue(entry.jobId);
			return jobId ? `job ${jobId}` : undefined;
		},
	});
}

function mapSubagentRun(run: Record<string, unknown>, now: number): ForkRun | undefined {
	return mapForkRun(run, now, {
		source: "subagents",
		label: (entry, id) => stringValue(entry.title) ?? id,
		detail: (entry) => stringValue(entry.type),
	});
}

function statTime(filePath: string): number | undefined {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return undefined;
	}
}

function mapSubagentDir(dir: string, now: number): ForkRun | undefined {
	const id = path.basename(dir);
	if (!id.startsWith("sbf_")) return undefined;
	const event = readJsonFile<Record<string, unknown>>(path.join(dir, "event.json"));
	const sessionDir = path.join(dir, "sessions");
	const eventType = stringValue(event?.type);
	const title = stringValue(event?.title) ?? id;
	const startedAt = statTime(path.join(dir, "prompt.md")) ?? statTime(dir);
	const parentIntercomTarget = stringValue(event?.parentIntercomTarget) ?? stringValue(event?.parentSessionName);
	const parentSessionFile = stringValue(event?.parentSessionFile);
	const parentSessionId = stringValue(event?.parentSessionId);
	const parentSessionName = stringValue(event?.parentSessionName);
	return {
		source: "subagents",
		id,
		label: title,
		status: "unknown",
		...intercomMetadata("subagents", id),
		...(stringValue(event?.cwd) ? { cwd: stringValue(event?.cwd) } : {}),
		dir,
		sessionDir,
		...(parentIntercomTarget ? { parentIntercomTarget } : {}),
		...(parentSessionFile ? { parentSessionFile } : {}),
		...(parentSessionId ? { parentSessionId } : {}),
		...(parentSessionName ? { parentSessionName } : {}),
		...(startedAt !== undefined ? { startedAt } : {}),
		...(computeDuration(startedAt, undefined, now) !== undefined ? { durationMs: computeDuration(startedAt, undefined, now) } : {}),
		detail: eventType ? `legacy untracked handler dir (${eventType})` : "legacy untracked handler dir",
	};
}

function scanSubagentForkDirs(root: string, now: number): ForkRun[] {
	try {
		return fs.readdirSync(root)
			.map((entry) => path.join(root, entry))
			.filter((entryPath) => {
				try { return fs.statSync(entryPath).isDirectory(); } catch { return false; }
			})
			.map((entryPath) => mapSubagentDir(entryPath, now))
			.filter((run): run is ForkRun => !!run);
	} catch {
		return [];
	}
}

function sortRuns(runs: ForkRun[]): ForkRun[] {
	const rank = (status: ForkStatus): number => {
		switch (status) {
			case "running": return 0;
			case "starting": return 1;
			case "stale": return 2;
			case "failed": return 3;
			case "unknown": return 4;
			case "complete": return 5;
		}
	};
	return [...runs].sort((a, b) => {
		const byStatus = rank(a.status) - rank(b.status);
		if (byStatus !== 0) return byStatus;
		return (b.startedAt ?? 0) - (a.startedAt ?? 0);
	});
}

export function scanForkRuns(options: ScanOptions = {}): ForkSummary {
	const now = options.now ?? Date.now();
	const homeDir = options.homeDir ?? os.homedir();
	const intercomState = readJsonFile<IntercomHandlersState>(getForkHandlersFile("intercom", homeDir));
	const returnOnState = readJsonFile<ReturnOnHandlersState>(getForkHandlersFile("return_on", homeDir));
	const subagentState = readJsonFile<SubagentHandlersState>(getForkHandlersFile("subagents", homeDir));
	const subagentRuns = (subagentState?.handlers ?? []).map((run) => mapSubagentRun(run, now)).filter((run): run is ForkRun => !!run);
	const persistedSubagentIds = new Set(subagentRuns.map((run) => run.id));
	const runs: ForkRun[] = [
		...(intercomState?.runs ?? []).map((run) => mapIntercomRun(run, now)).filter((run): run is ForkRun => !!run),
		...(returnOnState?.handlers ?? []).map((run) => mapReturnOnRun(run, now)).filter((run): run is ForkRun => !!run),
		...subagentRuns,
		...scanSubagentForkDirs(getForkHandlersDir("subagents", homeDir), now).filter((run) => !persistedSubagentIds.has(run.id)),
	];
	const sourceFilter = options.source ? new Set(Array.isArray(options.source) ? options.source : [options.source]) : undefined;
	let scoped = sourceFilter ? runs.filter((run) => sourceFilter.has(run.source)) : runs;
	if (options.parentSessionFile) scoped = scoped.filter((run) => run.parentSessionFile === options.parentSessionFile);
	if (options.parentSessionId) scoped = scoped.filter((run) => run.parentSessionId === options.parentSessionId);
	if (options.parentSessionName) scoped = scoped.filter((run) => run.parentSessionName === options.parentSessionName);
	if (options.userOnly) scoped = scoped.filter((run) => !run.parentSessionFile && !run.parentSessionId && !run.parentSessionName && !run.parentIntercomTarget);
	const filtered = scoped.filter((run) => options.includeCompleted || run.status === "running" || run.status === "starting" || run.status === "stale");
	const sorted = sortRuns(filtered);
	const limited = options.limit !== undefined ? sorted.slice(0, options.limit) : sorted;
	if (options.includeTokens !== false) {
		for (const run of limited) {
			const sinceMs = run.startedAt !== undefined ? Math.max(0, run.startedAt - 1_000) : undefined;
			const tokens = parseSessionTokens(run.sessionDir, sinceMs !== undefined ? { sinceMs } : {});
			if (tokens) run.tokens = tokens;
		}
	}
	const running = limited.filter((run) => run.status === "running" || run.status === "starting");
	const stale = limited.filter((run) => run.status === "stale");
	const countsByStatus: Record<ForkStatus, number> = { starting: 0, running: 0, complete: 0, failed: 0, stale: 0, unknown: 0 };
	for (const run of limited) countsByStatus[run.status] += 1;
	const totalTokens = sumRunTokens(limited);
	const maxRunningDurationMs = running.reduce((max, run) => Math.max(max, run.durationMs ?? 0), 0);
	return { runs: limited, running, stale, countsByStatus, totalTokens, maxRunningDurationMs };
}

function defaultAgentRoot(): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : process.env.UID ?? "unknown";
	return path.join(os.tmpdir(), `pi-subagents-uid-${uid}`, "async-subagent-runs");
}

export function emptyTokens(): TokenUsage {
	return { input: 0, output: 0, total: 0, cost: 0 };
}

export function addTokenUsage(acc: TokenUsage, tokens: TokenUsage | undefined): void {
	if (!tokens) return;
	acc.input += tokens.input;
	acc.output += tokens.output;
	acc.total += tokens.total;
	acc.cost = (acc.cost ?? 0) + (tokens.cost ?? 0);
}

export function finalizeTokens(acc: TokenUsage): TokenUsage {
	if (!acc.cost) delete acc.cost;
	return acc;
}

export function sumRunTokens(runs: Array<{ tokens?: TokenUsage }>): TokenUsage {
	const acc = emptyTokens();
	for (const run of runs) addTokenUsage(acc, run.tokens);
	return finalizeTokens(acc);
}

function tokensFromAttempts(attempts: unknown): TokenUsage {
	const tokens = emptyTokens();
	if (!Array.isArray(attempts)) return tokens;
	for (const attempt of attempts) {
		if (typeof attempt !== "object" || attempt === null) continue;
		const usage = (attempt as Record<string, unknown>).usage;
		if (typeof usage !== "object" || usage === null) continue;
		const values = usageNumbers(usage as Record<string, unknown>);
		addTokenUsage(tokens, { input: values.input, output: values.output, total: values.input + values.output, ...(values.cost !== undefined ? { cost: values.cost } : {}) });
	}
	return finalizeTokens(tokens);
}

function stepTokens(step: Record<string, unknown>): TokenUsage {
	const rawTokens = step.tokens;
	if (typeof rawTokens === "object" && rawTokens !== null) {
		const tokenRecord = rawTokens as Record<string, unknown>;
		const input = numberValue(tokenRecord.input) ?? 0;
		const output = numberValue(tokenRecord.output) ?? 0;
		const total = numberValue(tokenRecord.total) ?? input + output;
		let cost = numberValue(tokenRecord.cost);
		if (cost === undefined) {
			for (const attempt of Array.isArray(step.modelAttempts) ? step.modelAttempts : []) {
				if (typeof attempt !== "object" || attempt === null) continue;
				const usage = (attempt as Record<string, unknown>).usage;
				if (typeof usage === "object" && usage !== null) cost = (cost ?? 0) + (costValue((usage as Record<string, unknown>).cost) ?? 0);
			}
		}
		return { input, output, total, ...(cost ? { cost } : {}) };
	}
	return tokensFromAttempts(step.modelAttempts);
}

export function scanAgentSpend(options: AgentSpendOptions = {}): AgentSpendSummary {
	const parentSessionFile = options.parentSessionFile;
	const rootDir = options.rootDir ?? defaultAgentRoot();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(rootDir, { withFileTypes: true });
	} catch {
		return { runs: [], active: [], steps: 0, totalTokens: { input: 0, output: 0, total: 0 } };
	}
	const runs: AgentSpendRun[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const status = readJsonFile<Record<string, unknown>>(path.join(rootDir, entry.name, "status.json"));
		if (!status) continue;
		if (parentSessionFile && stringValue(status.sessionId) !== parentSessionFile) continue;
		const steps = Array.isArray(status.steps) ? status.steps.filter((step) => typeof step === "object" && step !== null) as Array<Record<string, unknown>> : [];
		const tokens = emptyTokens();
		for (const step of steps) addTokenUsage(tokens, stepTokens(step));
		finalizeTokens(tokens);
		const state = stringValue(status.state);
		const active = state === "running" || state === "starting" || state === "queued";
		runs.push({
			id: stringValue(status.runId) ?? entry.name,
			...(state ? { state } : {}),
			steps: steps.length,
			active,
			tokens,
			...(tokens.cost ? { cost: tokens.cost } : {}),
			...(stringValue(status.cwd) ? { cwd: stringValue(status.cwd) } : {}),
			...(numberValue(status.startedAt) ? { startedAt: numberValue(status.startedAt) } : {}),
			...(numberValue(status.endedAt) ? { endedAt: numberValue(status.endedAt) } : {}),
		});
	}
	const totalTokens = sumRunTokens(runs);
	const totalCost = totalTokens.cost;
	return {
		runs,
		active: runs.filter((run) => run.active),
		steps: runs.reduce((sum, run) => sum + run.steps, 0),
		totalTokens,
		...(totalCost ? { totalCost } : {}),
	};
}

function activeOrStale(run: ForkRun): boolean {
	return run.status === "running" || run.status === "starting" || run.status === "stale";
}

function addIssue(issues: ForkHealthIssue[], issue: ForkHealthIssue): void {
	issues.push(issue);
}

export function diagnoseForkRuns(options: ScanOptions = {}): ForkDiagnostics {
	const summary = scanForkRuns({ ...options, includeCompleted: true });
	const issues: ForkHealthIssue[] = [];
	for (const run of summary.runs) {
		const legacyUntracked = run.status === "unknown" && /^legacy untracked handler dir/.test(run.detail ?? "");
		if (run.status === "stale" && run.pidAlive === false) {
			addIssue(issues, {
				kind: "stale_pid",
				severity: "warning",
				source: run.source,
				runIds: [run.id],
				cwd: run.cwd,
				message: `${run.source}/${run.id} is stale: ${run.staleReason ?? `pid ${run.pid ?? "unknown"} is dead`}`,
			});
		} else if (run.status === "failed") {
			addIssue(issues, {
				kind: "failed",
				severity: "error",
				source: run.source,
				runIds: [run.id],
				cwd: run.cwd,
				message: `${run.source}/${run.id} failed: ${run.label}`,
			});
		} else if (run.status === "unknown") {
			addIssue(issues, {
				kind: "unknown",
				severity: "info",
				source: run.source,
				runIds: [run.id],
				cwd: run.cwd,
				message: legacyUntracked
					? `${run.source}/${run.id} is a legacy untracked handler dir without a shared handlers.json record`
					: `${run.source}/${run.id} has legacy/unknown status`,
				...(run.detail ? { detail: run.detail } : {}),
			});
		}
		if (activeOrStale(run) && (run.tokens?.total ?? 0) >= 50_000) {
			addIssue(issues, {
				kind: "high_cost_incomplete",
				severity: "warning",
				source: run.source,
				runIds: [run.id],
				cwd: run.cwd,
				message: `${run.source}/${run.id} is ${run.status} after ${run.tokens?.total ?? 0} tokens`,
			});
		}
	}

	const byCwd = new Map<string, ForkRun[]>();
	for (const run of summary.runs.filter((run) => activeOrStale(run) && !!run.cwd)) {
		const cwd = run.cwd as string;
		byCwd.set(cwd, [...(byCwd.get(cwd) ?? []), run]);
	}
	for (const [cwd, runs] of byCwd) {
		if (runs.length <= 1) continue;
		addIssue(issues, {
			kind: "duplicate_active_cwd",
			severity: runs.some((run) => run.status === "running" || run.status === "starting") ? "error" : "warning",
			runIds: runs.map((run) => run.id),
			cwd,
			message: `${runs.length} active/stale fork handlers share cwd ${cwd}`,
			detail: runs.map((run) => `${run.source}/${run.id}:${run.status}`).join(", "),
		});
	}

	return {
		summary,
		issues,
		totals: {
			tracked: summary.runs.length,
			running: summary.running.length,
			stale: summary.stale.length,
			failed: summary.countsByStatus.failed,
			complete: summary.countsByStatus.complete,
			unknown: summary.countsByStatus.unknown,
			deadPidRunningRecords: summary.runs.filter((run) => run.pidAlive === false && (run.rawStatus === "running" || run.rawStatus === "starting")).length,
			totalTokens: summary.totalTokens.total,
		},
	};
}
