import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { diagnoseForkRuns, parseSessionTokenFile, scanAgentSpend, scanForkRuns, type AgentSpendSummary, type ForkDiagnostics, type ForkRun, type ForkSource, type ForkSummary, type TokenUsage } from "./monitor.ts";
import {
	compactRunStats,
	cyan,
	formatDuration,
	formatSpend,
	formatTokens,
	forkIcon,
	orange,
	runStats,
	statusColor,
	statusGlyph,
	stripAnsi,
	truncate,
	violet,
	visibleLength,
	type ThemeLike,
} from "./formatting.ts";

const EXTENSION_KEY = "pi-forks";
const SPEND_STATUS_KEY = "pi-forks-spend";
const WIDGET_KEY = "pi-forks";
const REFRESH_MS = 2_000;
const TOKEN_REFRESH_MS = 10_000;
const WIDGET_LIMIT = 8;
const FORKS_SHORTCUT = "ctrl+alt+f";
const FORKS_SHORTCUT_ALIAS = "alt+ctrl+f";
const FORKS_SHORTCUT_LABEL = "Ctrl+Alt+F";
const FORKS_MODAL_BODY_LINES = 12;
const SOURCES: ForkSource[] = ["intercom", "return_on", "subagents"];

type ViewScope = "chat" | "response_handlers" | "subagents" | "user" | "all";
type SortMode = "status" | "newest" | "oldest" | "duration" | "source" | "label";

const SCOPE_ORDER: ViewScope[] = ["chat", "response_handlers", "subagents", "user", "all"];
const SORT_ORDER: SortMode[] = ["status", "newest", "oldest", "duration", "source", "label"];

interface ViewOptions {
	source?: ForkSource | ForkSource[];
	includeCompleted?: boolean;
	includeTokens?: boolean;
	allSources?: boolean;
	scope?: ViewScope;
	parentSessionFile?: string;
	parentSessionId?: string;
	parentSessionName?: string;
	cwd?: string;
	userOnly?: boolean;
	relatedOnly?: boolean;
	sortMode?: SortMode;
	sortDesc?: boolean;
	diagnose?: boolean;
}

let latestCtx: ExtensionContext | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let lastSpendStatus: string | undefined;
let lastSpendStatusAt = 0;
let lastSpendScopeKey: string | undefined;

function configuredSource(): ForkSource | undefined {
	const raw = process.env.PI_FORKS_SOURCE;
	return SOURCES.includes(raw as ForkSource) ? raw as ForkSource : undefined;
}

function inferSourceFromPath(value: string | undefined): ForkSource | undefined {
	if (!value) return undefined;
	if (/pi-return-on|return_on/i.test(value)) return "return_on";
	if (/pi-intercom|intercom/i.test(value)) return "intercom";
	if (/pi-subagents|subagents/i.test(value)) return "subagents";
	return undefined;
}

function relatedSource(ctx?: ExtensionContext): ForkSource | undefined {
	return configuredSource() ?? inferSourceFromPath(ctx?.cwd) ?? inferSourceFromPath(process.cwd());
}

function parseScope(word: string): ViewScope | undefined {
	if (["chat", "current", "current-chat", "this-chat", "session"].includes(word)) return "chat";
	if (["responses", "response", "response-handlers", "handlers"].includes(word)) return "response_handlers";
	if (["subagent", "subagents"].includes(word)) return "subagents";
	if (["user", "manual", "user-forks"].includes(word)) return "user";
	if (["all", "global", "all-sources"].includes(word)) return "all";
	return undefined;
}

function parseSortMode(word: string): SortMode | undefined {
	const cleaned = word.replace(/^--sort=?/, "");
	return SORT_ORDER.includes(cleaned as SortMode) ? cleaned as SortMode : undefined;
}

function parseArgs(args: string): ViewOptions {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const allSources = words.some((word) => word === "--all-sources" || word === "--global");
	const includeCompleted = words.some((word) => word === "--all" || word === "-a");
	const relatedFlag = words.some((word) => word === "--related");
	const unrelatedFlag = words.some((word) => word === "--unrelated" || word === "--not-related");
	const source = words.find((word): word is ForkSource => SOURCES.includes(word as ForkSource));
	const scope = words.map(parseScope).find((value): value is ViewScope => !!value);
	const sortMode = words.map(parseSortMode).find((value): value is SortMode => !!value);
	const sortDesc = words.some((word) => word === "--desc" || word === "--reverse");
	const diagnose = words.some((word) => word === "--diagnose" || word === "--health");
	return { source, includeCompleted, allSources, sortDesc, diagnose, ...(relatedFlag || unrelatedFlag ? { relatedOnly: relatedFlag && !unrelatedFlag } : {}), ...(scope ? { scope } : {}), ...(sortMode ? { sortMode } : {}) };
}

