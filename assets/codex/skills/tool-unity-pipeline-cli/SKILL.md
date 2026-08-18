---
assetKind: scout.skill
name: tool-unity-pipeline-cli
description: 使用 Unity Pipeline CLI 定位目标 Unity Editor 或桌面 Unity Player、发现并执行 Pipeline command，并在明确约束下使用 eval 或 eval_file 执行 C# 时使用。
id: tool-unity-pipeline-cli
version: 0.4.2
phase: [verify, validate]
family: [tool, unity, pipeline-cli]
tags: [unity, pipeline, cli, editor, desktop, player, automation, shell-tool]
devices: [editor, desktop]
dependencies:
  shellTools:
    required: [unity]
summary: 定义 Unity Pipeline CLI 面向 Editor 和桌面 Player 的目标选择、命令调用、C# Eval 及通用失败契约。
---

# Tool Unity Pipeline CLI

当需要通过 `unity` CLI 与已经连接的 Unity Editor 或桌面 Unity Player Pipeline 通信时使用本技能。

本技能只拥有 Unity Pipeline CLI 的通用操作 contract。具体 command 的业务语义、输入参数、正式 artifact 和结果解释由消费本技能的专用 Skill 拥有。

## Skill Type

- type: tool
- structure_level: full
- note: 本技能定义 Unity Pipeline CLI 的稳定调用边界，不拥有任何具体 Signal、BDD、匹配条件或验证结论。

## Core Use

使用本技能处理：

- 确认当前 `unity` CLI 版本和可用性。
- 使用明确的 project path 或 runtime identity 唯一选择已经连接的 Editor 或桌面 Player。
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
- 除 `Conditional References` 明确授权的兼容修复外，启动、停止、打开、构建或修改 Unity Editor/Player 来满足连接前提。

## Tool Model

- `unity` 是 Unity CLI 的 shell tool identity。
- Pipeline command 由目标 Editor 或桌面 Player 中的 Unity Pipeline package 注册，不是 CLI 的固定内建清单。
- `unity status` 只用于检查已连接 Editor；`unity list` 用于发现当前 Editor/Player 已注册的 command；`unity command` 执行一个已发现 command。
- Editor 调用必须显式传入 `--project-path`；桌面 Player 调用必须显式传入 `--runtime` 或 `--runtime-path`。
- `--project-path` 和 `--runtime` 可能匹配多个候选；必须根据结构化结果确认唯一目标。`--runtime-path` 必须指向目标 Player 的 runtime port file。
- CLI 成功只表示调用协议完成。具体 command 是否形成有效业务结果由消费本技能的专用 Skill 判断。
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
  project_path: <绝对 Unity project path>
```

或：

```text
target
  kind: desktop_player
  selector: <runtime_name | runtime_path>
  value: <Player executable name | runtime port file 绝对路径>
```

目标规则：

- `editor` 只使用 `project_path`，不得同时出现 runtime selector。
- `desktop_player` 只使用一个 runtime selector，不得同时出现 `runtime_name` 和 `runtime_path`。
- `runtime_name` 对应 CLI `--runtime <player-exec-name>`，必须唯一匹配桌面 Unity Player 进程。
- `runtime_path` 对应 CLI `--runtime-path <path>`，必须是目标桌面 Player runtime port file 的绝对路径。
- `desktop_player` 必须是启用了 Runtime Pipeline Manager 的 Windows、macOS 或 Linux Standalone Development Build；非 Development Build 不具备 runtime server、code evaluation 或 hot reload。
- 本技能不支持 iOS、Android、WebGL、移动真机或设备 WebSocket target。

本技能有两种消费方式：

- 执行模式：调用方必须实际拥有 `unity` shell tool，并遵守本技能的全部命令规则。
- 审计模式：调用方可以读取本技能检查已有调用记录，但不得在没有 `unity` shell tool 时执行命令。

## Inputs

### I-001: Execution Target

描述：

- 当前 task 已确认的 `editor` 或 `desktop_player` Target Contract。

注意事项：

- Editor `project_path` 和 Player `runtime_path` 必须是绝对路径；`runtime_name` 必须是已确认的完整 Player executable name。任一 identity 缺失、不唯一或与当前目标冲突时停止。
- 不得用 shell `pwd`、历史 run、CLI 自动检测、最方便的 Editor/Player 或另一种 target 替代。

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

## Command Rules

版本检查：

```text
unity --version
```

Editor 目标检查：

```text
unity --json --non-interactive status --project-path <absolute-project-path>
```

command 发现：

```text
unity --json --non-interactive list --project-path <absolute-project-path>
unity --json --non-interactive list --runtime <player-exec-name>
unity --json --non-interactive list --runtime-path <absolute-runtime-port-file>
```

command 执行：

```text
unity --json --non-interactive command --project-path <absolute-project-path> --timeout <seconds> <command> [args...]
unity --json --non-interactive command --runtime <player-exec-name> --timeout <seconds> <command> [args...]
unity --json --non-interactive command --runtime-path <absolute-runtime-port-file> --timeout <seconds> <command> [args...]
```

Eval 执行：

```text
unity --json --non-interactive command <target-selector> --timeout <cli-seconds> eval "code=<C# method body>" timeout=<eval-milliseconds>
unity --json --non-interactive command <target-selector> --timeout <cli-seconds> eval_file file=<absolute-cs-path> timeout=<eval-milliseconds>
```

其中 `<target-selector>` 必须原样替换为 Target Contract 唯一允许的一种 selector：

```text
--project-path <absolute-project-path>
--runtime <player-exec-name>
--runtime-path <absolute-runtime-port-file>
```

执行规则：

- 先记录 `unity --version` 的当前输出，再检查 target 和 command。
- Editor 的 `status` 返回零个候选时按未连接处理；返回多个候选时按目标不唯一处理。
- 只有 Editor 结构化结果中的 project path 与输入完全匹配时，才能继续发现或执行 command。
- 桌面 Player 必须由本次 `list` 结果确认连接和 command 可用；`runtime_name` 匹配不唯一时停止并要求明确的 `runtime_path`。
- `--project-path`、`--runtime` 和 `--runtime-path` 互斥，不得在一次调用中组合。
- command 未出现在本次 `list` 结果中时停止，不得尝试相似名称。
- 有副作用 command 必须由专用 Skill 明确授权；本技能不能依据命令名自行推断授权。
- 禁止为了让 command 可用而隐式调用 `unity open`、`unity run`、`unity build`，或启动、停止 Editor/Player。

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

```text
tool_ref: tool-unity-pipeline-cli
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

