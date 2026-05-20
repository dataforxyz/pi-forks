import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildForkIntercomIdentity, getForkHandlersDir, getForkHandlersFile, getForkStateDir, isProcessAlive, type ForkSource, type ForkStatus } from "./runtime.ts";

export type { ForkSource, ForkStatus } from "./runtime.ts";

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

export interface ForkRun {
	source: ForkSource;
	id: string;
	label: string;
	status: ForkStatus;
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
	totalTokens: TokenUsage;
	maxRunningDurationMs: number;
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

function usageNumbers(usage: Record<string, unknown>): Pick<TokenUsage, "input" | "output"> {
	const input = numberValue(usage.inputTokens) ?? numberValue(usage.input) ?? 0;
	const output = numberValue(usage.outputTokens) ?? numberValue(usage.output) ?? 0;
	return { input, output };
}

export function parseSessionTokens(sessionDir: string | undefined): TokenUsage | undefined {
	if (!sessionDir) return undefined;
	const sessionFile = findLatestSessionFile(sessionDir);
	if (!sessionFile) return undefined;
	let input = 0;
	let output = 0;
	try {
		const content = fs.readFileSync(sessionFile, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				const direct = entry.usage;
				const nested = typeof entry.message === "object" && entry.message !== null
					? (entry.message as Record<string, unknown>).usage
					: undefined;
				const usage = (typeof direct === "object" && direct !== null ? direct : nested) as Record<string, unknown> | undefined;
				if (!usage) continue;
				const values = usageNumbers(usage);
				input += values.input;
				output += values.output;
			} catch {
				// Ignore malformed jsonl entries while collecting telemetry.
			}
		}
	} catch {
		return undefined;
	}
	const total = input + output;
	return total > 0 ? { input, output, total } : undefined;
}

function mapIntercomRun(run: Record<string, unknown>, now: number): ForkRun | undefined {
	const id = stringValue(run.id);
	if (!id) return undefined;
	const startedAt = numberValue(run.startedAt);
	const endedAt = numberValue(run.endedAt);
	const pid = numberValue(run.pid);
	const pidAlive = isProcessAlive(pid);
	const status = effectiveStatus(statusValue(run.status), pidAlive);
	const from = stringValue(run.from);
	const messageId = stringValue(run.messageId);
	const sessionDir = stringValue(run.sessionDir);
	const parentIntercomTarget = stringValue(run.parentIntercomTarget) ?? stringValue(run.parentSessionName);
	const parentSessionFile = stringValue(run.parentSessionFile);
	const parentSessionId = stringValue(run.parentSessionId);
	const parentSessionName = stringValue(run.parentSessionName);
	return {
		source: "intercom",
		id,
		label: from ? `from ${from}` : id,
		status,
		...intercomMetadata("intercom", id),
		...(pid !== undefined ? { pid } : {}),
		...(pidAlive !== undefined ? { pidAlive } : {}),
		...(stringValue(run.cwd) ? { cwd: stringValue(run.cwd) } : {}),
		...(stringValue(run.dir) ? { dir: stringValue(run.dir) } : {}),
		...(sessionDir ? { sessionDir } : {}),
		...(parentIntercomTarget ? { parentIntercomTarget } : {}),
		...(parentSessionFile ? { parentSessionFile } : {}),
		...(parentSessionId ? { parentSessionId } : {}),
		...(parentSessionName ? { parentSessionName } : {}),
		...(startedAt !== undefined ? { startedAt } : {}),
		...(endedAt !== undefined ? { endedAt } : {}),
		...(computeDuration(startedAt, endedAt, now) !== undefined ? { durationMs: computeDuration(startedAt, endedAt, now) } : {}),
		...(messageId ? { detail: `message ${messageId}` } : {}),
	};
}

