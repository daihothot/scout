---
assetKind: scout.skill
name: internal-boundary-inspector
description: 查询当前 Scout Agent 的 mount 资产边界、工作边界、能力入口和 run 级共享记忆摘要，并整理为 Boundary Snapshot。
id: internal-boundary-inspector
version: 0.1.3
phase: [coordinate, research, verify, validate]
family: [internal, boundary-inspector]
tags: [scout, asset, boundary, memory, audit, workflow]
devices: [any]
dependencies:
  shellTools:
    required: [scoutAssets, scoutMemory, pwd]
    optional: [ls, cat, sed, rg]
summary: 用 scout-assets 与 scout-memory 查询当前 Agent 可见边界，并整理为中立的 Boundary Snapshot。
---

# Internal Boundary Inspector

当需要查询当前 Agent 自己的 mount 资产边界、工作边界、能力入口或 run 级共享记忆摘要时使用本技能。

本技能提供一套稳定查询流程，把当前 mount 中可见的资产、能力、路径和共享记忆摘要整理成中立的 Boundary Snapshot。

## Skill Type

- type: internal
- structure_level: compact
- note: 本技能属于 Internal Skill，拥有 Scout 内部边界查询与中立快照整理责任。

## Core Use

使用本技能查询：

- 当前 mount 的 manifest 总览和完整内容。
- 当前 mount 暴露的 skills、shell tools、MCP servers 和 plugins。
- 当前 run 级共享记忆摘要。
- 当前 mount root、readable roots、writable roots、artifact 写入线索和 replay 线索。

不使用本技能处理：

- 业务 artifact 正文解释。
- BDD 验证、源码验证、artifact gate 或最终 synthesis。
- profile、mount manifest、Codex config、memory sqlite 或其它持久状态修改。
- task 是否可继续、是否通过或是否完成的判断。

## Boundary Model

Boundary Snapshot 是当前 Agent 可见边界的中立整理结果。

模型规则：

- `scout-assets` 是当前 mount 资产、能力和 manifest 查询入口。
- `scout-memory` 是当前 run 级共享记忆可见性和摘要查询入口。
- `mount-manifest.json` 证明当前 mount 资产和能力快照，不替代业务 artifact、BDD evidence 或人工确认。
- `scout-memory` 输出只能证明 memory 存储可见或文件摘要存在，不自动证明业务状态或记忆内容正确。
- 动态能力、路径、MCP server、plugin 和 shell tool 可见性必须以当前 mount 查询或当前工具输出为准。

## Inputs

### I-001: Mount Root
---

描述：

- 当前工作目录应为当前 Agent 的 mount root。
- `scout-assets` 从当前工作目录读取 `mount-manifest.json`。

注意事项：

- 不能把其它 Agent、其它 run 或外部路径当作当前 mount root。
- 当前目录无法确认时，记录为阻塞项。

### I-002: Capability Query Scope
---

描述：

- 上游要求查询的能力范围，例如 skills、tools、mcp、plugins 或 raw manifest。

注意事项：

- 未指定聚焦项时，查询完整能力总览。
- 能力可见性必须来自 `scout-assets` 输出或 manifest 字段。

### I-003: Memory Query Scope
---

描述：

- 上游要求查询 run 级共享记忆摘要，或需要确认 memory 可见性。

注意事项：

- `scout-memory` 从当前工作目录或 `SCOUT_RUN_ROOT` 定位 run 级 Codex home。
- memory 查询结果只进入 Boundary Snapshot，不作为业务验证证据。

### I-004: Local Inspection Scope
---

描述：

- 上游要求只读查看当前 mount 文件结构、规则文件或 manifest 字段。

注意事项：

- 只能使用当前 mount 暴露的只读 shell tool，例如 `pwd`、`ls`、`rg`、`sed`、`cat`。
- 可读不等于可写；本技能不修改任何文件。

### I-005: Snapshot Target
---

描述：

- 上游指定的 Boundary Snapshot 输出位置，或当前 role / task 的 artifact layout。

注意事项：

- 没有指定更具体位置时，按当前 role 产物目录写入；本技能不创建新的 canonical 目录约定。
- 写入前必须确认目标位置可写。

## Boundary Query Workflow

本节只列阶段顺序；具体命令、注意事项和字段来源见各 Phase。

- Phase 1：定位当前 mount 边界。
- Phase 2：查询 mounted capabilities。
- Phase 3：查询 run 级 Codex state / shared memory。
- Phase 4：按需执行当前 mount 内只读检查。

## Boundary Snapshot Output Layout

产物位置由上游、当前 role layout 或当前 task artifact layout 决定。

Boundary Snapshot 使用 Markdown 模板：

```text
templates/boundary-snapshot.md
```

