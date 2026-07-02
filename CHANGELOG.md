# Changelog

## 0.1.0

- Adds shared background-events router/runtime and supervised handler helpers for source-neutral fork routing.
- Adds parent/main-owned fork controls: modal `P`/`U`/`X`, `forks` tool `pause`/`resume`/`stop`, and `/forks-pause`, `/forks-resume`, `/forks-stop` commands.
- Adds passive inspection: modal `Enter`/`i`, `forks` tool `inspect`, and `/forks-inspect` show metadata plus bounded stdout/stderr and session-activity tails.
- Adds packaged audit script (`npm run audit`, `npm run audit:json`) for background-events DB, queue, lineage, results, and health visibility.
- Initial standalone fork-monitor extension and shared runtime.
- Adds `/forks`, footer status, and fork widget telemetry.
- Reads pi-intercom, pi-return-on, and best-effort pi-subagents handler state.
- Exposes shared helpers for fork paths, environment flags, intercom identity, Pi args, and detached process launch.
