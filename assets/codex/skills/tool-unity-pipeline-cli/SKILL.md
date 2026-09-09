---
assetKind: scout.skill
name: tool-unity-pipeline-cli
description: 使用 Unity Pipeline CLI 创建 Unity Editor 进程、控制已连接 Editor 的 Play Mode，或定位 Editor / 桌面 Player 并执行 Pipeline command 时使用。
id: tool-unity-pipeline-cli
version: 0.6.2
type: tool
family: [tool, unity, pipeline-cli]
tags: [unity, pipeline, cli, editor, desktop, player, automation, shell-tool]
devices: [editor, desktop]
dependencies:
  shellTools:
    required: [unity]
summary: 定义 Unity Editor 进程与 Play Mode 生命周期、Editor / 桌面 Player 目标选择、Pipeline command 和 C# Eval 的调用边界。
---

# Tool Unity Pipeline CLI

当需要通过 `unity` CLI 显式创建 Unity Editor 进程、控制已连接 Editor 的 Play Mode，或与已经连接的 Unity Editor / 桌面 Unity Player Pipeline 通信时使用本技能。

本技能只拥有 Unity Pipeline CLI 的通用操作 contract。具体 command 的业务语义、输入参数、正式 artifact 和结果解释由消费本技能的专用 Skill 拥有。

## Skill Type

- type: tool
- layout: workflow
- note: 本技能定义 Unity Pipeline CLI 的稳定调用边界，不拥有任何具体 Signal、BDD、匹配条件或验证结论。

## Core Use

使用本技能处理：

- 确认当前 `unity` CLI 版本和可用性。
- 不依赖 Unity 工程输入，列出当前已连接的 Editor，并在只有一个 Editor 时读取其身份、版本和状态。
- 使用明确的 Unity project 绝对路径创建一个长生命周期 Editor platform run。
- 使用明确的 project path 或 runtime identity 唯一选择已经连接的 Editor 或桌面 Player。
- 发现并调用 `editor_play`、`editor_status` 和 `editor_stop`，控制已连接 Editor 的 Play Mode 生命周期。
- 从当前目标发现 Pipeline package 已注册的 command。
- 以 JSON、非交互和有界 timeout 方式调用 command。
- 在专用 command 不能表达所需操作时，审查并执行有界的 `eval` 或 `eval_file` C# 代码。
- 记录命令、参数、退出码、stdout、stderr、耗时和通用限制。
- 处理 Editor/Player 未连接、目标不唯一、domain reload、runtime endpoint 不可用、command 不存在、timeout、非零退出码和 JSON 解析失败。
- 区分只读 command 和具有外部副作用的 command。

不使用本技能处理：

- 定义 runtime log、local storage 或其它具体 Signal。
- 规定某个 command 的 marker、文件选择、digest、locator 或正式 artifact。
- 决定 BDD、Verification Manual、匹配条件、observation result 或验证结论。
- 复制 Unity Pipeline 的完整 command 清单。
- 使用 `eval` 绕过已存在的专用 command、授权边界、专用 Skill 或调用结果 contract。
- 连接 iOS、Android、WebGL 或其它非桌面 Player target。
- 为普通 Pipeline command 隐式启动 Editor/Player、进入或退出 Play Mode，或启动、停止、构建、修改桌面 Player。
- 根据 platform run 是否启动成功推断 WebSocket endpoint、schema、session 或业务能力已经可用。

## Tool Model

