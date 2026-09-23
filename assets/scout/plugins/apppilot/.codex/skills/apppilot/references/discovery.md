# Discovery

Default discovery:

```bash
~/.apppilot/apppilot identify
```

Specified transport discovery:

```bash
~/.apppilot/apppilot identify --transport adb
~/.apppilot/apppilot identify --transport unity-pipeline
```

Default discovery checks adapters in registration order, and each adapter checks platform executors in registration order. The first available executor wins. Specified discovery checks only the requested transport and never falls back.

Discovery caches the selected Adapter and Executor inside the current AppPilot process. Runtime commands use that cache and do not accept the returned identity as input.

If a runtime command reports `execution_selection_unavailable`, call `identify` again. AppPilot does not rediscover or fall back automatically.
