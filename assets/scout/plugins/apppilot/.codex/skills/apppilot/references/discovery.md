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

Discovery returns a transport and platform identity. The caller persists that fact and passes its JSON value to every runtime command with `--identity`.

AppPilot does not cache discovery. If a runtime command reports `requiresIdentify`, call `identify` again and replace the caller-owned identity.