- `unity` 是 Unity CLI identity。当前环境提供 `UnityPipeline` 动态工具时，由该工具在宿主侧执行允许的 Unity CLI 操作；没有该动态工具时，执行模式才直接使用 `unity` shell tool。
- `unity run` 启动 Unity Editor 进程；`editor_play` 和 `editor_stop` 只改变已连接 Editor 的 Play Mode。两种生命周期不能互相替代。
- Pipeline command 由目标 Editor 或桌面 Player 中的 Unity Pipeline package 注册，不是 CLI 的固定内建清单。
- `unity status` 不带参数时列出全部已连接 Editor；`unity list` 用于发现当前 Editor/Player 已注册的 command；`unity command` 执行一个已发现 command。
- 当不带参数的 `unity status` 恰好返回一个 Editor 时，Editor 的 `list` 和 `command` 可以不传 `--project-path`；返回零个或多个 Editor 时，不得使用无 selector 调用。
- 当调用方已明确提供 Editor project path 时，Editor 调用可使用 `--project-path`精确选择；桌面 Player 调用必须显式传入 `--runtime` 或 `--runtime-path`。
- 连接唯一的已连接 Editor 不需要调用方提供、读取或检出 Unity 工程；Editor identity、project path、version、PID 和 state 直接来自当前 `unity status` 结构化返回值。
- `--project-path` 和 `--runtime` 可能匹配多个候选；必须根据结构化结果确认唯一目标。`--runtime-path` 必须指向目标 Player 的 runtime port file。
- CLI 成功只表示调用协议完成。具体 command 是否形成有效业务结果由消费本技能的专用 Skill 判断。
- Platform run 启动成功只证明 Unity 进程已按请求启动，不证明 Behavioral control endpoint、callable schema、session 或业务 Hook 可用；这些事实由调用方对应的 Tool / Domain Skill 验证。
- Play Mode command 成功只证明 Editor 报告了对应 Play Mode 状态，不证明某个业务 endpoint、schema 或能力已经可用。
- `eval` 和 `eval_file` 是 Pipeline package 注册的 command，仍必须出现在当前 target 的 `unity list` 结果中。
- `unity` CLI 负责读取 instance descriptor 和提供认证。调用方不得直接读取、记录或暴露 descriptor 中的 `evalToken`，也不得绕过 CLI 直接请求 Pipeline HTTP endpoint。

## Conditional References

- 只有在 macOS Editor 的 Pipeline listener 连接失败，且普通 target、package、domain reload、认证和端口问题均已排除后，才读取 [pipeline-prefix-patch.md](references/pipeline-prefix-patch.md) 判断是否命中特定 prefix 兼容问题。
- 未通过该 reference 的全部诊断和安全门禁时，不得部署兼容 asset，也不得修改 `PackageCache`。

### Target Contract

每次调用必须选择以下一种 target：

```text
target
  kind: editor
  project_path: <绝对 Unity project path；仅在调用方已明确指定时提供>
```

或：

```text
target
  kind: desktop_player
  selector: <runtime_name | runtime_path>
  value: <Player executable name | runtime port file 绝对路径>
```

目标规则：

- `editor` 不得出现 runtime selector。未提供 `project_path` 时，必须先用不带参数的 `unity status` 确认当前恰好只有一个 Editor。
- `desktop_player` 只使用一个 runtime selector，不得同时出现 `runtime_name` 和 `runtime_path`。
- `runtime_name` 对应 CLI `--runtime <player-exec-name>`，必须唯一匹配桌面 Unity Player 进程。
- `runtime_path` 对应 CLI `--runtime-path <path>`，必须是目标桌面 Player runtime port file 的绝对路径。
- `desktop_player` 必须是启用了 Runtime Pipeline Manager 的 Windows、macOS 或 Linux Standalone Development Build；非 Development Build 不具备 runtime server、code evaluation 或 hot reload。
- 本技能不支持 iOS、Android、WebGL、移动真机或设备 WebSocket target。

本技能有三种消费方式：

- 宿主动态工具模式：当前提供 `UnityPipeline` 时必须使用它，按 `operation` 选择 `version`、`status`、`list`、`editor_play`、`editor_status` 或 `editor_stop`；不得再从 shell 执行同一操作。工具返回实际 `exitCode`、`stdout`、`stderr` 和完成状态，按本技能对应命令规则解释。
- Shell 执行模式：当前没有 `UnityPipeline` 时，调用方必须实际拥有 `unity` shell tool，并遵守本技能的全部命令规则。
- 审计模式：调用方可以读取本技能检查已有调用记录，但不得在没有 `unity` shell tool 时执行命令。

### Platform Run Contract

本节只适用于调用方明确要求创建新的 Unity Editor 进程的场景。RBT Executor 不进入本节；RBT 只使用已连接 Editor 的发现和 Play Mode contract，Editor 版本来自不带参数的 `unity status` 返回的 `version`，不得读取 Unity 工程文件。

