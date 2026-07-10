---
assetKind: scout.skill
name: jarvis-codebase
description: Scout 使用 Jarvis codebase 管理 Guru 托管代码库路径、版本与 CodeGraph 索引，并用独立 codegraph CLI 收集源码语义证据。
id: skills.jarvis.codebase
version: 0.1.0
phase: [research, verify]
tags: [jarvis, codebase, codegraph, source, evidence]
devices: [any]
dependencies:
  shellTools:
    required: [scoutAssets, jarvis, codegraph]
    optional: [rg, sed, find, cat]
summary: 先用 jarvis codebase 解析托管代码库，再用 codegraph 和源码行号形成可追溯代码证据。
---
# Jarvis Codebase

当 Scout Agent 需要从 Guru 托管代码库定位当前版本源码语义、CodeGraph 符号、调用关系或代码行证据时使用本技能。

本技能的目标是把 Guru managed codebase 的路径、版本、索引状态、CodeGraph 查询和源码符号证据整理成可复查的 `E-CG-*` 与 `E-CODE-*` evidence。

## Core Use

使用本技能处理：

- 查询当前 mount 中是否可见 `scout-assets`、`jarvis` 和 `codegraph`。
- 查询 Jarvis 支持的 managed codebase 名称。
- 解析 Guru managed codebase 的本机 checkout 路径。
- 在明确版本要求下确认或切换 SDK version / branch。
- 确认 CodeGraph 索引状态。
- 使用独立 `codegraph` CLI 查询符号、文件、调用关系和影响面。
- 将 CodeGraph 结果与源码行号整理成弱 schema Markdown evidence artifact。

不使用本技能处理：

- 读取或整理 Guru knowledge、BDD Behavior、Domain 或 Capability 文档。
- 判断业务行为是否已经在 runtime 中触发。
- 生成 Verification Manual、ValidationResult 或最终 pass / fail 结论。
- 替代上游决定 research / verify / validate 的业务策略。
- 把 `rg` 当作 Guru managed codebase 的首选源码语义检索方式。
- 把本机绝对源码路径写入 canonical knowledge。

## Codebase Model

`jarvis codebase` 管理本机 Guru 托管代码库，路径语义为：

```text
~/.guru/codebase/<repo>
```

Jarvis codebase 负责：

- 查询支持的代码库名称。
- 解析本机 managed checkout 路径。
- 缺失代码库时 clone。
- 切换 SDK version / branch。
- 更新 git submodule。
- 在 clone 或切版本后刷新 CodeGraph 索引。

Jarvis codebase 不负责源码语义检索。没有 `jarvis codebase codegraph` 子命令。索引建好后，必须使用独立 `codegraph` CLI，并把 Jarvis 返回的 codebase path 作为 `codegraph -p` 的项目根。

支持仓库名必须来自实时命令输出：

```bash
jarvis codebase supported
```

该输出是唯一 repo 名称来源；不得依据非当前输出或示例 repo 推断当前可用。

## Command Side Effects

命令执行前必须先判断副作用类型。

只读查询命令：

- `scout-assets tools`：读取当前 mount 暴露的 shell tools。
- `jarvis codebase --help`：读取 Jarvis codebase 帮助。
- `jarvis codebase supported`：读取当前 Jarvis 支持的 managed codebase 名称。
- `codegraph status "<codebase-path>"`：读取 CodeGraph 索引状态。
- `codegraph query "<symbol-or-topic>" -p "<codebase-path>"`：读取 CodeGraph 查询结果。
- `codegraph query "<symbol-or-topic>" -p "<codebase-path>" -j`：读取 JSON 格式 CodeGraph 查询结果。
- `codegraph explore "<topic>" -p "<codebase-path>"`：读取 topic 相关候选文件和符号。
- `codegraph node "<symbol>" -p "<codebase-path>" -f "<relative-file>"`：读取单个符号节点详情。
- `codegraph callers "<symbol>" -p "<codebase-path>"`：读取上游调用关系。
- `codegraph callees "<symbol>" -p "<codebase-path>"`：读取被调用关系。
- `codegraph impact "<symbol>" -p "<codebase-path>"`：读取影响面关系。
- `codegraph files -p "<codebase-path>"`：读取索引文件列表。

