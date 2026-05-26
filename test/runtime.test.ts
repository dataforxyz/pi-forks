import test from "node:test";
import assert from "node:assert/strict";
import { forkHandlerKind, forkSourceForKind, shortForkRunId, sanitizeSegment, sourceColor, sourceLabel } from "../src/runtime.ts";

test("sourceLabel returns display label per source", () => {
	assert.equal(sourceLabel("intercom"), "intercom");
	assert.equal(sourceLabel("return_on"), "return_on");
	assert.equal(sourceLabel("subagents"), "subagents");
});

test("sourceColor returns theme color per source", () => {
	assert.equal(sourceColor("intercom"), "accent");
	assert.equal(sourceColor("return_on"), "warning");
	assert.equal(sourceColor("subagents"), "success");
});

test("forkHandlerKind maps each source to its handler kind", () => {
	assert.equal(forkHandlerKind("intercom"), "intercom");
	assert.equal(forkHandlerKind("return_on"), "return-on");
	assert.equal(forkHandlerKind("subagents"), "subagent");
});

test("forkSourceForKind is inverse of forkHandlerKind", () => {
	assert.equal(forkSourceForKind("intercom"), "intercom");
	assert.equal(forkSourceForKind("return-on"), "return_on");
	assert.equal(forkSourceForKind("subagent"), "subagents");
});

test("sanitizeSegment scrubs and clamps input", () => {
	assert.equal(sanitizeSegment("hello"), "hello");
	assert.equal(sanitizeSegment("hello world!"), "hello-world");
	assert.equal(sanitizeSegment("", "fallback"), "fallback");
	assert.equal(sanitizeSegment("---", "fallback"), "fallback");
	assert.equal(sanitizeSegment("a".repeat(50), "fallback", 5), "aaaaa");
});

test("shortForkRunId strips prefix and joins parts", () => {
	assert.equal(shortForkRunId(undefined), "handler");
	assert.equal(shortForkRunId(""), "handler");
	assert.equal(shortForkRunId("icfh-abc-def-ghi"), "abc-def");
	assert.equal(shortForkRunId("roh_xyz_123"), "xyz-123");
	assert.equal(shortForkRunId("sbf-only"), "only");
});