显式创建 Editor platform run 时必须提供：

```text
platform_run
  project_path: <绝对 Unity project path>
  editor_version: <明确版本或从 ProjectVersion.txt 取得的版本>
  editor_path: <明确 Editor binary 绝对路径；未指定时为 none>
  architecture: <明确 architecture；未指定时为 none>
  allow_install: <false；只有得到明确授权才可为 true>
  editor_arguments: <显式转发给 Editor 的参数；没有时为 none>
  process_ref: <调用方用于跟踪长生命周期进程的稳定 ref>
```

规则：

- `project_path` 必须是当前 task 已确认的绝对路径；不得省略 project 参数、使用 project name、相对路径或 cwd 默认值。
- 优先使用 project 的 `ProjectVersion.txt` 选择已安装 Editor。`--editor-version`、`--editor-path` 和 `--architecture` 只能使用已确认的实际值。
- 默认禁止 `--allow-install`。它会安装 Editor，只有当前调用得到明确安装授权时才能启用。
- `unity run` 是长生命周期、有外部副作用的操作。调用方必须保留进程或 tool session ref，以便区分启动中、运行中、退出和状态未知。
- 本 Skill 不根据端口常量或日志猜测 Behavioral control endpoint；platform run 之后由调用方对应的控制面 Tool 取得并验证实际 endpoint。

### Editor Play Mode Contract

已连接 Editor 的 Play Mode 生命周期必须提供：

```text
editor_play_mode
  project_path: <绝对 Unity project path；唯一已连接 Editor 模式填写 none>
  requested_operation: <play | status | stop>
  timeout_seconds: <有限正数>
```

规则：

- 未提供 `project_path` 时，先用不带参数的 `unity status` 确认恰好返回一个 Editor，再使用同样不带 selector 的 `unity list` 和 `unity command`。
- 提供 `project_path` 时，先用 `unity status --project-path` 唯一定位完全匹配的 Editor；后续 `unity list` 和 `unity command` 必须逐字使用同一路径。
- 两种模式都要先确认本次所需的 `editor_play`、`editor_status` 或 `editor_stop` 已注册；不得在调用中途从无 selector 模式切换到工程路径模式，或反向切换。
- `editor_play` 和 `editor_stop` 是有副作用的 Pipeline command，只有消费本技能的专用 Skill 明确要求对应生命周期动作时才能调用。
- `editor_play` 不启动新的 Editor 进程；`editor_stop` 不退出 Editor 进程。
- 调用 `editor_play` 或 `editor_stop` 后，必须用 `editor_status` 确认实际 Play Mode 状态。command response 成功但状态不符时，结果仍未闭合。
- 本 Skill 不为 Play Mode 推断业务 endpoint、端口、schema、session 或能力。

## Inputs

### I-001: Execution Target

描述：

- 当前 task 已确认的 `desktop_player` Target Contract，或者当前 Unity CLI 能唯一发现的 `editor` Target Contract。

注意事项：

- Editor 未提供 `project_path` 时，当前 `unity status` 必须恰好返回一个 Editor；提供时必须是绝对路径并唯一匹配。Player `runtime_path` 必须是绝对路径，`runtime_name` 必须是已确认的完整 executable name。
- 不得用 shell `pwd`、managed codebase、历史 run 或另一种 target 替代 Unity CLI 当前返回的 Editor/Player。

### I-002: Pipeline Command

描述：

- 消费本技能的专用 Skill 指定的 command identity、参数和预期结果 contract。

注意事项：

- command 必须出现在当前 target 的 `unity list` 结构化结果中。
- 本技能不根据相似名称、历史 command 清单或模型记忆猜测 command。

### I-003: Execution Policy

描述：

- 当前 command 的副作用类别和有界 timeout。

注意事项：

- 消费方必须把 command 明确分类为只读或有副作用；无法分类时停止。
- timeout 必须是有限正数；不得通过无限等待掩盖 Editor、domain reload 或连接故障。

### I-004: Evaluation Contract

