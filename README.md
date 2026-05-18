# pi-forks

Shared fork runtime and Pi extension for background fork handler sessions launched by other Pi extensions.

It gives forks their own UI instead of burying fork telemetry inside `pi-intercom`, `pi-return-on`, or `pi-subagents`.

## What it shows

- Shared runtime helpers for fork handler paths/state, intercom identities, Pi fork args, environment flags, and detached process launch.
- Source-scoped footer status while forks are running: running count, tokens, longest duration.
- Source-scoped widget detail: source extension, status, label, duration, token usage, pid, and intercom target.
- `/forks <source>` command for active/stale forks for one source.
- `/forks <source> --all` to include completed, failed, and unknown handlers for that source.
- `/forks --all-sources` for the intentional global view.

Currently it reads existing state from:

- `~/.local/state/pi-intercom/handlers.json`
- `~/.local/state/pi-return-on/handlers.json`
- `~/.local/state/pi-subagents/handlers.json`
- `~/.local/state/pi-subagents/handlers/` best-effort fallback for older handler dirs

Running counts are authoritative when the source extension writes pid/status metadata. Older `pi-subagents` handler dirs without a shared record are shown as `unknown` only in `--all` views.

By default the extension does **not** render a global all-source widget. To opt into an automatic widget for one source, set:

```bash
PI_FORKS_SOURCE=return_on # or intercom, subagents
```

This keeps each extension's default display scoped to forks related to itself. Use `--all-sources` only when you explicitly want the global monitor.

## Shared runtime

Source extensions can import `pi-forks/runtime` to keep fork behavior consistent:

- `buildForkRunPaths(source, id)` creates standard handler paths.
- `buildForkHandlerEnv(source, id, env)` sets source-specific handler env flags.
- `buildForkIntercomIdentity(source, id)` derives the intercom session name/status tag.
- `buildPiForkArgs(...)` builds standard `pi -p --session-dir ... @prompt` args.
- `launchDetachedFork(...)` owns detached process launch, stdio logs, spawn/error handling, and close callbacks.

`pi-intercom`, `pi-return-on`, and `pi-subagents` can import these helpers when `pi-forks` is installed. Their integration should declare `pi-forks` as an optional peer dependency and keep a small protocol-compatible fallback so the source extension still works without the monitor/runtime package installed.

## Intercom awareness

When `pi-intercom` is installed in a fork handler, it auto-names handler sessions from the same environment flags used by `pi-forks`. `pi-forks` now derives and displays those targets so forks can be contacted or referenced consistently:

- `intercom` handlers: `fork-intercom-<short-run-id>`
- `return_on` handlers: `fork-return-on-<short-run-id>`
- `subagents` handlers: `fork-subagent-<short-run-id>`

If a source records a parent intercom target, the widget and command output also show `parent=<target>`.

## Install

From this directory:

```bash
pi install .
```

Or add it to Pi settings as a local package/extension during development.

## Commands

```text
/forks intercom          show active/stale pi-intercom fork handlers
/forks return_on         show active/stale pi-return-on fork handlers
/forks subagents         show active/stale pi-subagents fork handlers
/forks return_on --all   include completed/failed/unknown for that source
/forks --all-sources     intentional global active/stale view
/forks --all-sources -a  intentional global view including completed records

/intercom-forks          shorthand for /forks intercom
/return-on-forks         shorthand for /forks return_on
/subagent-forks          shorthand for /forks subagents
```