文件职责：

- `boundary-snapshot.md`：记录当前 mount、profile、files、roots、shared memory、replay fields、field sources 和 limitations。
- 字段值来自当前 `scout-assets`、`scout-memory` 和当前 mount 内只读检查结果。

注意事项：

- Boundary Snapshot 只整理查询结果，不写业务判断、gate 结论或验证结果。
- 无法从查询结果直接定位的字段保持空项或记录 limitation。
- 工具输出属于 Activity State；需要整理成字段来源后再写入 snapshot。

### Artifact Relationship Rules

- Summary artifact：`boundary-snapshot.md` 是单一 Boundary Snapshot，同时承担查询摘要和字段来源说明。
- Detail artifact：本技能不要求单条 detail artifact；必要细节写入 `Field Sources` 和 `Limitations`。
- Registry / index：本技能不生成 registry；`boundary-snapshot.md` 不定义业务 claim。
- Claim owner：本技能不拥有业务 claim，只记录当前 mount、profile、memory 和文件边界的查询字段。
- Downstream reference rule：下游可以引用 snapshot path、字段名和 field source；snapshot 字段不替代业务 evidence id。
- Ref field policy：默认不使用 `artifact_ref` 或 `detail_ref`；若上游需要引用本 snapshot，使用 snapshot 文件路径作为 artifact ref。

## Phase 1: Locate Current Boundary
---

本阶段确认当前目录和当前 mount 总览。

使用命令：

```bash
pwd
scout-assets list
```

提取字段：

- `cwd`
- `agentId`
- `mountId`
- `assetCommitId`
- `agentProfile`
- `generatedAt`
- `resourceHash`

注意事项：

- `cwd` 来自 `pwd`。
- `agentId`、`mountId`、`assetCommitId`、`generatedAt`、`resourceHash` 来自 `scout-assets list` 或 `scout-assets raw`。
- `pwd` 不可用或当前目录无法确认时，记录为阻塞项。

Exit：

- 当前 cwd 和 mount identity 字段已记录，或缺口已写入 limitation。

Blocked：

- `pwd` 不可用、`scout-assets list` 不可用或无法确认当前 mount identity。

Partial：

- 只确认 cwd 但 mount identity 不完整时，可以继续查询能力，但必须记录缺口。

## Phase 2: Query Mounted Capabilities
---

本阶段查询完整 manifest 和当前 mount 暴露的能力入口。

使用命令：

```bash
scout-assets raw
scout-assets skills
scout-assets tools
scout-assets mcp
scout-assets plugins
```

提取字段：

- `assets`
- `linkedFiles`
- `generatedFiles`
- `writableRoots`
- `skills`
- `shellTools`
- `mcpServers`
- `plugins`

注意事项：

- `writable roots`、`assets`、`linkedFiles`、`generatedFiles` 来自 `scout-assets raw`。
- `skills` 来自 `scout-assets skills` 或 manifest 的 `skills` 字段。
- `shell tools` 来自 `scout-assets tools` 或 manifest 的 `shellTools` 字段。
- `MCP servers` 来自 `scout-assets mcp` 或 manifest 的 `mcpServers` 字段。
- `plugins` 来自 `scout-assets plugins` 或 manifest 的 `plugins` 字段。

Exit：

- skills、shell tools、MCP servers、plugins 和 root 字段已从 manifest 或分项命令整理到 snapshot。

Blocked：

- `scout-assets raw` 和分项查询都不可用，导致无法形成 capability boundary。

Partial：

- 某一类能力查询失败时，保留其它类别结果，并在 limitation 中记录失败命令。

## Phase 3: Query Run-level Codex State
---

本阶段查询 run 级共享记忆摘要。

使用命令：

```bash
scout-memory list
```

提取字段：

- `runRoot`
- `codexHome`
- `exists`
- `readable`
- `files`

注意事项：

- `runRoot`、`codexHome`、`exists`、`readable`、`files` 来自 `scout-memory list`。
- memory 可见性不能替代业务 artifact、task outcome、人工确认或验证证据。
- `scout-memory` 不可用时，记录为阻塞项或 limitation。

Exit：

- run-level memory fields 已记录，或不可见原因已写入 limitation。

Blocked：

- 当前任务明确要求 memory boundary，但 `scout-memory` 不可用或输出不可解析。

Partial：

- memory 不是当前查询重点时，`scout-memory` 失败可作为 limitation，不阻断其它 boundary 字段整理。

## Phase 4: Optional Local Inspection
---

本阶段在当前 mount 暴露了对应只读 shell tool 时，按需查看当前 mount 文件结构、规则或字段。

只读命令：

```bash
ls
rg "<pattern>" .
sed -n '1,120p' <path>
cat <path>
```

