import type { ForkRun, ForkSource, ForkSummary } from "./monitor.ts";
import {
	compactRunStats,
	forkIcon,
	statusColor,
	statusGlyph,
	stripAnsi,
	truncate,
	visibleLength,
	type ThemeLike,
} from "./formatting.ts";

export type ViewScope = "chat" | "response_handlers" | "subagents" | "user" | "all";
export type SortMode = "status" | "newest" | "oldest" | "duration" | "source" | "label";

export const SCOPE_ORDER: ViewScope[] = ["chat", "response_handlers", "subagents", "user", "all"];
export const SORT_ORDER: SortMode[] = ["status", "newest", "oldest", "duration", "source", "label"];

export interface ViewOptions {
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

export type ForkControlAction = "stop" | "pause" | "resume";

export interface StopForkResult {
	ok: boolean;
	message: string;
}

export interface ModalDeps {
	summarize: (options: ViewOptions) => ForkSummary;
	scopeLabel: (options: ViewOptions) => string;
	sourceLabel: (source: ForkRun["source"]) => string;
	sourceColor: (source: ForkRun["source"]) => string;
	controlRun?: (run: ForkRun, action: ForkControlAction) => Promise<StopForkResult> | StopForkResult;
	stopRun?: (run: ForkRun) => Promise<StopForkResult> | StopForkResult;
	describeRun?: (run: ForkRun) => string[];
	requestRender?: () => void;
	shortcut: string;
	shortcutAlias: string;
	bodyLines: number;
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

export class ForksModal {
	private selectedIndex = 0;
	private scroll = 0;
	private includeCompleted: boolean;
	private relatedOnly: boolean;
	private scope: ViewScope | undefined;
	private sortMode: SortMode;
	private sortDesc: boolean;
	private inspecting = false;
	private cachedLines: string[] | undefined;
	private statusMessage: StopForkResult | undefined;
	private controlling: ForkControlAction | undefined;
	private options: ViewOptions;
	private theme: ThemeLike;
	private done: () => void;
	private deps: ModalDeps;

	constructor(options: ViewOptions, theme: ThemeLike, done: () => void, deps: ModalDeps) {
		this.options = options;
		this.theme = theme;
		this.done = done;
		this.deps = deps;
		this.includeCompleted = !!options.includeCompleted;
		this.relatedOnly = options.relatedOnly ?? true;
		this.scope = options.scope ?? (options.allSources ? "all" : undefined);
		this.sortMode = options.sortMode ?? "status";
		this.sortDesc = !!options.sortDesc;
	}