function sourceLabel(source: ForkRun["source"]): string {
	if (source === "return_on") return "return_on";
	if (source === "intercom") return "intercom";
	return "subagents";
}

function scopeLabel(options: ViewOptions): string {
	if (options.scope === "chat") return "this chat";
	if (options.scope === "response_handlers") return "response handlers";
	if (options.scope === "subagents") return "subagents";
	if (options.scope === "user") return "user forks";
	if (options.scope === "all" || options.allSources) return "all forks";
	if (Array.isArray(options.source)) return options.source.map(sourceLabel).join("+");
	return options.source ? sourceLabel(options.source) : "forks";
}

function sourceTitle(source: ForkSource | ForkSource[] | undefined, allSources: boolean): string {
	if (allSources) return "All fork handlers";
	if (!source) return "Fork handlers";
	if (Array.isArray(source)) return `${source.map(sourceLabel).join("+")} forks`;
	return `${sourceLabel(source)} forks`;
}

function sourceColor(source: ForkRun["source"]): string {
	if (source === "return_on") return "warning";
	if (source === "intercom") return "accent";
	return "success";
}

function fileInsideDir(file: string | undefined, dir: string | undefined): boolean {
	if (!file || !dir) return false;
	const normalizedDir = dir.endsWith("/") ? dir : `${dir}/`;
	return file === dir || file.startsWith(normalizedDir);
}

function runMatchesCurrentSession(run: ForkRun, options: ViewOptions): boolean {
	if (options.parentSessionFile && run.parentSessionFile === options.parentSessionFile) return true;
	if (options.parentSessionId && run.parentSessionId === options.parentSessionId) return true;
	if (options.parentSessionName && (run.parentSessionName === options.parentSessionName || run.parentIntercomTarget === options.parentSessionName)) return true;
	// Vice versa: this Pi chat may itself be the fork session being monitored.
	if (fileInsideDir(options.parentSessionFile, run.sessionDir)) return true;
	// User/manual forks often lack parent metadata; same cwd is only considered
	// related inside the explicit user-forks scope, so fresh chats stay quiet.
	if ((options.scope === "user" || options.userOnly) && options.cwd && run.cwd && run.cwd === options.cwd) return true;
	return false;
}

function rebuildSummary(runs: ForkRun[]): ForkSummary {
	const running = runs.filter((run) => run.status === "running" || run.status === "starting");
	const stale = runs.filter((run) => run.status === "stale");
	const countsByStatus: ForkSummary["countsByStatus"] = { starting: 0, running: 0, complete: 0, failed: 0, stale: 0, unknown: 0 };
	for (const run of runs) countsByStatus[run.status] += 1;
	const totalTokens = runs.reduce((acc, run) => {
		acc.input += run.tokens?.input ?? 0;
		acc.output += run.tokens?.output ?? 0;
		acc.total += run.tokens?.total ?? 0;
		acc.cost = (acc.cost ?? 0) + (run.tokens?.cost ?? 0);
		return acc;
	}, { input: 0, output: 0, total: 0, cost: 0 });
	if (!totalTokens.cost) delete totalTokens.cost;
	const maxRunningDurationMs = running.reduce((max, run) => Math.max(max, run.durationMs ?? 0), 0);
	return { runs, running, stale, countsByStatus, totalTokens, maxRunningDurationMs };
}

function sortValue(run: ForkRun, mode: SortMode): string | number {
	if (mode === "newest" || mode === "oldest") return run.startedAt ?? 0;
	if (mode === "duration") return run.durationMs ?? 0;
	if (mode === "source") return sourceLabel(run.source);
	if (mode === "label") return run.label.toLowerCase();
	const rank: Record<ForkRun["status"], number> = { running: 0, starting: 1, stale: 2, failed: 3, unknown: 4, complete: 5 };
	return rank[run.status];
}

function sortRunsForView(runs: ForkRun[], mode: SortMode, reverse: boolean): ForkRun[] {
	const defaultDesc = mode === "newest" || mode === "duration";
	const desc = reverse ? !defaultDesc : defaultDesc;
	return [...runs].sort((a, b) => {
		const av = sortValue(a, mode);
		const bv = sortValue(b, mode);
		let cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
		if (cmp === 0) cmp = (b.startedAt ?? 0) - (a.startedAt ?? 0);
		return desc ? -cmp : cmp;
	});
}

