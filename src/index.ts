import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { scanForkRuns, type ForkRun, type ForkSource, type ForkSummary } from "./monitor.ts";

const EXTENSION_KEY = "pi-forks";
const WIDGET_KEY = "pi-forks";
const REFRESH_MS = 2_000;
const WIDGET_LIMIT = 8;
const SOURCES: ForkSource[] = ["intercom", "return_on", "subagents"];

interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface ViewOptions {
	source?: ForkSource;
	includeCompleted?: boolean;
	allSources?: boolean;
}

let latestCtx: ExtensionContext | undefined;
let refreshTimer: NodeJS.Timeout | undefined;

function configuredSource(): ForkSource | undefined {
	const raw = process.env.PI_FORKS_SOURCE;
	return SOURCES.includes(raw as ForkSource) ? raw as ForkSource : undefined;
}

function parseArgs(args: string): ViewOptions {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const allSources = words.some((word) => word === "--all-sources" || word === "--global");
	const includeCompleted = words.some((word) => word === "--all" || word === "-a");
	const source = words.find((word): word is ForkSource => SOURCES.includes(word as ForkSource));
	return { source, includeCompleted, allSources };
}

function formatDuration(ms: number | undefined): string {
	if (!ms || ms < 1000) return "0s";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h${rest}m` : `${hours}h`;
}

function formatTokens(tokens: number | undefined): string {
	if (!tokens || tokens <= 0) return "0";
	if (tokens < 1000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function sourceLabel(source: ForkRun["source"]): string {
	if (source === "return_on") return "return_on";
	if (source === "intercom") return "intercom";
	return "subagents";
}

function sourceTitle(source: ForkSource | undefined, allSources: boolean): string {
	if (allSources) return "All fork handlers";
	if (!source) return "Fork handlers";
	return `${sourceLabel(source)} forks`;
}

function sourceColor(source: ForkRun["source"]): string {
	if (source === "return_on") return "warning";
	if (source === "intercom") return "accent";
	return "success";
}

function statusColor(status: ForkRun["status"]): string {
	if (status === "running" || status === "starting") return "accent";
	if (status === "complete") return "success";
	if (status === "failed") return "error";
	if (status === "stale") return "warning";
	return "muted";
}

function statusGlyph(status: ForkRun["status"]): string {
	if (status === "running" || status === "starting") return "●";
	if (status === "complete") return "✓";
	if (status === "failed") return "✗";
	if (status === "stale") return "!";
	return "?";
}

function runStats(run: ForkRun, theme?: ThemeLike): string {
	const status = theme ? theme.fg(statusColor(run.status), run.status) : run.status;
	const parts: string[] = [status];
	if (run.durationMs !== undefined) parts.push(formatDuration(run.durationMs));
	if (run.tokens?.total) parts.push(`${formatTokens(run.tokens.total)} tok`);
	if (run.pid) parts.push(`pid ${run.pid}${run.pidAlive === false ? " dead" : ""}`);
	return parts.join(" · ");
}

function buildStatus(summary: ForkSummary, options: ViewOptions, theme?: ThemeLike): string | undefined {
	if (summary.running.length === 0) return undefined;
	const label = options.allSources ? "forks" : options.source ? sourceLabel(options.source) : "forks";
	const parts = [`${summary.running.length} ${label}`];
	if (summary.totalTokens.total > 0) parts.push(`${formatTokens(summary.totalTokens.total)} tok`);
	if (summary.maxRunningDurationMs > 0) parts.push(formatDuration(summary.maxRunningDurationMs));
	const text = `⑂ ${parts.join(" · ")}`;
	return theme ? theme.fg(options.source ? sourceColor(options.source) : "accent", text) : text;
}

function buildWidget(summary: ForkSummary, options: ViewOptions, theme?: ThemeLike): string[] | undefined {
	if (summary.runs.length === 0) return undefined;
	const active = summary.running.length > 0;
	const title = sourceTitle(options.source, !!options.allSources);
	const lines: string[] = [];
	lines.push(theme ? theme.fg(active ? "accent" : "muted", `╭─ ${title}`) : `╭─ ${title}`);
	const meta = `${summary.running.length} running · ${summary.runs.length} tracked · ${formatTokens(summary.totalTokens.total)} tok`;
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
		run.intercomTarget ? `intercom=${run.intercomTarget}` : undefined,
		run.parentIntercomTarget ? `parent=${run.parentIntercomTarget}` : undefined,
		run.dir,
	].filter(Boolean);
	return details.join(theme ? theme.fg("dim", " | ") : " | ");
}

function formatCommandOutput(summary: ForkSummary, options: ViewOptions, theme?: ThemeLike): string {
	if (summary.runs.length === 0) return `No ${sourceTitle(options.source, !!options.allSources).toLowerCase()} found.`;
	const title = theme ? theme.fg(options.source ? sourceColor(options.source) : "accent", theme.bold(sourceTitle(options.source, !!options.allSources))) : sourceTitle(options.source, !!options.allSources);
	const header = `${title}: ${summary.running.length} running, ${summary.runs.length} tracked, ${formatTokens(summary.totalTokens.total)} tokens`;
	return [header, "", ...summary.runs.map((run) => formatRunLine(run, theme))].join("\n");
}

function summarize(options: ViewOptions): ForkSummary {
	return scanForkRuns({
		includeCompleted: options.includeCompleted,
		...(options.allSources || !options.source ? {} : { source: options.source }),
	});
}

function render(ctx = latestCtx): void {
	if (!ctx?.hasUI) return;
	const source = configuredSource();
	if (!source) {
		ctx.ui.setStatus(EXTENSION_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	const options: ViewOptions = { source, includeCompleted: false };
	const summary = summarize(options);
	ctx.ui.setStatus(EXTENSION_KEY, buildStatus(summary, options, ctx.ui.theme));
	ctx.ui.setWidget(WIDGET_KEY, buildWidget(summary, options, ctx.ui.theme));
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
	try {
		ctx?.ui.setStatus(EXTENSION_KEY, undefined);
		ctx?.ui.setWidget(WIDGET_KEY, undefined);
	} catch {
		// UI context may already be stale during shutdown/reload.
	}
}

function notifyScoped(ctx: ExtensionContext, source: ForkSource, includeCompleted = false): void {
	const options: ViewOptions = { source, includeCompleted };
	ctx.ui.notify(formatCommandOutput(summarize(options), options, ctx.ui.theme), "info");
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
		description: "Show scoped background fork handlers. Use a source or --all-sources for global view.",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const parsed = parseArgs(args);
			const source = parsed.source ?? configuredSource();
			if (!source && !parsed.allSources) {
				ctx.ui.notify("Pick a fork source: /forks intercom, /forks return_on, /forks subagents. Use /forks --all-sources for the global view.", "info");
				return;
			}
			const options: ViewOptions = { source, includeCompleted: parsed.includeCompleted, allSources: parsed.allSources };
			const summary = summarize(options);
			ctx.ui.notify(formatCommandOutput(summary, options, ctx.ui.theme), "info");
			render(ctx);
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
