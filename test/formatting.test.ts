import test from "node:test";
import assert from "node:assert/strict";
import { compactRunStats, formatCost, formatDuration, formatSpend, formatTokens, forkIcon, runStats, statusColor, statusGlyph, truncate, stripAnsi, visibleLength } from "../src/formatting.ts";
import type { ForkRun } from "../src/monitor.ts";

test("formatDuration handles ranges and edge cases", () => {
	assert.equal(formatDuration(undefined), "0s");
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(500), "0s");
	assert.equal(formatDuration(1_000), "1s");
	assert.equal(formatDuration(59_000), "59s");
	assert.equal(formatDuration(60_000), "1m");
	assert.equal(formatDuration(125_000), "2m");
	assert.equal(formatDuration(3_600_000), "1h");
	assert.equal(formatDuration(3_900_000), "1h5m");
	assert.equal(formatDuration(7_200_000), "2h");
});

test("formatTokens formats with k/m suffixes", () => {
	assert.equal(formatTokens(undefined), "0");
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(-5), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1_500), "1.5k");
	assert.equal(formatTokens(9_900), "9.9k");
	assert.equal(formatTokens(10_500), "11k");
	assert.equal(formatTokens(123_000), "123k");
	assert.equal(formatTokens(1_500_000), "1.5m");
});

test("formatCost picks precision by magnitude", () => {
	assert.equal(formatCost(undefined), undefined);
	assert.equal(formatCost(0), undefined);
	assert.equal(formatCost(-1), undefined);
	assert.equal(formatCost(0.001), "$0.0010");
	assert.equal(formatCost(0.05), "$0.050");
	assert.equal(formatCost(1.234), "$1.23");
	assert.equal(formatCost(12.5), "$12.50");
});

test("formatSpend returns tokens+cost or tokens alone or undefined", () => {
	assert.equal(formatSpend(undefined), undefined);
	assert.equal(formatSpend({ input: 0, output: 0, total: 0 }), undefined);
	assert.equal(formatSpend({ input: 50, output: 50, total: 100 }), "100 tok");
	assert.equal(formatSpend({ input: 50, output: 50, total: 100, cost: 0.5 }), "100/$0.500");
	assert.equal(formatSpend({ input: 0, output: 0, total: 0 }, 0.5), undefined);
	assert.equal(formatSpend({ input: 50, output: 50, total: 100 }, 0.25), "100/$0.250");
});

test("truncate respects max length with ellipsis", () => {
	assert.equal(truncate("hello", 10), "hello");
	assert.equal(truncate("hello world", 5), "hell…");
	assert.equal(truncate("ab", 0), "…");
});

test("stripAnsi removes color codes; visibleLength counts only visible chars", () => {
	const colored = "\x1b[38;5;208morange\x1b[39m";
	assert.equal(stripAnsi(colored), "orange");
	assert.equal(visibleLength(colored), 6);
});

test("statusColor/statusGlyph map status to theme primitives", () => {
	assert.equal(statusColor("running"), "accent");
	assert.equal(statusColor("complete"), "success");
	assert.equal(statusColor("failed"), "error");
	assert.equal(statusColor("stale"), "warning");
	assert.equal(statusColor("unknown"), "muted");
	assert.equal(statusGlyph("running"), "●");
	assert.equal(statusGlyph("complete"), "✓");
	assert.equal(statusGlyph("failed"), "✗");
	assert.equal(statusGlyph("stale"), "!");
	assert.equal(statusGlyph("unknown"), "?");
});

test("forkIcon scales prong count and adds + suffix above 4", () => {
	assert.equal(forkIcon(0), "┌┬┐");
	assert.equal(forkIcon(1), "┌┬┐");
	assert.equal(forkIcon(2), "┌┬┬┐");
	assert.equal(forkIcon(4), "┌┬┬┬┬┐");
	assert.equal(forkIcon(5), "┌┬┬┬┬┐+");
	assert.equal(forkIcon(10), "┌┬┬┬┬┐+");
});

test("runStats and compactRunStats compose fields", () => {
	const base: ForkRun = { source: "intercom", id: "x", label: "L", status: "running", durationMs: 5_000, tokens: { input: 1, output: 1, total: 200 }, pid: 42 };
	assert.equal(runStats(base), "running · 5s · 200 tok · pid 42");
	assert.equal(compactRunStats(base), "running · 5s · 200 tok");
	const stale: ForkRun = { source: "intercom", id: "x", label: "L", status: "stale", pidAlive: false };
	assert.equal(compactRunStats(stale), "stale · pid dead");
});
