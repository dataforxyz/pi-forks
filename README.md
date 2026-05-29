# pi-forks

Shared fork runtime and Pi extension for background fork handler sessions launched by other Pi extensions.

It gives forks their own UI instead of burying fork telemetry inside `pi-intercom`, `pi-return-on`, or `pi-subagents`.

## What it shows

- Shared runtime helpers for fork handler paths/state, intercom identities, Pi fork args, environment flags, and detached process launch.
- Source-scoped footer status while forks are running: a green growing fork icon, running count, and `Ctrl+Alt+F` shortcut hint.
- A small, color-coded modal for fork details: source extension, status, label, duration, and token usage by default.
- `Ctrl+Alt+F` or `/forks` opens the current chat by default. The modal has toggles for `t` related-only, `c` completed, `s` sort mode, and `v` reverse sort; press `a` to cycle scopes: this chat, response handlers, subagents, user forks, all forks. Close with `Esc` or `q`.
- `/forks <source> --all` to include completed, failed, and unknown handlers for that source.
- `/forks --all-sources` for the intentional global view.
- `/forks --health` or `/forks-health` for a text diagnostic report covering stale dead-PID records, failed/unknown handlers, duplicate active handlers in the same cwd, and token totals.
- A separate spend footer tracks this dialog's token/cost split: main dialog (`◉`), async subagents launched by this dialog (`◆`), related fork handlers (`↯`), and observational-memory footprint (`✦`).

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

This keeps the default footer scoped to forks related to the current chat/session. Related means the fork names this chat as its parent, this chat is itself the fork session, or the fork shares the same cwd when no parent metadata is available. Fresh sessions stay quiet until they start their own fork. Use `--all-sources`, turn related-only off with `t`, or choose the modal's `all forks` scope only when you explicitly want the global monitor. The active-fork footer stays intentionally tiny with one growing pixel-fork icon, for example `┌┬┐ 1 · Ctrl+Alt+F`, `┌┬┬┐ 2 · Ctrl+Alt+F`, up to `┌┬┬┬┬┐+ N · Ctrl+Alt+F`; when other sessions also have forks, the icon can grow from the global running count while the number stays scoped, e.g. `1/2` means one fork in this chat out of two total. Spend is a second footer status, e.g. `◉ dialog 12k/$0.04 · ◆ agents 80k/$0.62 · ↯ forks 42k/$0.21 · ✦ memory 6k/18k tok`, refreshed periodically and scoped to this session's main JSONL, its async subagent run status files, completed plus active forks related to the current chat, and this branch's observational-memory ledger. The memory segment shows visible compaction-context tokens first; if full active memory is larger, it appends `/full`.

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
/pi-spend                show this dialog's dialog/agent/fork/memory token and cost split
/forks-spend             alias for /pi-spend

/intercom-forks          shorthand for /forks intercom
/return-on-forks         shorthand for /forks return_on
/subagent-forks          shorthand for /forks subagents
```