描述：

- 仅在执行 `eval` 或 `eval_file` 时提供，必须包含执行目的、完整 C# source、预期 `result` schema、副作用类别、允许的副作用、Eval timeout 和 CLI timeout。

注意事项：

- 使用 `eval` 时，完整 source 必须作为本次 `code` 参数接受审查；使用 `eval_file` 时，必须提供 Unity 进程可读取的绝对 `.cs` 文件路径和完整文件内容。
- 调用前必须确认现有专用 command 不能表达该操作。存在适用的专用 command 时停止 Eval 路径并使用专用 command。
- Eval source 只有在全部语句均为有界读取且不会修改 Unity、文件系统、进程或外部系统时，才可分类为只读；其余情况全部分类为有副作用。
- 有副作用的 Eval 必须由消费本技能的专用 Skill 明确授权代码和允许的副作用；授权缺失或 source 无法完整审查时停止。

### I-005: Platform Run

描述：

- 仅在调用方明确要求创建 Unity Editor platform run 时提供的 Platform Run Contract。

注意事项：

- 普通 Pipeline command 不得隐式补出本输入。
- Platform Run Contract 缺失任何必需 identity 时停止；不得用本机最方便的项目、Editor 或 architecture 替代。

### I-006: Editor Play Mode

描述：

- 仅在调用方明确要求已连接 Editor 进入、查询或退出 Play Mode 时提供的 Editor Play Mode Contract。

注意事项：

- `project_path` 为 `none` 时，当前不带参数的 `unity status` 必须恰好返回一个 Editor；具体路径必须唯一匹配该 Editor。
- 调用方必须明确拥有 `play` 或 `stop` 动作；本技能不能根据当前状态自行决定进入、复用或退出 Play Mode。
- 本输入不授权启动或退出 Editor 进程。

## Command Rules

版本检查：

```text
unity --version
```

显式创建 Editor platform run：

```text
unity --non-interactive run <absolute-project-path> [--editor-version <version>] [--editor-path <absolute-editor-path>] [--architecture <arch>] [--timeout <seconds>] [-- <explicit-editor-arguments>]
```

Platform run 规则：

- 只有调用方明确选择 Platform Run 模式时才能执行 `unity run`。不得从 `status` 返回零个候选自动进入该模式。
- `<absolute-project-path>` 必须显式给出。不得使用 `unity run`、`unity run .` 或 project name。
- 不传 `--allow-install`；只有已取得明确安装授权时才可以加入，并在输出中记录授权和实际参数。
- 只传本次运行必需且已经审查的 Editor 参数。不得为了猜 Behavioral control endpoint 加入未经调用方 contract 声明的端口参数。
- 进程启动后保留实际 command、参数、process ref、启动时间和当前状态；不能因为进程仍在运行就宣称 Editor、Pipeline 或 WebSocket 已就绪。
- `--timeout` 会终止 Unity 进程，只在调用方明确要求进程生命周期上限时使用；它不是“等待就绪”的 timeout。
- Platform Run 的停止策略由调用方拥有。本 Skill 不因为 task 后续完成而自行杀死或重启进程。

Editor 目标检查：

```text
unity --json --non-interactive status
unity --json --non-interactive status --project-path <absolute-project-path>
```

- 不带 `--project-path` 的结果用于发现当前已连接 Editor。`count: 1` 时可以进入唯一 Editor 模式，并直接使用实例返回的 `project`、`version`、`pid` 和 `state`。
- `count: 0` 表示当前没有已连接 Editor；`count > 1` 表示无 selector 模式无法唯一定位。这两种情况都不得自行选一个候选。

已连接 Editor 的 Play Mode 生命周期：

```text
unity --json --non-interactive command --timeout <seconds> editor_play
unity --json --non-interactive command --timeout <seconds> editor_status
unity --json --non-interactive command --timeout <seconds> editor_stop
unity --json --non-interactive command --project-path <absolute-project-path> --timeout <seconds> editor_play
unity --json --non-interactive command --project-path <absolute-project-path> --timeout <seconds> editor_status
unity --json --non-interactive command --project-path <absolute-project-path> --timeout <seconds> editor_stop
```