function mapReturnOnRun(run: Record<string, unknown>, now: number): ForkRun | undefined {
	const id = stringValue(run.id);
	if (!id) return undefined;
	const startedAt = numberValue(run.startedAt);
	const endedAt = numberValue(run.endedAt);
	const pid = numberValue(run.pid);
	const pidAlive = isProcessAlive(pid);
	const status = effectiveStatus(statusValue(run.status), pidAlive);
	const sessionDir = stringValue(run.sessionDir);
	const label = stringValue(run.label) ?? stringValue(run.jobId) ?? id;
	const parentIntercomTarget = stringValue(run.parentIntercomTarget) ?? stringValue(run.parentSessionName);
	const parentSessionFile = stringValue(run.parentSessionFile);
	const parentSessionId = stringValue(run.parentSessionId);
	const parentSessionName = stringValue(run.parentSessionName);
	return {
		source: "return_on",
		id,
		label,
		status,
		...intercomMetadata("return_on", id),
		...(pid !== undefined ? { pid } : {}),
		...(pidAlive !== undefined ? { pidAlive } : {}),
		...(stringValue(run.cwd) ? { cwd: stringValue(run.cwd) } : {}),
		...(stringValue(run.dir) ? { dir: stringValue(run.dir) } : {}),
		...(sessionDir ? { sessionDir } : {}),
		...(parentIntercomTarget ? { parentIntercomTarget } : {}),
		...(parentSessionFile ? { parentSessionFile } : {}),
		...(parentSessionId ? { parentSessionId } : {}),
		...(parentSessionName ? { parentSessionName } : {}),
		...(startedAt !== undefined ? { startedAt } : {}),
		...(endedAt !== undefined ? { endedAt } : {}),
		...(computeDuration(startedAt, endedAt, now) !== undefined ? { durationMs: computeDuration(startedAt, endedAt, now) } : {}),
		...(stringValue(run.jobId) ? { detail: `job ${stringValue(run.jobId)}` } : {}),
	};
}

function mapSubagentRun(run: Record<string, unknown>, now: number): ForkRun | undefined {
	const id = stringValue(run.id);
	if (!id) return undefined;
	const startedAt = numberValue(run.startedAt);
	const endedAt = numberValue(run.endedAt);
	const pid = numberValue(run.pid);
	const pidAlive = isProcessAlive(pid);
	const status = effectiveStatus(statusValue(run.status), pidAlive);
	const sessionDir = stringValue(run.sessionDir);
	const title = stringValue(run.title) ?? id;
	const parentIntercomTarget = stringValue(run.parentIntercomTarget) ?? stringValue(run.parentSessionName);
	const parentSessionFile = stringValue(run.parentSessionFile);
	const parentSessionId = stringValue(run.parentSessionId);
	const parentSessionName = stringValue(run.parentSessionName);
	return {
		source: "subagents",
		id,
		label: title,
		status,
		...intercomMetadata("subagents", id),
		...(pid !== undefined ? { pid } : {}),
		...(pidAlive !== undefined ? { pidAlive } : {}),
		...(stringValue(run.cwd) ? { cwd: stringValue(run.cwd) } : {}),
		...(stringValue(run.dir) ? { dir: stringValue(run.dir) } : {}),
		...(sessionDir ? { sessionDir } : {}),
		...(parentIntercomTarget ? { parentIntercomTarget } : {}),
		...(parentSessionFile ? { parentSessionFile } : {}),
		...(parentSessionId ? { parentSessionId } : {}),
		...(parentSessionName ? { parentSessionName } : {}),
		...(startedAt !== undefined ? { startedAt } : {}),
		...(endedAt !== undefined ? { endedAt } : {}),
		...(computeDuration(startedAt, endedAt, now) !== undefined ? { durationMs: computeDuration(startedAt, endedAt, now) } : {}),
		...(stringValue(run.type) ? { detail: stringValue(run.type) } : {}),
	};
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
		...(eventType ? { detail: eventType } : {}),
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
	for (const run of limited) {
		const tokens = parseSessionTokens(run.sessionDir);
		if (tokens) run.tokens = tokens;
	}
	const running = limited.filter((run) => run.status === "running" || run.status === "starting");
	const totalTokens = limited.reduce<TokenUsage>((acc, run) => {
		acc.input += run.tokens?.input ?? 0;
		acc.output += run.tokens?.output ?? 0;
		acc.total += run.tokens?.total ?? 0;
		return acc;
	}, { input: 0, output: 0, total: 0 });
	const maxRunningDurationMs = running.reduce((max, run) => Math.max(max, run.durationMs ?? 0), 0);
	return { runs: limited, running, totalTokens, maxRunningDurationMs };
}
