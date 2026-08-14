---
assetKind: scout.skill
name: signal-unity-runtime-log-unity-pipeline-cli
description: 通过 Unity Pipeline CLI 从 Unity Editor 导出并原样复制符合 signal-unity-runtime-log 格式的原始日志文件时使用。
id: signal-unity-runtime-log-unity-pipeline-cli
version: 0.2.2
phase: [verify, validate]
family: [validation, unity, single, local, general, runtime-log]
tags: [signal, unity, verification, runtime, log, pipeline, cli, shell-tool, source]
devices: [any]
dependencies:
  skills:
    required: [signal-unity-runtime-log, tool-unity-pipeline-cli]
summary: 使用 Unity Pipeline CLI 原样导出 Unity runtime log，并记录文件来源、完整性和操作限制。
---

# Unity Runtime Log via Unity Pipeline CLI

当需要从已连接的 Unity Editor 获取 `signal-unity-runtime-log` 原始日志文件，并把不可变副本交给 Verifier 解释时使用本技能。

本技能只拥有 `export_runtime_log` 的日志导出方法、原始文件复制、操作 provenance、失败和重试规则。Unity Pipeline CLI 的通用调用契约由 `tool-unity-pipeline-cli` 定义；日志格式、记录边界、字段语义、行号和匹配规则由 `signal-unity-runtime-log` 定义。

## Skill Type

- type: tool
- structure_level: full
- note: 本技能是 Unity Editor 原始日志导出工具 Skill，不拥有 Signal 匹配条件、observation result 或验证结论。

## Core Use

使用本技能处理：

- 使用已经按 `tool-unity-pipeline-cli` 唯一确认的 Unity project。
- 通过 `export_runtime_log` 把当前日志逐字节复制到 Verifier artifact 目录。
- 记录源日志位置、复制文件 ref、文件 digest、字节数、命令参数和采集时间。
- 披露命令失败、文件缺失、复制不完整、digest 不一致和日志覆盖限制。

不使用本技能处理：

- 定义或修改 Unity runtime log 的格式和记录语义。
- 从日志中决定匹配条件、业务结论或 verification point 状态。
- 使用 Console buffer、内存记录或筛选结果重建原始日志。
- 修改源日志、Unity project、场景、资源、设置或代码。

## Tool Model

- 本技能通过 `tool-unity-pipeline-cli` 调用 Unity Pipeline。
- `export_runtime_log` 是只读源日志、写入目标副本的导出命令。
- 命令读取当前 Unity Editor 对应的原始 runtime log；不得从 Console buffer、`DumpRecords()` 或其它结构化视图重新序列化日志。
- 命令唯一允许的副作用是创建调用方明确指定的目标副本。
- `export_runtime_log` 的 command identity 必须来自当前 project 的命令发现结果；不得根据历史 run 或示例推断。

## Inputs

### I-001: Unity Project Path

描述：

- 目标 Unity project 的绝对路径，来自当前 task 已确认的 codebase。

注意事项：

- 必须先按 `tool-unity-pipeline-cli` 完成目标选择。
- 路径缺失、不唯一或与当前验证目标冲突时停止。

### I-002: Artifact Destination

描述：

- 当前 Verifier artifact root 下尚不存在的 `.log` 目标路径。

注意事项：

- 每次导出使用新的文件名，例如 `runtime-log-0001.log`。
- 不得覆盖已提交的日志副本，也不得把目标写入 Unity project。

## Command Rules

导出命令：

```text
unity --json --non-interactive command --project-path <project-path> --timeout <seconds> export_runtime_log output=<absolute-artifact-path>
```

命令结果必须提供：

```text
source_path
output_path
bytes
sha256
acquired_at
```

结果处理：