Play Mode 规则：

- 调用前通过当前 `unity list` 确认所需 command 已注册。
- `editor_play` 只有在 command 结构化结果成功，且后续 `editor_status` 报告 `playMode: playing` 时成功。
- `editor_stop` 只有在 command 结构化结果成功，且后续 `editor_status` 报告 Editor 已退出 Play Mode 时成功。
- `editor_status` 的实际结构化结果是唯一状态依据；不得用进程存活、端口监听、日志文本或历史状态替代。
- timeout、连接中断或状态确认失败后，Play Mode 状态未知；不得盲目重发同一生命周期命令。

command 发现：

```text
unity --json --non-interactive list
unity --json --non-interactive list --project-path <absolute-project-path>
unity --json --non-interactive list --runtime <player-exec-name>
unity --json --non-interactive list --runtime-path <absolute-runtime-port-file>
```

command 执行：

```text
unity --json --non-interactive command --timeout <seconds> <command> [args...]
unity --json --non-interactive command --project-path <absolute-project-path> --timeout <seconds> <command> [args...]
unity --json --non-interactive command --runtime <player-exec-name> --timeout <seconds> <command> [args...]
unity --json --non-interactive command --runtime-path <absolute-runtime-port-file> --timeout <seconds> <command> [args...]
```

Eval 执行：

```text
unity --json --non-interactive command <target-selector> --timeout <cli-seconds> eval "code=<C# method body>" timeout=<eval-milliseconds>
unity --json --non-interactive command <target-selector> --timeout <cli-seconds> eval_file file=<absolute-cs-path> timeout=<eval-milliseconds>
```

其中 `<target-selector>` 必须原样替换为 Target Contract 唯一允许的一种 selector；唯一 Editor 模式将其整体省略：

```text
--project-path <absolute-project-path>
--runtime <player-exec-name>
--runtime-path <absolute-runtime-port-file>
<唯一 Editor 模式不传 selector>
```

执行规则：

- 先记录 `unity --version` 的当前输出，再检查 target 和 command。
- Editor 的 `status` 返回零个候选时按未连接处理；无 selector 调用返回多个候选时按目标不唯一处理。
- 唯一 Editor 模式只能在当前不带参数的 `unity status` 返回一个实例后使用；工程路径模式只有在结构化结果与输入路径完全匹配时才能继续。
- 桌面 Player 必须由本次 `list` 结果确认连接和 command 可用；`runtime_name` 匹配不唯一时停止并要求明确的 `runtime_path`。
- `--project-path`、`--runtime` 和 `--runtime-path` 互斥，不得在一次调用中组合。唯一 Editor 模式不传任何这类 selector。
- command 未出现在本次 `list` 结果中时停止，不得尝试相似名称。
- 有副作用 command 必须由专用 Skill 明确授权；本技能不能依据命令名自行推断授权。
- 禁止为了让普通 command 可用而隐式调用 `unity open`、`unity run`、`unity build`、`editor_play` 或 `editor_stop`。调用方明确选择 Platform Run 或 Editor Play Mode 时，只允许执行对应 contract 已授权的生命周期动作。

### Eval Rules

选择规则：

- 优先使用已注册且具有明确参数、结果和安全 contract 的专用 command。`eval` 和 `eval_file` 只补充专用 command 无法表达的窄范围诊断或操作。
- 短小、单一目的且可以安全作为一个 shell argument 传递的 source 使用 `eval`；多行、较长或包含复杂 shell quoting 的 source 使用 `eval_file`。
- `eval_file` 由 Unity 进程读取文件。必须使用绝对路径；相对路径不得使用，因为它相对于 Unity 进程工作目录而不是调用方 cwd。
- `eval_file` 文件必须以 `.cs` 结尾、非空，并位于当前 task 允许且处于 Unity project 之外的临时目录或 artifact 目录。不得放入 `Assets`、`Packages`、`ProjectSettings` 或其它会触发导入、编译或项目变更的位置。
- `eval_file` 只读取已有 source 文件；本命令不负责创建、覆盖或删除该文件。

source contract：