注意事项：

- 只读检查必须限制在当前 mount 和当前可读范围内。
- 只能读取当前 task 需要的规则、manifest 或字段。
- 不得修改 profile、mount manifest、Codex config、memory sqlite 或其它持久状态。
- 整理 Boundary Snapshot 时使用 `templates/boundary-snapshot.md`。

Exit：

- 可选本地检查结果已整理为字段来源或 limitation。

Blocked：

- 必需的本地文件字段不可读，且无法通过 `scout-assets` 或 `scout-memory` 补足。

Partial：

- 本地检查不是必需输入时，跳过或失败只记录 limitation。

## Workflow Exit Rules (Enforcement)

- XR-001：Boundary Snapshot 不得跳过当前 mount、capability、memory 和 field source 的来源记录。
- XR-002：任何无法定位来源的字段必须保持空项或写入 limitation，不得猜测补齐。
- XR-003：只读本地检查不得越过当前 mount、当前可读范围或当前可见能力。
- XR-004：Boundary Snapshot 必须记录 field sources、blocking_items、failed_commands、retry_log 和 limitations 后才能宣称完成。
- XR-005：Boundary Snapshot 只能作为边界快照交付，不得替代 BDD evidence、task outcome、artifact gate 或业务验证结果。

## Evidence Rules (Enforcement)

- ER-001：Boundary Snapshot 只能引用 `scout-assets`、`scout-memory` 和当前 mount 内只读检查结果。
- ER-002：`mount-manifest.json` 只能证明当前 mount 的资产和能力快照。
- ER-003：`scout-memory` 输出只能证明 memory 可见性或文件摘要存在。
- ER-004：工具输出属于 Activity State；只有整理成 Boundary Snapshot 字段和 field source 后，才能作为边界说明。
- ER-005：Boundary Snapshot 不是 BDD evidence、artifact gate、task outcome 或业务验证结果。

## Failure Rules (Enforcement)

- FR-001：`pwd`、`scout-assets list/raw/skills/tools/mcp/plugins` 或 `scout-memory list` 失败、空输出、权限失败或解析失败时，必须记录 failed_commands、输出摘要和影响字段。
- FR-002：manifest 字段缺失、字段含义不确定或查询结果互相冲突时，不得猜测补齐；必须记录 limitation。
- FR-003：只读本地检查无法读取目标文件、命令不可见或路径越界时，必须记录 failed_commands 或 limitation，不得绕过 mount 边界。
- FR-004：Snapshot target 不可写或模板不可用时，不得宣称 Boundary Snapshot 已完成。

## Blocking Rules (Enforcement)

- BR-001：缺少 `scoutAssets` required shell tool 时必须停止。
- BR-002：缺少 `scoutMemory` 且上游要求 shared memory 摘要时必须记录阻塞项或 limitation。
- BR-003：当前 cwd 无法确认为当前 mount root 时必须停止。
- BR-004：查询目标要求读取其它 Agent、其它 run 或外部路径作为当前 Boundary Snapshot 来源时必须停止。
- BR-005：Snapshot target 不可写时不能进入完成状态。

## Retry Rules (Enforcement)

- RR-001：只读查询命令出现瞬时失败时最多重试一次，并记录 retry_log。
- RR-002：重试不得切换到其它 mount root、其它 run、其它 Agent 目录或外部 memory 存储。
- RR-003：重试后仍失败时，必须保持字段为空并记录 limitation、failed_commands 或阻塞项。

## Prohibited Rules (Enforcement)

- PR-001：禁止修改 profile、mount manifest、Codex config、memory sqlite 或其它持久状态。
- PR-002：禁止绕过 `scout-assets` 查询当前 mount 资产和能力边界。
- PR-003：禁止绕过 `scout-memory` 直接读取或解释 run 级 memory 存储。
- PR-004：禁止读取或写入其它 Agent、其它 run 或外部路径作为当前 Boundary Snapshot 来源。
- PR-005：禁止把 Boundary Snapshot 当作 task 是否可继续、是否通过或是否完成的判断。
- PR-006：禁止把 memory 摘要、manifest 字段或工具活动记录写成业务事实。

## Example

输入：

```text
查询当前 Agent 的资产边界和共享记忆。
```

流程：

1. 执行 `pwd` 和 `scout-assets list` 定位当前 mount。
2. 执行 `scout-assets raw` 和按类型能力查询。
3. 执行 `scout-memory list` 查询共享记忆摘要。
4. 整理为中立 Boundary Snapshot。

输出：

- 使用 `templates/boundary-snapshot.md` 生成 Boundary Snapshot。
- 输出中记录 `cwd`、`agentId`、`mountId`、`assetCommitId`、`codexHome`、shared memory files 和字段来源。