有副作用命令：

- `jarvis codebase <repo> path`：checkout 缺失时可能 clone 代码库、更新 submodule 或刷新 CodeGraph。
- `jarvis codebase <repo> versions`：会 fetch 远端分支。
- `jarvis codebase <repo> latest`：会 checkout 最新 `sdk/*` 分支、更新 submodule、刷新 CodeGraph。
- `jarvis codebase <repo> <version>`：会 checkout `sdk/<version>`、更新 submodule、刷新 CodeGraph。

执行规则：

- 有副作用命令必须有明确 repo、版本目标或上游授权。
- 使用 `latest` 必须由上游明确授权。
- 执行有副作用命令后，必须记录命令、执行原因、预期副作用、输出摘要和新的 version / branch / commit。
- 命令副作用只能影响 Jarvis managed codebase 和对应 CodeGraph 索引；不得修改 Guru knowledge、Scout runtime state 或业务 artifact。

## Common CodeGraph Commands

常用 CodeGraph 命令：

```bash
codegraph status "<codebase-path>"
codegraph query "<symbol>" -p "<codebase-path>" -l 10
codegraph query "<symbol>" -p "<codebase-path>" -k method
codegraph query "<symbol>" -p "<codebase-path>" -j
codegraph explore "<topic>" -p "<codebase-path>" --max-files 5
codegraph node "<symbol>" -p "<codebase-path>" -f "<relative-file>"
codegraph callers "<symbol>" -p "<codebase-path>"
codegraph callees "<symbol>" -p "<codebase-path>"
codegraph impact "<symbol>" -p "<codebase-path>"
codegraph files -p "<codebase-path>"
```

用途：

- `status`：确认索引是否存在、是否可读、是否与当前 codebase path 匹配。
- `query`：按 symbol、API、type、method 或 topic 搜索候选节点。
- `query -j`：输出 JSON，便于整理 provenance 或 evidence artifact 字段。
- `explore`：从自然语言 topic 扩展候选文件和符号。
- `node`：读取指定文件中的符号详情，确认 signature、range 和关系。
- `callers`：定位调用当前 symbol 的入口。
- `callees`：定位当前 symbol 依赖的下游调用。
- `impact`：定位变更影响面或语义相邻节点。
- `files`：查看 CodeGraph 索引中的文件结构。

使用规则：

- 所有 CodeGraph 命令必须显式传入 `-p "<codebase-path>"`。
- `codebase-path` 必须来自当前 `jarvis codebase <repo> path` 输出。
- 自然语言 topic 查询只能作为探索入口，不能直接写成源码证据。
- CodeGraph 输出属于 Activity State；必须继续形成 `E-CG-*` artifact，并用源码行号形成 `E-CODE-*`。

## Inputs

### I-001: Mount Capability
---

描述：

- 当前 mount 可见 `scout-assets`、`jarvis` 和 `codegraph`。

注意事项：

- 使用 `scout-assets tools` 确认能力可见性。
- 缺少 required shell tool 时停止执行，并作为阻塞项向上游报告。

### I-002: Target Repository
---

描述：

- 目标 repo 名称，或足以唯一推断 repo 的产品 / SDK 线索。

注意事项：

- repo 必须出现在 `jarvis codebase supported` 的当前输出中。
- repo 无法唯一确定时，请求上游补充 repo。
- repo 未出现在 supported 输出中时，记录为阻塞项。
- 不得只依据非当前输出或示例 repo 继续执行。

### I-003: Target Version
---

描述：

- 目标 SDK version、branch 或 commit。

注意事项：

- version / branch / commit 缺失时，不主动切到 `latest`；记录为需人工确认项。
- 切换版本、使用 `latest` 或触发 fetch / checkout 前，必须有明确版本要求或上游明确授权。

### I-004: Source Query Target
---

描述：

