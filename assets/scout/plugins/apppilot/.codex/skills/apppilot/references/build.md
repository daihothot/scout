# Build

Build selects a platform tool directly:

```bash
~/.apppilot/apppilot build --platform android --project-path /absolute/project --output-path /absolute/output/app.apk
```

For iOS, `outputPath` is the generated Xcode project directory. Add `--build-native` to run the native build. Optional flags are `--release`, `--append`, and `--build-resources`.
