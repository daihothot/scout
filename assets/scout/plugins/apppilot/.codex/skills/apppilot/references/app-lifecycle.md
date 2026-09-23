# App lifecycle

Call `identify` first in the current AppPilot process, then invoke lifecycle operations without passing its result:

```bash
~/.apppilot/apppilot install --app-id com.example.app --artifact-path /absolute/app.apk
~/.apppilot/apppilot launch --app-id com.example.app
~/.apppilot/apppilot restart --app-id com.example.app
~/.apppilot/apppilot shutdown --app-id com.example.app
~/.apppilot/apppilot uninstall --app-id com.example.app
```

The selected Adapter owns one transport. Its selected Executor implements the operation for one platform and silently invokes any required platform tool.