- 要研究或验证的 symbol、class、method、namespace、file path、API、feature、capability 或自然语言 topic。
- 可以来自 BDD / research artifact 中提出的 implementation claim。
- 可以来自已有 CodeGraph query result、source ref 或调用关系线索。

注意事项：

- 自然语言 topic 只能作为 CodeGraph 探索入口，不能直接写成源码证据。
- implementation claim 必须继续收敛到具体 symbol、repo-relative file 和行号。

### I-005: Artifact Target
---

描述：

- 上游指定的 artifact 位置，或当前 role / task 的 artifact layout。

注意事项：

- 没有指定更具体位置时，按当前 role 产物目录写入；本技能不创建新的 canonical 目录约定。
- 可读路径不等于可写路径；写入前必须确认目标位置可写。

## Codebase Workflow

本节只列阶段顺序；命令副作用见 `Command Side Effects`，常用 CodeGraph 命令见 `Common CodeGraph Commands`，各阶段注意事项和证据要求见对应 Phase。

- Phase 1：确认 mount 能力和 Jarvis 当前支持的 managed codebase。
- Phase 2：解析目标 repo 的 managed codebase path。
- Phase 3：确认当前 version / branch / commit 和 CodeGraph 索引状态。
- Phase 4：用 CodeGraph 定位符号、文件、调用关系和影响面。
- Phase 5：读取必要源码片段，核对行号、signature 和 key lines。
- Phase 6：使用模板写入 `E-CG-*` 和 `E-CODE-*` evidence artifact。

## Evidence Output Layout

本技能不固定业务报告目录；上游或当前 role layout 决定 evidence artifact 的写入位置。

如果上游没有指定更具体位置，将 evidence artifact 写入当前 role 产物目录，并在返回结果中记录实际 artifact ref。

模板目录索引：

```text
templates/template-index.md
```

创建 evidence artifact 时使用本技能模板：

```text
templates/codegraph-evidence.md
templates/source-code-evidence.md
```

文件职责：

- `codegraph-evidence.md`：记录 `E-CG-*`，包括 repo、version / branch / commit、query command、matched symbol、matched file、relation 和 located symbols。
- `source-code-evidence.md`：记录 `E-CODE-*`，包括 repo、version / branch / commit、symbol name、type、file、start_line、end_line、signature、key lines、collection commands、supports 和 limitations。

### Artifact Relationship Rules

- Summary artifact：本技能不生成 summary aggregation；上游 Skill 负责把 `E-CG-*` / `E-CODE-*` 汇总到自己的 evidence pack。
- Detail artifact：`codegraph-evidence.md` 和 `source-code-evidence.md` 是单条 detail evidence artifact。
- Registry / index：`templates/template-index.md` 只做模板导航；本技能不生成 evidence registry。
- Claim owner：`source-code-evidence.md` 只定义 source symbol evidence claim；业务 implementation claim 由上游 evidence pack 或 verification manual 所属 Skill 定义。
- Downstream reference rule：下游只能通过 evidence id、artifact ref、repo-relative locator、symbol 和 line range 引用本技能产物。
- Ref field policy：当下游聚合 `E-CG-*` 或 `E-CODE-*` 时，必须记录实际 artifact ref；本技能返回或报告产物时也必须给出实际 artifact ref。

## Phase 1: Confirm Mount and Supported Codebase
---

本阶段确认当前 Agent 真的具备本技能依赖的 shell tools，并确认目标 repo 是否属于 Jarvis 当前支持的 managed codebase。

使用命令：

```bash
scout-assets tools
jarvis codebase supported
```

注意事项：

- `scout-assets tools` 用于确认当前 mount 暴露的 shell tool，而不是证明业务状态。
- `jarvis codebase supported` 的输出是当前 repo 名称判断依据。
- 不在 supported 输出中的 repo 不能继续按 managed codebase 处理，必须记录为阻塞项。

Exit：

- Required shell tools 可见，目标 repo 出现在 supported codebase 输出中。

Blocked：

- 缺少 `scoutAssets`、`jarvis`、`codegraph`，或目标 repo 不在 supported codebase 输出中。

Partial：