function buildStatus(summary: ForkSummary, _options: ViewOptions, theme?: ThemeLike): string | undefined {
	if (summary.running.length === 0 && summary.stale.length === 0) return undefined;
	const global = summarize({ allSources: true });
	const globalRunning = global.running.length;
	const globalStale = global.stale.length;
	const activeCount = Math.max(summary.running.length + summary.stale.length, globalRunning + globalStale);
	const iconText = forkIcon(activeCount);
	const color = summary.running.length > 0 || globalRunning > 0 ? "success" : "warning";
	const icon = theme ? theme.fg(color, iconText) : iconText;
	const runningText = globalRunning > summary.running.length ? `${summary.running.length}/${globalRunning} running` : `${summary.running.length} running`;
	const staleText = globalStale > 0
		? globalStale > summary.stale.length ? `${summary.stale.length}/${globalStale} stale` : `${summary.stale.length} stale`
		: undefined;
	const countText = [runningText, staleText].filter(Boolean).join(" · ");
	const count = theme ? theme.fg(color, countText) : countText;
	const hint = theme ? theme.fg("dim", FORKS_SHORTCUT_LABEL) : FORKS_SHORTCUT_LABEL;
	return `${icon} ${count} · ${hint}`;
}

function buildSpendStatus(threadTokens: TokenUsage | undefined, agentSpend: AgentSpendSummary, forkSummary: ForkSummary): string | undefined {
	const parts: string[] = [];
	const thread = formatSpend(threadTokens);
	if (thread) parts.push(cyan(`◉ dialog ${thread}`));
	const agents = formatSpend(agentSpend.totalTokens, agentSpend.totalCost);
	if (agents) {
		const active = agentSpend.active.length > 0 ? ` (${agentSpend.active.length} active)` : "";
		parts.push(violet(`◆ agents ${agents}${active}`));
	}
	const forks = formatSpend(forkSummary.totalTokens);
	if (forks) {
		const runCount = forkSummary.runs.filter((run) => (run.tokens?.total ?? 0) > 0).length;
		const runLabel = runCount === 1 ? "fork" : "forks";
		parts.push(orange(`↯ ${runLabel} ${forks}`));
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

function buildWidget(summary: ForkSummary, options: ViewOptions, theme?: ThemeLike): string[] | undefined {
	if (summary.runs.length === 0) return undefined;
	const active = summary.running.length > 0 || summary.stale.length > 0;
	const title = sourceTitle(options.source, !!options.allSources);
	const lines: string[] = [];
	lines.push(theme ? theme.fg(active ? "accent" : "muted", `╭─ ${title}`) : `╭─ ${title}`);
	const meta = [`${summary.running.length} running`, summary.stale.length > 0 ? `${summary.stale.length} stale` : undefined, `${summary.runs.length} tracked`, `${formatTokens(summary.totalTokens.total)} tok`].filter(Boolean).join(" · ");
	lines.push(theme ? theme.fg("dim", `│  ${meta}`) : `│  ${meta}`);
	for (const run of summary.runs.slice(0, WIDGET_LIMIT)) {
		const glyph = theme ? theme.fg(statusColor(run.status), statusGlyph(run.status)) : statusGlyph(run.status);
		const source = theme ? theme.fg(sourceColor(run.source), sourceLabel(run.source)) : sourceLabel(run.source);
		const label = theme ? theme.bold(truncate(run.label, 36)) : truncate(run.label, 36);
		lines.push(`├─ ${glyph} ${source} ${label} ${theme ? theme.fg("dim", "·") : "·"} ${runStats(run, theme)}`);
		const detail = [
			run.intercomTarget ? `↔ ${run.intercomTarget}` : undefined,
			run.parentIntercomTarget ? `parent ${run.parentIntercomTarget}` : undefined,
			run.detail ?? run.id,
		].filter(Boolean).join(" · ");
		lines.push(theme ? theme.fg("dim", `│  ⎿ ${truncate(detail, 96)}`) : `│  ⎿ ${truncate(detail, 96)}`);
	}
	if (summary.runs.length > WIDGET_LIMIT) lines.push(theme ? theme.fg("dim", `├─ +${summary.runs.length - WIDGET_LIMIT} more`) : `├─ +${summary.runs.length - WIDGET_LIMIT} more`);
	lines.push(theme ? theme.fg("muted", "╰─ /forks <intercom|return_on|subagents> · /forks --all-sources") : "╰─ /forks <intercom|return_on|subagents> · /forks --all-sources");
	return lines;
}

function formatRunLine(run: ForkRun, theme?: ThemeLike): string {
	const source = theme ? theme.fg(sourceColor(run.source), sourceLabel(run.source)) : sourceLabel(run.source);
	const status = theme ? theme.fg(statusColor(run.status), `[${run.status}]`) : `[${run.status}]`;
	const details = [
		`${source}/${run.id}`,
		status,
		run.label,
		run.durationMs !== undefined ? formatDuration(run.durationMs) : undefined,
		run.tokens?.total ? `${formatTokens(run.tokens.total)} tok` : undefined,
		run.pid ? `pid=${run.pid}${run.pidAlive === false ? "(dead)" : ""}` : undefined,
		run.rawStatus ? `raw=${run.rawStatus}` : undefined,
		run.staleReason ? `stale=${run.staleReason}` : undefined,
		run.intercomTarget ? `intercom=${run.intercomTarget}` : undefined,
		run.parentIntercomTarget ? `parent=${run.parentIntercomTarget}` : undefined,
		run.detail,
		run.dir,
	].filter(Boolean);
	return details.join(theme ? theme.fg("dim", " | ") : " | ");
}

function formatCommandOutput(summary: ForkSummary, options: ViewOptions, theme?: ThemeLike): string {
	const titleText = scopeLabel(options);
	if (summary.runs.length === 0) return `No ${titleText.toLowerCase()} found.`;
	const title = theme ? theme.fg("accent", theme.bold(titleText)) : titleText;
	const counts = [`${summary.running.length} running`, summary.stale.length > 0 ? `${summary.stale.length} stale` : undefined, `${summary.runs.length} tracked`, `${formatTokens(summary.totalTokens.total)} tokens`].filter(Boolean).join(", ");
	const header = `${title}: ${counts}`;
	return [header, "", ...summary.runs.map((run) => formatRunLine(run, theme))].join("\n");
}

function formatDiagnostics(diagnostics: ForkDiagnostics, options: ViewOptions, theme?: ThemeLike): string {
	const titleText = `${scopeLabel(options)} health`;
	const title = theme ? theme.fg("accent", theme.bold(titleText)) : titleText;
	const totals = diagnostics.totals;
	const header = `${title}: ${totals.tracked} tracked · ${totals.running} running · ${totals.stale} stale · ${totals.failed} failed · ${formatTokens(totals.totalTokens)} tokens`;
	const lines = [header, `dead-pid active records: ${totals.deadPidRunningRecords}`];
	if (diagnostics.issues.length === 0) {
		lines.push("No health issues found.");
		return lines.join("\n");
	}
	lines.push("", "Issues:");
	for (const issue of diagnostics.issues) {
		const severity = theme ? theme.fg(issue.severity === "error" ? "error" : issue.severity === "warning" ? "warning" : "muted", issue.severity) : issue.severity;
		lines.push(`- [${severity}] ${issue.kind}: ${issue.message}`);
		if (issue.detail) lines.push(`  ${issue.detail}`);
		if (issue.runIds.length > 1) lines.push(`  runs: ${issue.runIds.join(", ")}`);
	}
	return lines.join("\n");
}

function matchesInput(data: string, key: string): boolean {
	const aliases: Record<string, string[]> = {
		escape: ["\u001b", "escape", "esc", "\u001b[27u", "\u001b[27;1u", "\u001b[27;1;27~"],
		enter: ["\r", "\n", "return", "enter"],
		up: ["\u001b[A", "up", "\u001b[1;1A"],
		down: ["\u001b[B", "down", "\u001b[1;1B"],
		pageUp: ["\u001b[5~", "pageup", "page-up"],
		pageDown: ["\u001b[6~", "pagedown", "page-down"],
		home: ["\u001b[H", "\u001b[1~", "home"],
		end: ["\u001b[F", "\u001b[4~", "end"],
	};
	if (aliases[key]?.includes(data)) return true;
	if (key === "escape") return /^\u001b\[(?:27;1;27~|27(?:;1)?u)$/.test(data);
	return false;
}

class ForksModal {
	private selectedIndex = 0;
	private scroll = 0;
	private includeCompleted: boolean;
	private relatedOnly: boolean;
	private scope: ViewScope | undefined;
	private sortMode: SortMode;
	private sortDesc: boolean;
	private cachedLines: string[] | undefined;
	private cachedWidth: number | undefined;
	private options: ViewOptions;
	private theme: ThemeLike;
	private done: () => void;

	constructor(options: ViewOptions, theme: ThemeLike, done: () => void) {
		this.options = options;
		this.theme = theme;
		this.done = done;
		this.includeCompleted = !!options.includeCompleted;
		this.relatedOnly = options.relatedOnly ?? true;
		this.scope = options.scope ?? (options.allSources ? "all" : undefined);
		this.sortMode = options.sortMode ?? "status";
		this.sortDesc = !!options.sortDesc;
	}

	handleInput(data: string): void {
		// Close keys must be handled before rescanning fork state. If a scan is slow
		// or a state file is temporarily wedged, Esc/q should still dismiss the modal.
		if (data === "\u0003" || data === FORKS_SHORTCUT || data === FORKS_SHORTCUT_ALIAS || matchesInput(data, "escape") || data === "q" || data === "Q") {
			this.done();
			return;
		}
		const summary = this.summary();
		this.clampSelection(summary.runs.length);
		const maxScroll = Math.max(0, this.getCachedBodyLength() - FORKS_MODAL_BODY_LINES);
		if (data === "a") {
			const current = this.scope ?? "chat";
			this.scope = SCOPE_ORDER[(SCOPE_ORDER.indexOf(current) + 1) % SCOPE_ORDER.length] ?? "chat";
			this.resetView();
		} else if (data === "t") {
			this.relatedOnly = !this.relatedOnly;
			this.resetView();
		} else if (data === "c") {
			this.includeCompleted = !this.includeCompleted;
			this.resetView();
		} else if (data === "s") {
			this.sortMode = SORT_ORDER[(SORT_ORDER.indexOf(this.sortMode) + 1) % SORT_ORDER.length] ?? "status";
			this.resetView();
		} else if (data === "v") {
			this.sortDesc = !this.sortDesc;
			this.resetView();
		} else if (data === "r") {
			this.invalidate();
		} else if (data === "j" || matchesInput(data, "down")) {
			this.selectedIndex = Math.min(summary.runs.length - 1, this.selectedIndex + 1);
			this.ensureSelectedVisible();
		} else if (data === "k" || matchesInput(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.ensureSelectedVisible();
		} else if (matchesInput(data, "pageDown")) {
			this.selectedIndex = Math.min(summary.runs.length - 1, this.selectedIndex + FORKS_MODAL_BODY_LINES - 6);
			this.ensureSelectedVisible();
		} else if (matchesInput(data, "pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - (FORKS_MODAL_BODY_LINES - 6));
			this.ensureSelectedVisible();
		} else if (matchesInput(data, "home")) {
			this.selectedIndex = 0;
			this.ensureSelectedVisible();
		} else if (matchesInput(data, "end")) {
			this.selectedIndex = Math.max(0, summary.runs.length - 1);
			this.ensureSelectedVisible();
		} else if (data === "J") this.scroll = Math.min(maxScroll, this.scroll + 1);
		else if (data === "K") this.scroll = Math.max(0, this.scroll - 1);
		else return;
		this.invalidate();
	}

	render(width: number): string[] {
		const frameWidth = Math.max(56, width);
		const innerWidth = Math.max(20, frameWidth - 4);
		const summary = this.summary();
		this.clampSelection(summary.runs.length);
		const body = this.getBodyLines(innerWidth, summary);
		const maxScroll = Math.max(0, body.length - FORKS_MODAL_BODY_LINES);
		this.scroll = Math.min(this.scroll, maxScroll);
		const visibleBody = body.slice(this.scroll, this.scroll + FORKS_MODAL_BODY_LINES);
		const scope = scopeLabel({ ...this.options, scope: this.scope, allSources: this.scope === "all" });
		const globalRunning = summarize({ scope: "all" }).running.length;
		const titleCount = globalRunning > summary.running.length ? `${summary.running.length} running/${globalRunning} total` : `${summary.running.length} running`;
		const title = `${this.theme.fg("success", forkIcon(Math.max(summary.running.length, globalRunning)))} ${this.theme.fg("accent", "fork handlers")} ${this.theme.fg("dim", `${titleCount} · ${summary.runs.length} shown · ${scope}`)}`;
		const range = body.length > FORKS_MODAL_BODY_LINES ? ` · lines ${this.scroll + 1}-${Math.min(body.length, this.scroll + FORKS_MODAL_BODY_LINES)}/${body.length}` : "";
		const help = this.theme.fg("dim", `↑/↓ select · a scope · t related · c completed · s sort · v reverse · Esc/q close${range}`);
		return [
			this.theme.fg("muted", this.border("┌", "┐", frameWidth)),
			this.frameLine(title, frameWidth),
			this.theme.fg("muted", this.border("├", "┤", frameWidth)),
			...visibleBody.map((line) => this.frameLine(line, frameWidth)),
			...(visibleBody.length === 0 ? [this.frameLine("", frameWidth)] : []),
			this.theme.fg("muted", this.border("├", "┤", frameWidth)),
			this.frameLine(help, frameWidth),
			this.theme.fg("muted", this.border("└", "┘", frameWidth)),
		];
	}

	private summary(): ForkSummary {
		return summarize({ ...this.options, scope: this.scope, includeCompleted: this.includeCompleted, relatedOnly: this.relatedOnly, sortMode: this.sortMode, sortDesc: this.sortDesc, allSources: this.scope === "all" });
	}

	private resetView(): void {
		this.scroll = 0;
		this.selectedIndex = 0;
		this.invalidate();
	}

	private invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	private clampSelection(count: number): void {
		if (count <= 0) {
			this.selectedIndex = 0;
			return;
		}
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, count - 1));
	}

	private ensureSelectedVisible(): void {
		const row = 3 + this.selectedIndex;
		if (row < this.scroll) this.scroll = row;
		else if (row >= this.scroll + FORKS_MODAL_BODY_LINES) this.scroll = row - FORKS_MODAL_BODY_LINES + 1;
		this.scroll = Math.max(0, this.scroll);
	}

	private getCachedBodyLength(): number {
		return this.cachedLines?.length ?? 0;
	}

	private getBodyLines(innerWidth: number, summary: ForkSummary): string[] {
		this.clampSelection(summary.runs.length);
		const lines: string[] = [];
		const push = (line = "") => lines.push(line);
		const scope = scopeLabel({ ...this.options, scope: this.scope, allSources: this.scope === "all" });
		push(`${this.theme.fg("dim", "Scope:")} ${this.theme.fg("accent", scope)} ${this.theme.fg("muted", "· related:")} ${this.theme.fg("accent", this.relatedOnly ? "only" : "off")} ${this.theme.fg("muted", "· completed:")} ${this.theme.fg("accent", this.includeCompleted ? "shown" : "hidden")} ${this.theme.fg("muted", "· sort:")} ${this.theme.fg("accent", `${this.sortMode}${this.sortDesc ? " reversed" : ""}`)}`);
		if (summary.runs.length === 0) {
			push(this.theme.fg("warning", `No fork handlers for ${scope}.`));
		} else {
			for (const [index, run] of summary.runs.entries()) push(this.formatRunRow(run, index, innerWidth));
		}
		this.cachedLines = lines;
		this.cachedWidth = innerWidth;
		return lines;
	}

	private formatRunRow(run: ForkRun, index: number, innerWidth: number): string {
		const selected = index === this.selectedIndex;
		const marker = selected ? this.theme.fg("accent", "›") : " ";
		const number = selected ? this.theme.fg("accent", `${index + 1}.`) : this.theme.fg("dim", `${index + 1}.`);
		const glyph = this.theme.fg(statusColor(run.status), statusGlyph(run.status));
		const source = this.theme.fg(sourceColor(run.source), sourceLabel(run.source));
		const labelBudget = Math.max(16, Math.min(48, innerWidth - 58));
		const label = this.theme.fg("accent", truncate(run.label, labelBudget));
		const stats = this.theme.fg("dim", compactRunStats(run));
		return `${marker} ${number} ${glyph} ${source} ${label} ${this.theme.fg("muted", "·")} ${stats}`;
	}

	private border(left: string, right: string, width: number): string {
		return `${left}${"─".repeat(Math.max(0, width - 2))}${right}`;
	}

	private frameLine(content: string, width: number): string {
		const innerWidth = Math.max(1, width - 4);
		let text = content;
		if (visibleLength(text) > innerWidth) text = `${stripAnsi(text).slice(0, Math.max(0, innerWidth - 1))}…`;
		const padding = " ".repeat(Math.max(0, innerWidth - visibleLength(text)));
		return `│ ${text}${padding} │`;
	}
}

async function showForksModal(ctx: ExtensionContext, options: ViewOptions): Promise<void> {
	latestCtx = ctx;
	const summary = summarize(options);
	if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
		ctx.ui.notify(formatCommandOutput(summary, options, ctx.ui.theme), "info");
		return;
	}
	await ctx.ui.custom<void>(
		(_tui, theme, _keybindings, done) => new ForksModal(options, theme, done),
		{
			overlay: true,
			overlayOptions: {
				width: "72%",
				minWidth: 54,
				maxHeight: "60%",
				anchor: "center",
				margin: 1,
			},
		},
	);
	render(ctx);
}

function summarize(options: ViewOptions): ForkSummary {
	const scope = options.scope;
	const allSources = options.allSources || scope === "all" || scope === "chat";
	const source = scope === "response_handlers"
		? ["return_on", "intercom"] as ForkSource[]
		: scope === "subagents"
			? "subagents" as ForkSource
			: options.source;
	const scanned = scanForkRuns({
		includeCompleted: options.includeCompleted,
		includeTokens: options.includeTokens,
		...(allSources || !source ? {} : { source }),
		...(scope === "user" || options.userOnly ? { userOnly: true } : {}),
	});
	let runs = scanned.runs;
	if (options.relatedOnly || scope === "chat") runs = runs.filter((run) => runMatchesCurrentSession(run, options));
	runs = sortRunsForView(runs, options.sortMode ?? "status", !!options.sortDesc);
	return rebuildSummary(runs);
}

function runningCount(options: ViewOptions): number {
	return summarize({ ...options, includeCompleted: false }).running.length;
}

function sessionScope(ctx?: ExtensionContext): Pick<ViewOptions, "parentSessionFile" | "parentSessionId" | "parentSessionName" | "cwd"> {
	return {
		...(ctx?.sessionManager.getSessionFile() ? { parentSessionFile: ctx.sessionManager.getSessionFile() } : {}),
		...(ctx?.sessionManager.getSessionId() ? { parentSessionId: ctx.sessionManager.getSessionId() } : {}),
		...(ctx?.sessionManager.getSessionName() ? { parentSessionName: ctx.sessionManager.getSessionName() } : {}),
		...(ctx?.cwd ? { cwd: ctx.cwd } : {}),
	};
}

function defaultOptions(ctx?: ExtensionContext): ViewOptions | undefined {
	const scope = sessionScope(ctx);
	return Object.keys(scope).length > 0 ? { scope: "chat", relatedOnly: true, ...scope } : undefined;
}

function spendScopeKey(options: ViewOptions): string {
	return JSON.stringify({
		scope: options.scope,
		parentSessionFile: options.parentSessionFile,
		parentSessionId: options.parentSessionId,
		parentSessionName: options.parentSessionName,
		cwd: options.cwd,
	});
}

function currentSpend(options: ViewOptions): { threadTokens?: TokenUsage; agentSpend: AgentSpendSummary; forkSummary: ForkSummary } {
	return {
		threadTokens: parseSessionTokenFile(options.parentSessionFile),
		agentSpend: scanAgentSpend({ parentSessionFile: options.parentSessionFile }),
		forkSummary: summarize({ ...options, includeCompleted: true, relatedOnly: true }),
	};
}

function updateSpendStatus(ctx: ExtensionContext, options: ViewOptions, now = Date.now()): void {
	const scopeKey = spendScopeKey(options);
	if (scopeKey !== lastSpendScopeKey || now - lastSpendStatusAt >= TOKEN_REFRESH_MS) {
		const spend = currentSpend(options);
		lastSpendStatus = buildSpendStatus(spend.threadTokens, spend.agentSpend, spend.forkSummary);
		lastSpendStatusAt = now;
		lastSpendScopeKey = scopeKey;
	}
	ctx.ui.setStatus(SPEND_STATUS_KEY, lastSpendStatus);
}

function formatSpendLine(label: string, tokens: TokenUsage | undefined, extra?: string): string {
	const spend = formatSpend(tokens) ?? "0 tok";
	return `${label}: ${spend}${extra ? ` · ${extra}` : ""}`;
}

function formatSpendReport(options: ViewOptions): string {
	const spend = currentSpend(options);
	const lines = ["Pi spend for this dialog"];
	lines.push(formatSpendLine("dialog", spend.threadTokens));
	lines.push(formatSpendLine("agents", spend.agentSpend.totalTokens, `${spend.agentSpend.runs.length} runs · ${spend.agentSpend.steps} steps${spend.agentSpend.active.length ? ` · ${spend.agentSpend.active.length} active` : ""}`));
	lines.push(formatSpendLine("forks", spend.forkSummary.totalTokens, `${spend.forkSummary.runs.length} related runs${spend.forkSummary.running.length || spend.forkSummary.stale.length ? ` · ${spend.forkSummary.running.length} running · ${spend.forkSummary.stale.length} stale` : ""}`));
	return lines.join("\n");
}

function render(ctx = latestCtx): void {
	if (!ctx?.hasUI) return;
	const options = defaultOptions(ctx);
	if (!options) {
		ctx.ui.setStatus(EXTENSION_KEY, undefined);
		ctx.ui.setStatus(SPEND_STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	const summary = summarize(options);
	ctx.ui.setStatus(EXTENSION_KEY, buildStatus(summary, options, ctx.ui.theme));
	updateSpendStatus(ctx, options);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	ctx.ui.requestRender?.();
}

function startRefresh(): void {
	if (refreshTimer) return;
	refreshTimer = setInterval(() => render(), REFRESH_MS);
	refreshTimer.unref?.();
}

function stopRefresh(ctx = latestCtx): void {
	if (refreshTimer) clearInterval(refreshTimer);
	refreshTimer = undefined;
	lastSpendStatus = undefined;
	lastSpendStatusAt = 0;
	lastSpendScopeKey = undefined;
	try {
		ctx?.ui.setStatus(EXTENSION_KEY, undefined);
		ctx?.ui.setStatus(SPEND_STATUS_KEY, undefined);
		ctx?.ui.setWidget(WIDGET_KEY, undefined);
	} catch {
		// UI context may already be stale during shutdown/reload.
	}
}

async function notifyScoped(ctx: ExtensionContext, source: ForkSource, includeCompleted = false): Promise<void> {
	await showForksModal(ctx, { source, includeCompleted });
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		render(ctx);
		startRefresh();
	});

	pi.on("session_shutdown", async () => {
		stopRefresh();
		latestCtx = undefined;
	});

	pi.registerCommand("forks", {
		description: `Open compact fork handlers (${FORKS_SHORTCUT_LABEL}). Toggle related/completed/sort in the modal; use --all-sources for global view.`,
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const parsed = parseArgs(args);
			const fallback = defaultOptions(ctx);
			const source = parsed.source ?? fallback?.source;
			const scope = parsed.scope ?? (parsed.source ? undefined : parsed.allSources ? "all" : fallback?.scope ?? "chat");
			const allSources = parsed.allSources || scope === "all" || (!source && !!fallback?.allSources);
			const options = { source, scope, includeCompleted: parsed.includeCompleted, allSources, relatedOnly: parsed.relatedOnly ?? fallback?.relatedOnly ?? true, sortMode: parsed.sortMode, sortDesc: parsed.sortDesc, ...sessionScope(ctx) } satisfies ViewOptions;
			if (parsed.diagnose) {
				ctx.ui.notify(formatDiagnostics(diagnoseForkRuns({ includeCompleted: true, ...(allSources || !source ? {} : { source }) }), { ...options, includeCompleted: true, allSources: allSources || !source }, ctx.ui.theme), "info");
				return;
			}
			await showForksModal(ctx, options);
		},
	});

	pi.registerShortcut?.(FORKS_SHORTCUT as never, {
		description: "Open related fork handlers view",
		handler: async (ctx) => {
			const options = defaultOptions(ctx);
			if (!options) {
				ctx.ui.notify("No related fork source detected here. Use /forks intercom, /forks return_on, /forks subagents, or /forks --all-sources.", "info");
				return;
			}
			await showForksModal(ctx, options);
		},
	});
	pi.registerShortcut?.(FORKS_SHORTCUT_ALIAS as never, {
		description: "Open related fork handlers view (alternate binding)",
		handler: async (ctx) => {
			const options = defaultOptions(ctx);
			if (!options) {
				ctx.ui.notify("No related fork source detected here. Use /forks intercom, /forks return_on, /forks subagents, or /forks --all-sources.", "info");
				return;
			}
			await showForksModal(ctx, options);
		},
	});

	pi.registerCommand("forks-health", {
		description: "Report stale fork records, duplicate active cwd groups, failures, and token totals.",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			const source = parsed.source;
			const allSources = parsed.allSources || !source;
			ctx.ui.notify(formatDiagnostics(diagnoseForkRuns({ includeCompleted: true, ...(allSources ? {} : { source }) }), { source, includeCompleted: true, allSources }, ctx.ui.theme), "info");
		},
	});

	pi.registerCommand("pi-spend", {
		description: "Show this dialog's token/cost split across dialog, agents, and fork handlers.",
		handler: async (_args, ctx) => {
			const options = defaultOptions(ctx) ?? { scope: "chat", relatedOnly: true, ...sessionScope(ctx) };
			ctx.ui.notify(formatSpendReport(options), "info");
		},
	});

	pi.registerCommand("forks-spend", {
		description: "Alias for /pi-spend.",
		handler: async (_args, ctx) => {
			const options = defaultOptions(ctx) ?? { scope: "chat", relatedOnly: true, ...sessionScope(ctx) };
			ctx.ui.notify(formatSpendReport(options), "info");
		},
	});

	pi.registerCommand("intercom-forks", {
		description: "Show pi-intercom fork handlers",
		handler: async (args, ctx) => notifyScoped(ctx, "intercom", /(?:^|\s)(?:--all|-a)(?:\s|$)/.test(args)),
	});
	pi.registerCommand("return-on-forks", {
		description: "Show pi-return-on fork handlers",
		handler: async (args, ctx) => notifyScoped(ctx, "return_on", /(?:^|\s)(?:--all|-a)(?:\s|$)/.test(args)),
	});
	pi.registerCommand("subagent-forks", {
		description: "Show pi-subagents fork handlers",
		handler: async (args, ctx) => notifyScoped(ctx, "subagents", /(?:^|\s)(?:--all|-a)(?:\s|$)/.test(args)),
	});
}