- Source 会被包装进生成的 `public static object Execute()` 方法体，而不是作为完整 C# compilation unit 编译。
- Source 可以直接使用 `System`、`System.Collections.Generic`、`System.Linq` 和 `UnityEngine`；Editor target 额外可使用 `UnityEditor`。其它 namespace 使用完整限定名，不得在方法体内放置 `using` 或顶层类型声明。
- Source 必须显式 `return` 一个符合 Evaluation Contract 的有界、可 JSON 序列化结果。`Debug.Log`、Console 输出或无返回值执行不得替代正式 `result`。
- 同一份 source 不得假设 Editor 和 Player API 相同。桌面 Player source 禁止引用 `UnityEditor` 或仅 Editor 可用的 API。
- 禁止把未经约束的用户文本、日志内容、文件内容或其它外部字符串拼接成 C# source。动态值必须作为经过验证的字面量生成，并保留最终实际 source。

执行安全：

- Eval 使用 Roslyn 编译，并在 Unity 主线程同步执行。编译或执行期间可能阻塞 Editor、Player 帧更新和 Pipeline dispatcher，因此 source 必须短小、有界且不依赖后续帧推进。
- Eval 没有专用 command 的 `confirm`、`dry_run`、Undo 或 sandbox 保证。不得依据“看起来像查询”的方法名推断只读，必须审查完整 source。
- 禁止无限或数据无界循环、递归、`Thread.Sleep`、`Task.Wait`、`.Result`、阻塞式长时间 I/O、等待下一帧、等待 domain reload，以及其它无法在本次同步调用内确定完成的工作。
- 禁止创建 fire-and-forget task、后台线程、coroutine、长期事件订阅或脱离本次 response 生命周期的工作。
- 禁止通过 Eval 隐式进入或退出 Play Mode、退出进程、触发 domain/assembly reload，或启动、停止、打开、构建 Editor/Player。
- 禁止通过 Eval 绕过专用 command 的 path confinement、`confirm`、`dry_run`、Undo、权限或授权要求。

timeout contract：

- Eval 参数 `timeout` 使用毫秒，必须显式设置为 `1` 至 `30000`；CLI `--timeout` 使用秒，是独立的外层等待上限。
- CLI timeout 必须大于 Eval timeout，并为连接、编译、序列化和 response 传输留出有限余量。
- Eval 在 Unity 主线程同步执行。`timeout` 和 `--timeout` 都不得解释为 sandbox、抢占式取消、回滚保证或代码已经停止的证明。
- 任一 timeout、连接中断或 response 丢失后，本次执行结果和副作用状态均为未知；确认 target 恢复响应并检查允许的副作用前不得重试。

结果处理：

- 以进程退出码判定 CLI 调用是否成功；非零退出码不得被 stdout 内容覆盖。
- stdout 必须按本次 `--json` 输出解析；空输出、非 JSON 或 schema 与当前 command contract 不一致时失败。
- stderr、原始 stdout、退出码和实际参数必须保留在调用 provenance 中。
- 专用 Skill 负责解释 command payload、创建 artifact 和判断业务完整性；本技能只提供调用事实。
- Eval 必须同时检查进程退出码和 `EvalResponse.success`。退出码为零但 `success=false`、`result` 不符合 Evaluation Contract，或 response 缺少必要字段时仍然失败。
- Eval response 中的 `result`、`output`、`diagnostics`、`error`、`errorDetails` 和 `executionTimeMs` 必须原样保留；`output` 为空不得推断 source 没有执行。
- Roslyn compilation diagnostics 使用从零开始的 `line` 和 `column`，只能用于定位实际 source；不得把编译失败解释为目标状态或业务结果。

## Output Layout

本技能不独立创建正式业务 artifact。每次调用向消费方提供以下通用记录：

Platform Run（仅在调用方明确要求创建新 Editor 进程时）：