- 只能确认 mount 能力但无法确认目标 repo 时，记录支持列表和需人工确认项，不进入 Phase 2。

## Phase 2: Resolve Managed Codebase
---

本阶段解析目标 repo 的本机 managed checkout 路径。

使用命令：

```bash
jarvis codebase <repo> path
```

注意事项：

- 该命令在 checkout 缺失时可能 clone、更新 submodule 或刷新 CodeGraph。
- 解析出的 path 必须作为后续 `codegraph -p` 的项目根。
- provenance 必须记录 repo、codebase path、命令和输出摘要。

Exit：

- 已解析 managed checkout path，并记录命令 provenance。

Blocked：

- `jarvis codebase <repo> path` 失败、输出为空或 path 不可读时停止。

Partial：

- path 可解析但存在 checkout 刷新、索引刷新或其它副作用提示时，记录 limitation，并在版本确认前保持部分完成。

## Phase 3: Confirm Version and Index State
---

本阶段确认当前版本、branch、commit 和 CodeGraph 索引状态。

只读状态命令：

```bash
codegraph status "<codebase-path>"
```

副作用命令：

```bash
jarvis codebase <repo> versions
jarvis codebase <repo> latest
jarvis codebase <repo> <version>
```

注意事项：

- 只有任务明确要求某个版本，或上游明确授权使用 `latest` 时，才能切换版本。
- 命令副作用和授权要求以 `Command Side Effects` 为准。
- version / branch / commit 不明确时，记录为需人工确认项，不主动猜测。
- `codegraph status` 失败或索引不可用时，记录为阻塞项，并保留失败命令和输出摘要。

Exit：

- 当前 version / branch / commit 和 CodeGraph index state 已确认，或上游授权的版本切换已完成并记录。

Blocked：

- 当前任务需要 current version evidence，但版本不可确定、切换未授权、CodeGraph 索引不可用或状态命令失败。

Partial：

- 只能确认 checkout path 但缺少明确版本时，记录需人工确认项，不进入 CodeGraph 查询。

## Phase 4: Query CodeGraph
---

本阶段用 CodeGraph 定位源码语义候选、符号、文件和关系。

常用查询：

```bash
codegraph query "<symbol>" -p "<codebase-path>" -l 10
codegraph query "<symbol>" -p "<codebase-path>" -k method
codegraph query "<symbol>" -p "<codebase-path>" -j
codegraph explore "<topic>" -p "<codebase-path>" --max-files 5
codegraph node "<symbol>" -p "<codebase-path>" -f "<relative-file>"
codegraph callers "<symbol>" -p "<codebase-path>"
codegraph callees "<symbol>" -p "<codebase-path>"
codegraph impact "<symbol>" -p "<codebase-path>"
codegraph files -p "<codebase-path>"
```

注意事项：

- 命令用途和使用规则以 `Common CodeGraph Commands` 为准。
- CodeGraph evidence 只能定位 candidate source semantics。
- `E-CG-*` 不能单独支撑 current version implementation claim；必须继续形成 `E-CODE-*`。
- 所有查询命令、query、options、matched symbol、matched file 和 relation 必须进入 evidence artifact 或 provenance。

Exit：

- CodeGraph 已定位候选 symbol、file、relation 或 located symbols，并可映射到源码核验目标。

Blocked：

- CodeGraph 查询失败、无候选、候选不可映射源码文件或结果无法形成 `E-CG-*`。

Partial：

- 只有弱候选或多候选时，可以写 `E-CG-*` limitation，但不得直接进入完成状态。

## Phase 5: Collect Source Code Evidence
---

本阶段在 CodeGraph 已定位的文件和符号基础上读取源码，核对当前版本实现证据。

记录要求：

- repo。
- version / branch / commit。
- repo-relative file path。
- symbol name。
- symbol type。
- start_line / end_line。
- signature。
- key lines。
- reason。
- collection commands。
- limitations。

注意事项：