	handleInput(data: string): void {
		// Close keys must be handled before rescanning fork state. If a scan is slow
		// or a state file is temporarily wedged, Esc/q should still dismiss the modal.
		if (data === "" || data === this.deps.shortcut || data === this.deps.shortcutAlias || matchesInput(data, "escape") || data === "q" || data === "Q") {
			this.done();
			return;
		}
		const summary = this.summary();
		this.clampSelection(summary.runs.length);
		const maxScroll = Math.max(0, this.getCachedBodyLength() - this.deps.bodyLines);
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
			this.statusMessage = undefined;
			this.invalidate();
		} else if (data === "i" || data === "I" || matchesInput(data, "enter")) {
			this.inspecting = !this.inspecting;
			this.invalidate();
		} else if (data === "X") {
			void this.controlSelected(summary, "stop");
		} else if (data === "P") {
			void this.controlSelected(summary, "pause");
		} else if (data === "U") {
			void this.controlSelected(summary, "resume");
		} else if (data === "j" || matchesInput(data, "down")) {
			this.selectedIndex = Math.min(summary.runs.length - 1, this.selectedIndex + 1);
			this.ensureSelectedVisible();
		} else if (data === "k" || matchesInput(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.ensureSelectedVisible();
		} else if (matchesInput(data, "pageDown")) {
			this.selectedIndex = Math.min(summary.runs.length - 1, this.selectedIndex + this.deps.bodyLines - 6);
			this.ensureSelectedVisible();
		} else if (matchesInput(data, "pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - (this.deps.bodyLines - 6));
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
		const maxScroll = Math.max(0, body.length - this.deps.bodyLines);
		this.scroll = Math.min(this.scroll, maxScroll);
		const visibleBody = body.slice(this.scroll, this.scroll + this.deps.bodyLines);
		const scope = this.deps.scopeLabel({ ...this.options, scope: this.scope, allSources: this.scope === "all" });
		const globalRunning = this.deps.summarize({ scope: "all" }).running.length;
		const titleCount = globalRunning > summary.running.length ? `${summary.running.length} running/${globalRunning} total` : `${summary.running.length} running`;
		const title = `${this.theme.fg("success", forkIcon(Math.max(summary.running.length, globalRunning)))} ${this.theme.fg("accent", "fork handlers")} ${this.theme.fg("dim", `${titleCount} · ${summary.runs.length} shown · ${scope}`)}`;
		const range = body.length > this.deps.bodyLines ? ` · lines ${this.scroll + 1}-${Math.min(body.length, this.scroll + this.deps.bodyLines)}/${body.length}` : "";
		const help = this.theme.fg("dim", `↑/↓ select · Enter/i inspect · P pause · U resume · X stop · a scope · c completed · Esc/q close${range}`);
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
		return this.deps.summarize({ ...this.options, scope: this.scope, includeCompleted: this.includeCompleted, relatedOnly: this.relatedOnly, sortMode: this.sortMode, sortDesc: this.sortDesc, allSources: this.scope === "all" });
	}

	private resetView(): void {
		this.scroll = 0;
		this.selectedIndex = 0;
		this.invalidate();
	}

	private invalidate(): void {
		this.cachedLines = undefined;
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
		else if (row >= this.scroll + this.deps.bodyLines) this.scroll = row - this.deps.bodyLines + 1;
		this.scroll = Math.max(0, this.scroll);
	}

	private async controlSelected(summary: ForkSummary, action: ForkControlAction): Promise<void> {
		if (this.controlling) return;
		const run = summary.runs[this.selectedIndex];
		if (!run) {
			this.statusMessage = { ok: false, message: "No fork handler selected." };
			this.invalidate();
			this.deps.requestRender?.();
			return;
		}
		const controlRun = this.deps.controlRun ?? (action === "stop" ? (selected: ForkRun) => this.deps.stopRun?.(selected) : undefined);
		if (!controlRun) {
			this.statusMessage = { ok: false, message: `${action[0]?.toUpperCase()}${action.slice(1)} is not available in this build.` };
			this.invalidate();
			this.deps.requestRender?.();
			return;
		}
		this.controlling = action;
		this.statusMessage = undefined;
		this.invalidate();
		this.deps.requestRender?.();
		try {
			this.statusMessage = await controlRun(run, action);
		} catch (error) {
			this.statusMessage = { ok: false, message: `Failed to ${action} ${run.label}: ${error instanceof Error ? error.message : String(error)}` };
		} finally {
			this.controlling = undefined;
			this.invalidate();
			this.deps.requestRender?.();
		}
	}

	private getCachedBodyLength(): number {
		return this.cachedLines?.length ?? 0;
	}

	private getBodyLines(innerWidth: number, summary: ForkSummary): string[] {
		this.clampSelection(summary.runs.length);
		const lines: string[] = [];
		const push = (line = "") => lines.push(line);
		const scope = this.deps.scopeLabel({ ...this.options, scope: this.scope, allSources: this.scope === "all" });
		push(`${this.theme.fg("dim", "Scope:")} ${this.theme.fg("accent", scope)} ${this.theme.fg("muted", "· related:")} ${this.theme.fg("accent", this.relatedOnly ? "only" : "off")} ${this.theme.fg("muted", "· completed:")} ${this.theme.fg("accent", this.includeCompleted ? "shown" : "hidden")} ${this.theme.fg("muted", "· sort:")} ${this.theme.fg("accent", `${this.sortMode}${this.sortDesc ? " reversed" : ""}`)}`);
		if (this.statusMessage) {
			push(this.theme.fg(this.statusMessage.ok ? "success" : "warning", this.statusMessage.message));
		}
		if (this.controlling) push(this.theme.fg("warning", `${this.controlling[0]?.toUpperCase()}${this.controlling.slice(1)} selected fork handler…`));
		if (summary.runs.length === 0) {
			push(this.theme.fg("warning", `No fork handlers for ${scope}.`));
		} else {
			for (const [index, run] of summary.runs.entries()) {
				push(this.formatRunRow(run, index, innerWidth));
				if (this.inspecting && index === this.selectedIndex) {
					for (const detail of this.formatRunDetails(run, innerWidth)) push(detail);
				}
			}
		}
		this.cachedLines = lines;
		return lines;
	}

	private formatRunDetails(run: ForkRun, innerWidth: number): string[] {
		const details = this.deps.describeRun?.(run) ?? [`No inspector available for ${run.id}.`];
		const width = Math.max(12, innerWidth - 6);
		return details.map((line) => `${this.theme.fg("muted", "│")} ${this.theme.fg("dim", truncate(line, width))}`);
	}

	private formatRunRow(run: ForkRun, index: number, innerWidth: number): string {
		const selected = index === this.selectedIndex;
		const marker = selected ? this.theme.fg("accent", "›") : " ";
		const number = selected ? this.theme.fg("accent", `${index + 1}.`) : this.theme.fg("dim", `${index + 1}.`);
		const glyph = this.theme.fg(statusColor(run.status), statusGlyph(run.status));
		const source = this.theme.fg(this.deps.sourceColor(run.source), this.deps.sourceLabel(run.source));
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
