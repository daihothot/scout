---
name: apppilot
description: Use AppPilot for physical build, install, launch, shutdown, input, and log operations on explicitly discovered execution targets. Use when the caller owns workflow state and project-level behavior remains outside AppPilot.
---

# AppPilot

AppPilot exposes physical operation semantics through a flat CLI. Project-level behavior belongs to the project's behavior system.

For runtime operations, explicitly call `identify` first in the current AppPilot process. Default discovery checks adapters and their platform executors in registration order. Specified transport discovery checks only that transport and never falls back. AppPilot caches the discovered Adapter and Executor internally; do not pass the returned identity into later commands.

Build selects its target platform directly and does not require runtime discovery.

The caller owns the AppPilot process and workflow state. If a runtime operation reports that the cached selection is unavailable, call `identify` again before retrying.

Read only the needed reference:

- Discovery: [discovery.md](references/discovery.md)
- Build: [build.md](references/build.md)
- Install and lifecycle: [app-lifecycle.md](references/app-lifecycle.md)
- Physical input and logs: [physical-evidence.md](references/physical-evidence.md)