- 只有 CodeGraph 已定位到具体文件、符号或调用关系后，才直接读取源码片段做核验。
- 源码证据必须使用 repo 相对路径和当前版本行号。
- `E-CODE-*` 只能证明当前版本存在该实现，不能证明运行时一定触发。

Exit：

- 已核对源码 symbol、repo-relative file、start_line / end_line、signature 和 key lines。

Blocked：

- 源码文件不可读、symbol 无法定位、行号无法确认或 key lines 无法支撑 source evidence claim。

Partial：

- CodeGraph 候选存在但源码行证据不足时，只保留 `E-CG-*` 和 limitation，不生成完成状态的 `E-CODE-*`。

## Phase 6: Write Code Evidence Artifacts
---

本阶段把 CodeGraph 结果和源码符号证据写成弱 schema Markdown artifact。

使用模板：

```text
templates/codegraph-evidence.md
templates/source-code-evidence.md
```

注意事项：

- `E-CG-*` 使用 `templates/codegraph-evidence.md`。
- `E-CODE-*` 使用 `templates/source-code-evidence.md`。
- `supports` 应引用上游提供的 verification point、claim id 或 evidence registry 项。
- 模板中的空字段必须用实际来源、命令、locator 或明确 limitation 填充。
- 不把命令输出原文当作业务结论；必须整理成 evidence claim、locator、supports 和 limitations。

Exit：

- `E-CG-*` / `E-CODE-*` artifact 已按模板写入或返回，且实际 artifact ref 已记录。

Blocked：

- artifact target 不可写、模板缺失、必填 locator 缺失或 evidence id 重复时停止。

Partial：

- 只写出 `E-CG-*` 或候选 evidence 时，必须记录 limitation 和缺少 `E-CODE-*` 的原因。

## Workflow Exit Rules (Enforcement)

- XR-001：Phase 1 只有在 required shell tools 可见且目标 repo 能用当前 `jarvis codebase supported` 输出判断时，才能进入 Phase 2。
- XR-002：Phase 2 只有在 managed codebase path 已解析并记录 provenance 后，才能进入 Phase 3。
- XR-003：Phase 3 只有在 version / branch / commit 和 CodeGraph status 已记录，或缺口已标记为需人工确认项或阻塞项后，才能进入 Phase 4。
- XR-004：Phase 4 只有在 CodeGraph 查询结果已整理为 `E-CG-*` 候选，且未把候选当作实现事实时，才能进入 Phase 5。
- XR-005：Phase 5 只有在源码符号、repo-relative file、start_line / end_line、signature 和 key lines 已核对后，才能进入 Phase 6。
- XR-006：Phase 6 只有在 `E-CG-*` 和 `E-CODE-*` artifact ref、failed_commands、retry_log 和 limitations 已按需记录后，才能宣称本技能输出完成。

## Evidence Rules (Enforcement)

- ER-001：Guru managed codebase 的源码语义检索优先使用 CodeGraph。
- ER-002：`jarvis codebase` 只负责 codebase 管理、路径解析、版本切换和索引刷新；源码语义检索必须使用独立 `codegraph` CLI。
- ER-003：禁止把 `rg` 作为 Guru managed codebase 的首选源码语义检索方式。
- ER-004：CodeGraph 查询、状态输出和工具命令属于 Activity State；只有整理进 evidence artifact 并带 locator 后，才能支撑 source claim。
- ER-005：`rg-fallback` 产物必须标记为低置信度来源，并记录 CodeGraph 失败原因、检索命令和范围。
- ER-006：代码证据必须记录 repo、version / branch / commit、repo-relative file、symbol、start_line、end_line、signature、key lines 和 collection commands。
- ER-007：本机绝对路径只能作为本次 Scout runtime artifact provenance，不能作为 canonical source locator。
- ER-008：`E-CG-*` 只能说明候选语义定位；implementation claim 必须有 `E-CODE-*` 支撑。
- ER-009：`E-CODE-*` 只能说明当前版本源码存在该实现；behavior observed claim 必须等待 runtime / log / UI / test / device evidence。
- ER-010：有副作用命令必须记录执行原因、授权来源、预期副作用和执行后的 version / branch / commit。