消费方可以把该记录作为自身 artifact provenance，但不得把它替代 command-specific 输出。

## Failure Rules (Enforcement)

- FR-001：`unity` 不可用、版本检查失败、目标 Editor/Player 未连接、目标不唯一或 target identity 不匹配时，调用失败。
- FR-002：Editor 正在 domain reload、Player runtime endpoint 不可用、command 暂不可用或连接在调用中断开时，当前调用失败。
- FR-003：command 不存在、timeout、非零退出码、空 stdout、无效 JSON 或结果 schema 不匹配时，当前调用失败。
- FR-004：CLI 调用失败不得被消费方解释为具体 Signal 缺失、业务失败或验证结论。
- FR-005：Eval compilation diagnostic 包含 error、执行异常、`EvalResponse.success=false` 或 `result` 不符合 Evaluation Contract 时，本次 Eval 失败。
- FR-006：Eval timeout、连接中断或 response 丢失时，不得声明 source 未执行、已终止或没有产生部分副作用。
- FR-007：Unity Pipeline CLI 或当前目标 runtime 发生错误、空输出、权限失败、参数失败、超时、连接中断、响应丢失或状态不确定时，必须立即停止当前依赖范围，并通过正式 `RequestHumanInput` 请求人工解决；请求必须说明失败命令、target、原始错误摘要、受影响范围、已确认状态和修复后需要重新执行的检查。

## Blocking Rules (Enforcement)

- BR-001：执行模式缺少 `unity`、明确 Execution Target、command identity、参数 contract、副作用类别或 timeout 时停止。
- BR-002：多个 Editor/Player 匹配同一 selector，或结构化结果不能证明唯一目标时停止。
- BR-003：command 的副作用无法分类或授权不明确时停止。
- BR-004：Eval 缺少完整 source、预期 result schema、两个 timeout、完整副作用审查或专用 Skill 授权时停止。
- BR-005：Runtime target 不是已启用 Pipeline 的 Standalone Development Build，或 `eval` / `eval_file` 未出现在当前 target 的 `list` 中时停止。

## Retry Rules (Enforcement)

- RR-001：本技能声明的 Unity Pipeline CLI 或目标 runtime 首次失败后不得自动重试；必须立即停止当前依赖范围并请求人工。
- RR-002：不得自行重启、重载、切换 Editor/Player、改变 selector、修改参数或调整 timeout 来绕过故障。
- RR-003：不得改用未由本技能声明的其它 runtime、command 或本地文件来源绕过失败。
- RR-004：人工修复并明确回复后，才能从失败阶段重新执行必要检查；重跑必须保持原 target、command、参数和结果 contract，并记录修复后的输出差异。

## Prohibited Rules (Enforcement)

- PR-001：禁止依赖 project 自动检测、模糊 runtime 匹配或 target fallback 选择 Editor/Player。
- PR-002：禁止隐式启动、停止、打开、重载、构建或修改 Unity Editor/Player。
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
- target 是当前 task 已确认的 Editor 或桌面 Player。
- Editor 使用唯一、完全匹配的 project path；桌面 Player 使用唯一 runtime name 或明确 runtime port file。
- command 来自当前 target 的结构化 `list` 结果。
- command 的副作用类别、授权和 timeout 明确。
- 实际调用使用 JSON、非交互、唯一 target selector 和有界 timeout。
- 退出码、stdout、stderr、参数、时间和限制均已保留。
- 通用调用事实没有替代 command-specific artifact 或业务结论。
- Eval 只在没有适用专用 command 时使用，且完整 source、目的和预期 `result` schema 已确认。
- `eval_file` 使用 Unity 可读、位于 Unity project 之外的绝对 `.cs` 文件路径。
- Eval source 是有界方法体，不包含后台工作、阻塞等待、生命周期控制或未授权副作用。
- Eval timeout 毫秒值和 CLI timeout 秒值均已显式记录，且没有被解释为取消或回滚保证。
- Eval 的完整 `EvalResponse` 已保留，并同时检查进程退出码、`success`、diagnostics 和 `result` contract。