- `output_path` 必须等于调用方指定的 artifact 目标，并且文件真实存在。
- `sha256` 使用 `sha256:<hex>`，标识复制后文件的原始字节。
- `source_path` 只记录来源，不作为 Verifier 可持续读取源文件的假设。
- 对复制文件应用 `signal-unity-runtime-log` 的格式和行号规则；匹配结果不得写回原始副本。
- 命令输出、日志副本、后续解析记录和 observation result 是不同事实。

禁止使用以下内容代替导出命令：

- `console`
- `get_console_logs`
- `clear_console`
- `eval` 或 `eval_file` 调用 `DumpRecords()`
- Unity `Editor.log`
- 对筛选结果、JSON response 或内存记录重新拼接出的 `.log`

## Output Layout

一次成功操作产生一份不可变原始日志副本，并记录：

```text
acquisition_ref: signal-unity-runtime-log-unity-pipeline-cli
signal_ref: signal-unity-runtime-log
project_path: <当前已确认 Unity project>
source_path: <命令返回的源日志位置>
copied_log_ref: <Verifier artifact 中的原始副本>
digest: sha256:<hex>
bytes: <复制文件字节数>
acquired_at: <命令完成时间>
command: <实际命令及参数>
limitations: <none 或本次操作限制>
```

原始日志副本和上述操作记录共同构成采集结果。具体命中记录继续使用复制文件中的 `line_start` 和 `line_end`。

### Artifact Relationship Rules

- `copied_log_ref` 必须指向本次命令创建的完整原始文件副本。
- `digest` 只标识该副本的原始字节，不证明日志覆盖了目标行为的全部时间窗口。
- Verification evidence 通过 `copied_log_ref`、`digest` 和行号引用具体记录。
- 派生 Signal 必须沿用同一复制文件上下文和原始行号，不能创建独立来源。

## Failure Rules (Enforcement)

- FR-001：`tool-unity-pipeline-cli` 判定调用失败、命令返回空路径、目标文件不存在、字节数不符或 digest 无效时，本次操作失败。
- FR-002：操作失败、文件为空或来源不明确时，不得形成 Signal observation 或否定结论。
- FR-003：命令只返回 Console、内存记录或重新序列化内容时，必须判定为不符合原始日志导出 contract。

## Blocking Rules (Enforcement)

- BR-001：缺少 `tool-unity-pipeline-cli`、`export_runtime_log`、明确 project path、artifact destination 或源日志文件时停止。
- BR-002：无法证明目标文件是源日志的原样副本时停止受影响 verification point。

## Retry Rules (Enforcement)

- RR-001：`tool-unity-pipeline-cli` 将调用判定为可重试，或目标文件尚未生成时，最多重试一次并记录首次失败。
- RR-002：重试使用新的、尚不存在的 artifact 目标；不得覆盖或修补失败操作留下的文件。
- RR-003：重试不得改变 project、日志来源或观察范围来制造成功。

## Prohibited Rules (Enforcement)

- PR-001：禁止清空 Console、源日志或任何其它 Agent 正在使用的运行状态。
- PR-002：禁止过滤、摘要、脱敏、重排或重新序列化原始日志副本。
- PR-003：禁止把命令成功、文件存在或没有匹配记录直接解释为 verification point 通过或失败。
- PR-004：禁止在来源文件复制失败时回退到 Console buffer、`DumpRecords()`、`Editor.log` 或模型生成内容。

## Checklist

- project path 和 artifact destination 来自当前已确认输入。
- `tool-unity-pipeline-cli` 已唯一确认当前 project，且 `export_runtime_log` 已由当前 project 注册。
- 原始日志副本存在于 Verifier artifact root，且没有覆盖旧文件。
- source path、copied ref、bytes、digest、命令参数和采集时间均已记录。
- 原始副本没有经过筛选、摘要、脱敏、重排或重新序列化。
- 记录匹配使用 `signal-unity-runtime-log`，具体位置使用复制文件的物理行号。
- 失败、重试和覆盖限制没有被隐藏或解释为业务结果。