## Failure Rules (Enforcement)

- FR-001：`scout-assets tools`、`jarvis codebase supported`、`jarvis codebase <repo> path` 或 `codegraph status` 失败、空输出、权限失败或解析失败时，必须记录 failed_commands、输出摘要和影响阶段。
- FR-002：CodeGraph 无命中、多命中、索引不可读或 node/range 不可定位时，不得生成 source-verified claim；只能记录为 `E-CG-*` limitation 或阻塞项。
- FR-003：源码文件不可读、行号不稳定、signature 无法确认或 key lines 无法解释时，不得生成 `E-CODE-*`。
- FR-004：evidence artifact 写入失败或模板字段无法填充时，不得宣称本技能完成；必须向上游报告 artifact target 和失败原因。

## Blocking Rules (Enforcement)

- BR-001：缺少 `scoutAssets`、`jarvis` 或 `codegraph` required shell tool 时必须停止。
- BR-002：目标 repo 不在当前 `jarvis codebase supported` 输出中，或 repo 无法唯一确定时必须停止。
- BR-003：需要切换版本、使用 `latest`、fetch 或 checkout 但缺少明确版本要求或上游授权时必须停止。
- BR-004：CodeGraph 不可用且未获得低置信度文本回退授权时，不能继续补齐源码语义证据。
- BR-005：artifact target 不可写时，不能进入 Phase 6 的完成状态。

## Retry Rules (Enforcement)

- RR-001：只读命令出现瞬时失败时最多重试一次，并记录 retry_log、前后命令、错误摘要和结果差异。
- RR-002：`jarvis codebase <repo> path`、`versions`、`latest` 或 `<version>` 等有副作用命令不得自动重试；重试前必须有明确任务要求或上游授权。
- RR-003：重试不得改变 repo、version、query topic、symbol 或 evidence scope 来制造成功。
- RR-004：重试后仍失败时，必须固定为阻塞项或 limitation，不得静默改用 `rg`。

## Prohibited Rules (Enforcement)

- PR-001：禁止修改 Guru knowledge、代码库源码、synaptic 或 Scout runtime state。
- PR-002：禁止创建或变更 Runtime 事件、attachment payload、profile、mount 或 MCP server。
- PR-003：禁止根据非当前 `jarvis codebase supported` 输出直接断言当前 repo 可用。
- PR-004：禁止在缺少 version / branch / commit 时主动选择 `latest`。
- PR-005：禁止在没有上游明确授权时执行 `jarvis codebase <repo> versions`、`latest` 或 `<version>`。
- PR-006：禁止在 CodeGraph 不可用、索引打不开或命令失败时静默改用文本搜索补齐语义证据。
- PR-007：禁止在没有上游明确授权低置信度文本回退时使用 `rg-fallback`。
- PR-008：禁止把 CodeGraph 命中当作运行时行为证明。
- PR-009：禁止把源码存在当作 BDD 已通过。
- PR-010：禁止把权限失败、空输出、命令错误或索引异常当作无证据成功。

## Example

输入：

```text
repo: gurusdk-unity
version: sdk/7.12.6
topic: anonymous login fallback implementation
supports: VP-001 from verification-manual.md
```

流程：

1. 执行 `scout-assets tools`，确认 `jarvis` 和 `codegraph` 可见。
2. 执行 `jarvis codebase supported`，确认 `gurusdk-unity` 当前受支持。
3. 执行 `jarvis codebase gurusdk-unity path`，取得 codebase path。
4. 执行 `codegraph status "<codebase-path>"`，确认索引状态。
5. 用 `codegraph query` / `explore` / `node` 定位相关 symbol 和 repo-relative file。
6. 读取定位文件的必要行，记录 start_line、end_line、signature 和 key lines。
7. 使用模板写入 `E-CG-*` 和 `E-CODE-*` evidence artifact。

输出：

- `codegraph-evidence.md`：记录 CodeGraph query、matched symbol、matched file、relation 和 limitations。
- `source-code-evidence.md`：记录当前版本源码符号、行号、key lines、collection commands 和 supports。
