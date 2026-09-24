# Physical input and logs

```bash
~/.apppilot/apppilot tap --identity '<IDENTITY_JSON>' --x 100 --y 200
~/.apppilot/apppilot swipe --identity '<IDENTITY_JSON>' --from-x 100 --from-y 500 --to-x 100 --to-y 100
~/.apppilot/apppilot logs --identity '<IDENTITY_JSON>' --app-id com.example.app --output-path /absolute/evidence/logs
```

Use `--match <TEXT>` for filtered log output. AppPilot does not interpret project behavior.
