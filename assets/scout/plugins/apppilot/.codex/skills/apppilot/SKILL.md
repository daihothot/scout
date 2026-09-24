---
name: apppilot
description: Use AppPilot for physical build, install, launch, shutdown, input, and log operations on explicitly discovered execution targets. Use when the caller owns workflow state and project-level behavior remains outside AppPilot.
---

# AppPilot

AppPilot exposes physical operation semantics through a flat CLI. Project-level behavior belongs to the project's behavior system.

For runtime operations, explicitly call `identify`, persist its returned identity in the caller, and pass that identity unchanged to each later command through `--identity`. Default discovery checks adapters and their platform executors in registration order. Specified transport discovery checks only that transport and never falls back.

Build selects its target platform directly and does not require runtime discovery.

AppPilot is stateless between commands. If a runtime operation reports `requiresIdentify`, the caller must discover and persist a new identity before retrying.

Read only the needed reference:

- Discovery: [discovery.md](references/discovery.md)
- Build: [build.md](references/build.md)
- Install and lifecycle: [app-lifecycle.md](references/app-lifecycle.md)
- Physical input and logs: [physical-evidence.md](references/physical-evidence.md)
