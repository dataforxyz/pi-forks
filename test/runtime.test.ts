import test from "node:test";
import assert from "node:assert/strict";
import { forkHandlerKind, forkSourceForKind, getForkStateDir, getForkStateRoot, shortForkRunId, sanitizeSegment, sourceColor, sourceLabel } from "../src/runtime.ts";

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

test("state root defaults to home-local state", () => {
	const previousRoot = process.env.PI_FORKS_STATE_ROOT;
	const previousBackground = process.env.PI_BACKGROUND_STATE_DIR;
	try {
		delete process.env.PI_FORKS_STATE_ROOT;
		delete process.env.PI_BACKGROUND_STATE_DIR;
		assert.equal(getForkStateRoot("/tmp/home"), "/tmp/home/.local/state");
		assert.equal(getForkStateDir("return_on", "/tmp/home"), "/tmp/home/.local/state/pi-return-on");
	} finally {
		if (previousRoot === undefined) delete process.env.PI_FORKS_STATE_ROOT;
		else process.env.PI_FORKS_STATE_ROOT = previousRoot;
		if (previousBackground === undefined) delete process.env.PI_BACKGROUND_STATE_DIR;
		else process.env.PI_BACKGROUND_STATE_DIR = previousBackground;
	}
});

test("state root can be isolated with PI_BACKGROUND_STATE_DIR", () => {
	const previousRoot = process.env.PI_FORKS_STATE_ROOT;
	const previousBackground = process.env.PI_BACKGROUND_STATE_DIR;
	const previousReturnOn = process.env.PI_RETURN_ON_STATE_DIR;
	try {
		delete process.env.PI_FORKS_STATE_ROOT;
		delete process.env.PI_RETURN_ON_STATE_DIR;
		process.env.PI_BACKGROUND_STATE_DIR = "~/pi-lab-state";
		assert.equal(getForkStateRoot("/tmp/home"), "/tmp/home/pi-lab-state");
		assert.equal(getForkStateDir("return_on", "/tmp/home"), "/tmp/home/pi-lab-state/pi-return-on");
	} finally {
		if (previousRoot === undefined) delete process.env.PI_FORKS_STATE_ROOT;
		else process.env.PI_FORKS_STATE_ROOT = previousRoot;
		if (previousBackground === undefined) delete process.env.PI_BACKGROUND_STATE_DIR;
		else process.env.PI_BACKGROUND_STATE_DIR = previousBackground;
		if (previousReturnOn === undefined) delete process.env.PI_RETURN_ON_STATE_DIR;
		else process.env.PI_RETURN_ON_STATE_DIR = previousReturnOn;
	}
});

test("source-specific state dir overrides the shared root", () => {
	const previousRoot = process.env.PI_FORKS_STATE_ROOT;
	const previousReturnOn = process.env.PI_RETURN_ON_STATE_DIR;
	try {
		process.env.PI_FORKS_STATE_ROOT = "/tmp/root";
		process.env.PI_RETURN_ON_STATE_DIR = "~/ro-state";
		assert.equal(getForkStateDir("return_on", "/tmp/home"), "/tmp/home/ro-state");
		assert.equal(getForkStateDir("intercom", "/tmp/home"), "/tmp/root/pi-intercom");
	} finally {
		if (previousRoot === undefined) delete process.env.PI_FORKS_STATE_ROOT;
		else process.env.PI_FORKS_STATE_ROOT = previousRoot;
		if (previousReturnOn === undefined) delete process.env.PI_RETURN_ON_STATE_DIR;
		else process.env.PI_RETURN_ON_STATE_DIR = previousReturnOn;
	}
});