```text
tool_ref: tool-unity-pipeline-cli
operation: platform_run
cli_version: <本次 unity --version 输出>
project_path: <实际绝对 project path>
editor_version: <实际 Editor version>
editor_path: <实际 Editor binary path；未显式指定时为 none>
architecture: <实际 architecture；未显式指定时为 none>
allow_install: <实际值>
arguments: <实际完整启动参数>
process_ref: <调用方提供的稳定 process / tool session ref>
state: <starting | running | exited | unknown>
exit_code: <已退出时为实际值；否则为 none>
started_at: <调用开始时间>
observed_at: <最近状态观察时间>
limitations: <none 或状态限制>
behavioral_control_ready: not_determined_by_this_skill
```

Editor Play Mode：

```text
tool_ref: tool-unity-pipeline-cli
operation: editor_play_mode
cli_version: <本次 unity --version 输出>
project_path: <实际绝对 project path>
editor_pid: <本次 unity status 返回的实际 PID>
command: <editor_play | editor_status | editor_stop>
timeout_seconds: <实际 timeout>
exit_code: <进程退出码>
response: <原始 command response>
confirmed_play_mode: <editor_status 返回的实际 playMode>
started_at: <调用开始时间>
completed_at: <调用完成时间>
limitations: <none 或状态限制>
behavioral_control_ready: not_determined_by_this_skill
```

Pipeline command / Eval：

```text
tool_ref: tool-unity-pipeline-cli
operation: pipeline_command
cli_version: <本次 unity --version 输出>
target: <原样保留本次已确认的 Target Contract>
command: <实际 command identity>
arguments: <实际参数>
timeout_seconds: <实际 timeout>
effect: <read_only | side_effect>
evaluation_source: <非 Eval 为 none；eval 为完整 code；eval_file 为绝对 file ref>
eval_timeout_ms: <非 Eval 为 none；Eval 的实际 timeout>
expected_result_contract: <非 Eval 为 none；Eval 的预期 result schema>
exit_code: <进程退出码>
result_format: json
response: <原始 command response；Eval 时包含完整 EvalResponse>
started_at: <调用开始时间>
completed_at: <调用完成时间>
failed_command: <none 或失败命令>
limitations: <none 或通用操作限制>
```

`platform_run`、`editor_play_mode` 与普通 `pipeline_command` 必须分别记录。消费方可以把记录作为自身 artifact provenance，但不得把它替代 command-specific 输出或 Behavioral control connection 事实。

## Failure Rules (Enforcement)

- FR-001：`unity` 不可用、版本检查失败、platform run 启动失败、Play Mode 状态确认失败、目标 Editor/Player 未连接、目标不唯一或 target identity 不匹配时，调用失败。
- FR-002：Editor 正在 domain reload、Player runtime endpoint 不可用、command 暂不可用或连接在调用中断开时，当前调用失败。
- FR-003：command 不存在、timeout、非零退出码、空 stdout、无效 JSON 或结果 schema 不匹配时，当前调用失败。
- FR-004：CLI 调用失败不得被消费方解释为具体 Signal 缺失、业务失败或验证结论。
- FR-005：Eval compilation diagnostic 包含 error、执行异常、`EvalResponse.success=false` 或 `result` 不符合 Evaluation Contract 时，本次 Eval 失败。
- FR-006：Eval timeout、连接中断或 response 丢失时，不得声明 source 未执行、已终止或没有产生部分副作用。
- FR-007：Unity Pipeline CLI 或当前目标 runtime 发生错误、空输出、权限失败、参数失败、超时、连接中断、响应丢失或状态不确定时，必须立即停止当前依赖范围，并通过正式 `RequestHumanInput` 请求人工解决；请求必须说明失败命令、target、原始错误摘要、受影响范围、已确认状态和修复后需要重新执行的检查。

## Blocking Rules (Enforcement)

- BR-001：Platform Run 缺少绝对 project path、Editor selector、实际启动参数或 process ref contract 时停止；Editor Play Mode 缺少唯一 Editor 的当前 CLI 事实或精确 project path、明确 operation 或 timeout 时停止；普通 command 缺少明确 Execution Target、command identity、参数 contract、副作用类别或 timeout 时停止。
- BR-002：多个 Editor/Player 匹配同一 selector，或结构化结果不能证明唯一目标时停止。
- BR-003：command 的副作用无法分类或授权不明确时停止。
- BR-004：Eval 缺少完整 source、预期 result schema、两个 timeout、完整副作用审查或专用 Skill 授权时停止。
- BR-005：Runtime target 不是已启用 Pipeline 的 Standalone Development Build，或 `eval` / `eval_file` 未出现在当前 target 的 `list` 中时停止。

