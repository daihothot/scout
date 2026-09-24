# App lifecycle

Call `identify`, persist its returned JSON identity, and pass it to each lifecycle operation:

```bash
~/.apppilot/apppilot install --identity '<IDENTITY_JSON>' --app-id com.example.app --artifact-path /absolute/app.apk
~/.apppilot/apppilot launch --identity '<IDENTITY_JSON>' --app-id com.example.app
~/.apppilot/apppilot restart --identity '<IDENTITY_JSON>' --app-id com.example.app
~/.apppilot/apppilot shutdown --identity '<IDENTITY_JSON>' --app-id com.example.app
~/.apppilot/apppilot uninstall --identity '<IDENTITY_JSON>' --app-id com.example.app
```

Pass optional launch parameters by repeating `--parameter KEY=VALUE` on `launch` or `restart`. The selected platform Executor maps the dictionary to its native launch mechanism.

The identity selects an Adapter by transport and an Executor by platform. The Executor validates that the physical target still matches that identity.
