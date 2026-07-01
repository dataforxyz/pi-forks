# pi-forks

Shared fork runtime and Pi extension for background fork handler sessions launched by other Pi extensions.

It gives forks their own UI instead of burying fork telemetry inside `pi-intercom`, `pi-return-on`, or `pi-subagents`.

## What it shows

- Shared runtime helpers for fork handler paths/state, intercom identities, Pi fork args, environment flags, and detached process launch.
- Source-scoped footer status while forks are running: a green growing fork icon, running count, and `Ctrl+Alt+F` shortcut hint.
- A small, color-coded modal for fork details: source extension, status, label, duration, and token usage by default.
- `Ctrl+Alt+F` or `/forks` opens the current chat by default. The modal has toggles for `t` related-only, `c` completed, `s` sort mode, and `v` reverse sort; press `a` to cycle scopes: this chat, response handlers, subagents, user forks, all forks. Press capital `P` to pause, `U` to resume, or `X` to stop the selected running fork handler. Close with `Esc` or `q`.
- `/forks <source> --all` to include completed, failed, and unknown handlers for that source.
- `/forks --all-sources` for the intentional global view.
- `/forks --health` or `/forks-health` for a text diagnostic report covering stale dead-PID records, failed/unknown handlers, duplicate active handlers in the same cwd, and token totals.

Currently it reads existing state from:

- `~/.local/state/pi-intercom/handlers.json`
- `~/.local/state/pi-return-on/handlers.json`
- `~/.local/state/pi-subagents/handlers.json`
- `~/.local/state/pi-subagents/handlers/` best-effort fallback for older handler dirs

Running counts are authoritative when the source extension writes pid/status metadata. Older `pi-subagents` handler dirs without a shared record are shown as `unknown` only in `--all` views and labeled as legacy untracked handler dirs so they are not confused with live fork state.

By default the extension does **not** render a global all-source footer indicator. To opt into an automatic footer indicator for one source, set:

```bash
PI_FORKS_SOURCE=return_on # or intercom, subagents
```

This keeps the default footer scoped to forks related to the current chat/session. Related means the fork names this chat as its parent, this chat is itself the fork session, or the fork shares the same cwd when no parent metadata is available. Fresh sessions stay quiet until they start their own fork. Use `--all-sources`, turn related-only off with `t`, or choose the modal's `all forks` scope only when you explicitly want the global monitor. The active-fork footer stays intentionally tiny with one growing pixel-fork icon, for example `┌┬┐ 1 · Ctrl+Alt+F`, `┌┬┬┐ 2 · Ctrl+Alt+F`, up to `┌┬┬┬┬┐+ N · Ctrl+Alt+F`; when other sessions also have forks, the icon can grow from the global running count while the number stays scoped, e.g. `1/2` means one fork in this chat out of two total. Token/cost spend display lives in the separate `pi-spend` package.

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

## Agent-visible fork control

`pi-forks` registers a `forks` tool so agents can see what this dialog has running without leaving the conversation:

```json
{ "action": "list" }
{ "action": "audit", "all": true }
{ "action": "pause", "id": "icfh_..." }
{ "action": "resume", "id": "icfh_..." }
{ "action": "stop", "id": "icfh_..." }
```

Control is intentionally parent-owned: fork handler sessions may inspect with `list`/`audit`, but `pause`/`resume`/`stop` are denied from inside fork handlers and are also refused for fork runs not owned by the current main dialog/session. Starting new background work remains source-owned: use `subagent` async/background runs, `return_on` fork delivery, or intercom delegation; `pi-forks` observes and controls those forks rather than spawning arbitrary work itself.

Command equivalents:

```text
/forks-pause [source] <id-or-prefix>
/forks-resume [source] <id-or-prefix>
/forks-stop [source] <id-or-prefix>
```

## Audit and observation

For terminal audits outside the TUI, use the packaged audit script:

```bash
npm run audit -- --all --limit 100 --run-limit 100
npm --silent run audit:json -- --all > forks-audit.json
```

The audit report shows:

- state roots and source handler files being inspected;
- active/recent fork handlers, their source, status, PID, parent target, and activation time;
- shared background-events DB health, slots, queue depth, attached updates, results, and lineage budgets;
- recent deterministic transition audit rows (`handler-starting`, `attached-to-handler`, `queued`, completion, launch failure, and reconciler transitions);
- health issues such as stale PIDs, failed handlers, duplicate active cwd groups, and high incomplete spend.

Useful options:

```text
--all / --completed       include completed handlers in the run list
--source intercom         limit source view to intercom, return_on, or subagents
--limit 200              increase DB timeline rows
--run-limit 200          increase text handler/run rows
--json                   machine-readable report
--db /path/to/db         inspect an isolated/background test DB
```

## Commands

```text
Ctrl+Alt+F              open compact fork handlers modal
/forks intercom          open active/stale pi-intercom fork handlers
/forks return_on         open active/stale pi-return-on fork handlers
/forks subagents         open active/stale pi-subagents fork handlers
/forks --related         force related-only filtering
/forks --unrelated       turn related-only filtering off
/forks --sort=newest     sort by status/newest/oldest/duration/source/label
/forks return_on --all   include completed/failed/unknown for that source
/forks --all-sources     intentional global active/stale view
/forks --all-sources -a  intentional global view including completed records
/forks --health          diagnose stale/duplicate/failed fork records
/forks-health            shorthand health report across all sources
/forks-pause <id>        pause one of this main dialog's fork handlers
/forks-resume <id>       resume one of this main dialog's fork handlers
/forks-stop <id>         stop one of this main dialog's fork handlers

/intercom-forks          shorthand for /forks intercom
/return-on-forks         shorthand for /forks return_on
/subagent-forks          shorthand for /forks subagents
```
