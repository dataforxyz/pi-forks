import type { ForkRun, TokenUsage } from "./monitor.ts";

export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export function formatDuration(ms: number | undefined): string {
	if (!ms || ms < 1000) return "0s";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h${rest}m` : `${hours}h`;
}

export function formatTokens(tokens: number | undefined): string {
	if (!tokens || tokens <= 0) return "0";
	if (tokens < 1000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}m`;
}

export function formatCost(cost: number | undefined): string | undefined {
	if (!cost || cost <= 0) return undefined;
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

export function formatSpend(tokens: TokenUsage | undefined, fallbackCost?: number): string | undefined {
	if (!tokens || tokens.total <= 0) return undefined;
	const cost = formatCost(tokens.cost ?? fallbackCost);
	return cost ? `${formatTokens(tokens.total)}/${cost}` : `${formatTokens(tokens.total)} tok`;
}

function ansi256(color: number, text: string): string {
	return `\x1b[38;5;${color}m${text}\x1b[39m`;
}

export function orange(text: string): string {
	return ansi256(208, text);
}

export function cyan(text: string): string {
	return ansi256(45, text);
}

export function violet(text: string): string {
	return ansi256(141, text);
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function visibleLength(text: string): number {
	return stripAnsi(text).length;
}

export function statusColor(status: ForkRun["status"]): string {
	if (status === "running" || status === "starting") return "accent";
	if (status === "complete") return "success";
	if (status === "failed") return "error";
	if (status === "stale") return "warning";
	return "muted";
}

export function statusGlyph(status: ForkRun["status"]): string {
	if (status === "running" || status === "starting") return "●";
	if (status === "complete") return "✓";
	if (status === "failed") return "✗";
	if (status === "stale") return "!";
	return "?";
}

export function forkIcon(count: number): string {
	const prongs = Math.max(3, Math.min(6, count + 2));
	return `┌${"┬".repeat(Math.max(1, prongs - 2))}┐${count > 4 ? "+" : ""}`;
}

export function runStats(run: ForkRun, theme?: ThemeLike): string {
	const status = theme ? theme.fg(statusColor(run.status), run.status) : run.status;
	const parts: string[] = [status];
	if (run.durationMs !== undefined) parts.push(formatDuration(run.durationMs));
	if (run.tokens?.total) parts.push(`${formatTokens(run.tokens.total)} tok`);
	if (run.pid) parts.push(`pid ${run.pid}${run.pidAlive === false ? " dead" : ""}`);
	return parts.join(" · ");
}

export function compactRunStats(run: ForkRun): string {
	const parts: string[] = [run.status];
	if (run.durationMs !== undefined) parts.push(formatDuration(run.durationMs));
	if (run.tokens?.total) parts.push(`${formatTokens(run.tokens.total)} tok`);
	if (run.status === "stale" && run.pidAlive === false) parts.push("pid dead");
	return parts.join(" · ");
}