## Retry Rules (Enforcement)

- RR-001：本技能声明的 Unity Pipeline CLI 或目标 runtime 首次失败后不得自动重试；必须立即停止当前依赖范围并请求人工。
- RR-002：不得自行新建第二个 platform run、重启、重载、切换 Editor/Player、改变 selector、修改参数或调整 timeout 来绕过故障。
- RR-003：不得改用未由本技能声明的其它 runtime、command 或本地文件来源绕过失败。
- RR-004：人工修复并明确回复后，才能从失败阶段重新执行必要检查；重跑必须保持原 target、command、参数和结果 contract，并记录修复后的输出差异。

## Prohibited Rules (Enforcement)

- PR-001：禁止依赖模糊 runtime 匹配或 target fallback 选择 Editor/Player。不带 selector 只允许用于当前 `unity status` 恰好返回一个 Editor 的情况。
- PR-002：禁止为普通 Pipeline command 隐式启动 Editor/Player 或改变 Play Mode；只有调用方明确请求对应生命周期时才能调用 `unity run`、`editor_play` 或 `editor_stop`。禁止隐式停止、打开、重载、构建或修改 Editor/Player。
- PR-003：禁止在 command 未被当前 target 注册时调用猜测名称。
- PR-004：禁止忽略非零退出码、stderr、无效 JSON、timeout 或首次失败记录。
- PR-005：禁止在本技能中解释具体 Signal、artifact、BDD 或验证结果。
- PR-006：禁止把 iOS、Android、WebGL、移动真机或设备 WebSocket 当作本技能支持的 target。
- PR-007：禁止使用 Eval 替代适用的专用 command，或绕过专用 command 的安全、路径、权限和授权 contract。
- PR-008：禁止记录、输出、复制或传播 Pipeline instance descriptor 中的 `evalToken`。
- PR-009：禁止在没有完整 source 审查和明确副作用授权时执行 `eval` 或 `eval_file`。
- PR-010：禁止直接修改 `PackageCache`；仅在条件化 reference 明确判定兼容问题后，才可部署其批准的 runtime asset。

## Checklist

- 当前 CLI 版本已由本次 `unity --version` 确认。
- 如选择 Platform Run，使用明确 project 绝对路径和实际 Editor selector；没有依赖 cwd、模糊项目或隐式安装。
- 如选择 Platform Run，启动参数、process/run ref、当前状态和限制已保留，且没有把启动成功解释成 Behavioral control connection 成功。
- Editor Play Mode 操作来自调用方的明确要求，已通过 `editor_status` 确认实际状态，且没有被误写成 Editor 进程生命周期。
- target 是当前 Unity CLI 唯一发现的 Editor、当前 task 明确指定的 Editor，或桌面 Player。
- Editor 使用当前唯一连接或唯一、完全匹配的 project path；桌面 Player 使用唯一 runtime name 或明确 runtime port file。
- command 来自当前 target 的结构化 `list` 结果。
- command 的副作用类别、授权和 timeout 明确。
- 实际调用使用 JSON、非交互和有界 timeout；只有精确选择模式传入唯一 target selector。
- 退出码、stdout、stderr、参数、时间和限制均已保留。
- 通用调用事实没有替代 command-specific artifact 或业务结论。
- Eval 只在没有适用专用 command 时使用，且完整 source、目的和预期 `result` schema 已确认。
- `eval_file` 使用 Unity 可读、位于 Unity project 之外的绝对 `.cs` 文件路径。
- Eval source 是有界方法体，不包含后台工作、阻塞等待、生命周期控制或未授权副作用。
- Eval timeout 毫秒值和 CLI timeout 秒值均已显式记录，且没有被解释为取消或回滚保证。
- Eval 的完整 `EvalResponse` 已保留，并同时检查进程退出码、`success`、diagnostics 和 `result` contract。
