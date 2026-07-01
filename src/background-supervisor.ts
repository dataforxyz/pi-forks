import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { BackgroundEventsStore, getBackgroundEventsDbPath } from "./background-events.ts";

export interface SupervisedHandlerOptions {
	dbPath?: string;
	handlerId: string;
	command: string;
	args: string[];
	cwd: string;
	stdoutPath: string;
	stderrPath: string;
	env?: NodeJS.ProcessEnv;
	heartbeatMs?: number;
	leaseMs?: number;
	summaryPath?: string;
	requeueOnLaunchFailure?: boolean;
}

export interface SupervisedHandlerResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	resultId?: string;
}

function closeFdBestEffort(fd: number | undefined): void {
	if (fd === undefined) return;
	try {
		fs.closeSync(fd);
	} catch {
		// Best effort cleanup; child owns duplicated stdio fds after spawn succeeds.
	}
}

export function terminateProcessGroupBestEffort(child: ChildProcess): void {
	const pid = child.pid;
	if (!pid) return;
	try {
		process.kill(-pid, "SIGTERM");
		return;
	} catch {
		// Fall through to child-only termination for platforms that do not support
		// negative process-group pids or when the child was not group leader.
	}
	try {
		child.kill("SIGTERM");
	} catch {
		// Best effort.
	}
}

export async function runSupervisedHandler(options: SupervisedHandlerOptions): Promise<SupervisedHandlerResult> {
	const dbPath = options.dbPath ?? getBackgroundEventsDbPath();
	const store = new BackgroundEventsStore(dbPath);
	let stdoutFd: number | undefined;
	let stderrFd: number | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let child: ChildProcess | undefined;
	let launched = false;
	try {
		await fs.promises.mkdir(path.dirname(options.stdoutPath), { recursive: true });
		await fs.promises.mkdir(path.dirname(options.stderrPath), { recursive: true });
		stdoutFd = fs.openSync(options.stdoutPath, "a");
		stderrFd = fs.openSync(options.stderrPath, "a");
		child = spawn(options.command, options.args, {
			cwd: options.cwd,
			detached: true,
			env: options.env ?? process.env,
			stdio: ["ignore", stdoutFd, stderrFd],
		});
		closeFdBestEffort(stdoutFd);
		closeFdBestEffort(stderrFd);
		stdoutFd = undefined;
		stderrFd = undefined;

		let launchError: unknown;
		const spawned = await new Promise<boolean>((resolve) => {
			const onSpawn = () => {
				child?.off("error", onError);
				resolve(true);
			};
			const onError = (error: Error) => {
				launchError = error;
				child?.off("spawn", onSpawn);
				resolve(false);
			};
			child?.once("spawn", onSpawn);
			child?.once("error", onError);
		});
		if (!spawned || !child) throw launchError instanceof Error ? launchError : new Error(String(launchError ?? "failed to spawn handler"));
		launched = true;

		const now = Date.now();
		store.markHandlerRunning(options.handlerId, {
			pid: child.pid,
			supervisorPid: process.pid,
			processGroupId: child.pid,
			leaseMs: options.leaseMs,
			now,
		});
		heartbeat = setInterval(() => {
			try {
				store.heartbeatHandler(options.handlerId, { leaseMs: options.leaseMs });
			} catch {
				// The child should continue even if a transient heartbeat write fails;
				// stale reconciliation will handle missed leases.
			}
		}, options.heartbeatMs ?? 5_000);
		heartbeat.unref?.();

		const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			child?.once("close", (code, signal) => resolve({ code, signal }));
		});
		if (heartbeat) clearInterval(heartbeat);
		const resultId = store.completeHandler(options.handlerId, {
			status: code === 0 ? "complete" : "failed",
			summaryPath: options.summaryPath ?? options.stdoutPath,
		});
		return { exitCode: code, signal, ...(resultId ? { resultId } : {}) };
	} catch (error) {
		if (heartbeat) clearInterval(heartbeat);
		if (child && !child.killed) terminateProcessGroupBestEffort(child);
		try {
			if (!launched) store.failHandlerLaunch(options.handlerId, { requeue: options.requeueOnLaunchFailure ?? true, error: error instanceof Error ? error.message : String(error) });
			else store.completeHandler(options.handlerId, { status: "failed", summaryPath: options.stderrPath });
		} catch {
			// Preserve original launch/supervisor failure.
		}
		throw error;
	} finally {
		closeFdBestEffort(stdoutFd);
		closeFdBestEffort(stderrFd);
		store.close();
	}
}
