---
assetKind: scout.skill
name: tool-jarvis-codebase
description: Scout 使用 Jarvis codebase 管理 Guru 托管代码库路径、版本与 CodeGraph 索引，并用独立 codegraph CLI 收集源码语义证据。
id: tool-jarvis-codebase
version: 0.5.2
phase: [research, verify, validate]
family: [tool, jarvis]
tags: [jarvis, codebase, codegraph, source, evidence]
devices: [any]
dependencies:
  shellTools:
    required: [scoutAssets, jarvis, codegraph, git]
    optional: [rg, sed, find, cat]
summary: 先用 jarvis codebase 解析托管代码库，再用 codegraph 和源码行号形成可追溯代码证据。
---
# Tool Jarvis Codebase

当 Scout Agent 需要从 Guru 托管代码库定位当前版本源码语义、CodeGraph 符号、调用关系或代码行证据时使用本技能。

本技能的目标是使用 Guru managed codebase、CodeGraph 查询和源码核验形成可复查的 `E-CODE-*` evidence。

## Skill Type

- type: tool
- structure_level: full
- note: 本技能拥有 managed codebase、CodeGraph 与源码证据的操作 contract，不拥有上游业务 implementation claim。

## Core Use

使用本技能处理：

- 查询当前 mount 中是否可见 `scout-assets`、`jarvis` 和 `codegraph`。
- 查询 Jarvis 支持的 managed codebase 名称。
- 解析 Guru managed codebase 的本机 checkout 路径。
- 在明确版本要求下确认或切换 SDK version / branch。
- 确认 CodeGraph 索引状态。
- 使用独立 `codegraph` CLI 查询符号、文件、调用关系和影响面。
- 将 CodeGraph 查询过程记录为采集 provenance，并把源码符号、行号和关键行整理成弱 schema Markdown evidence artifact。

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

代码证据必须区分两层仓库身份：

- `root repository`：`jarvis codebase <repo> path` 返回的 managed checkout 所属 Git 仓库。
- `source repository`：实际拥有目标源码文件的 Git 仓库。
- 目标源码位于 root repository 时，两层身份相同，`gitlink_path` 和 `gitlink_commit` 写 `none`。
- 目标源码位于 submodule 或嵌套 Git 仓库时，必须记录 root commit、source commit、root 中的 gitlink path / commit，以及两者是否对齐。
- canonical source locator 使用 `source_commit + source_relative_file`；root commit 只用于重建 managed checkout 与嵌套仓库关系。
- 本地 `root_codebase_path` / `source_codebase_path` 只作为本次 Scout runtime provenance，不能替代 canonical locator。

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
- `git -C "<codebase-path>" rev-parse --show-toplevel`：确认 root repository。
- `git -C "<source-directory>" rev-parse --show-toplevel`：确认目标文件所属 source repository。
- `git -C "<repo-path>" branch --show-current`：读取 branch；空输出时记录 `detached`。
- `git -C "<repo-path>" rev-parse HEAD`：读取 commit。
- `git -C "<repo-path>" status --short`：读取 working tree state。
- `git -C "<source-codebase-path>" status --short -- "<source-relative-file>"`：确认目标源码文件是否可由 source commit 重放。
- `git -C "<root-codebase-path>" ls-tree "<root-commit>" "<gitlink-path>"`：读取 parent commit 中的 gitlink commit。

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
- CodeGraph 输出属于 Activity State，只能作为源码定位和采集 provenance；代码事实必须用源码行号形成 `E-CODE-*`。
- CodeGraph 的项目根可以是 root repository；证据中的 source repository 仍必须按目标文件实际所属 Git root 单独解析。

## Native Subagent Strategy

- 本技能明确授权父 Agent 在预计能够提高当前代码研究效率时自主决定是否使用 Codex native subagent；是否派发、派发数量以及并行或串行方式由父 Agent 判断，不构成 Phase 的必需步骤。
- Phase 1 至 Phase 3 由父 Agent 串行完成，用于锁定唯一 repo、managed codebase path、目标版本、root/source repository identity、working tree 和 CodeGraph index 状态。
- `jarvis codebase <repo> path` 在 checkout 缺失时可能产生 clone、submodule 更新和索引刷新；`latest`、版本切换及任何索引准备都不得由多个 child 并发执行。
- 只有存在边界稳定、互不依赖的 Source Query Target，并且预期节省的时间高于启动、等待和聚合成本时才派发。上游 Research Skill 已将代码范围委派给专用 Code child 时，该 child 独占 Phase 4 至 Phase 5 的全部 Source Query Target，不再按 target 派发嵌套 child；互不依赖的只读命令可以在该 child 内并行执行。
- Code child 必须使用父 Agent 已锁定的同一个 codebase path 和版本，不得 checkout、切 branch、更新 submodule、刷新索引、修改源码或写正式 evidence artifact。
- Code child 只按 `Source Refs`、`Source Query Targets`、`Source Locators`、`Commands`、`Failed Commands`、`Limitations` 六段返回不超过 4000 个中文字符的代码研究结果；不复制源码正文，`Source Locators` 按 Target 只记录 CodeGraph candidates、source repository identity、primary symbol、source-relative file、line range、signature 和必要 key lines。
- Phase 6 由父 Agent 分配 evidence id、解决候选冲突、抽查关键 source locator，并为每个唯一 primary symbol 写入正式 `E-CODE-*`；父 Agent 不重复执行 child 已完成的完整代码扫描。
- 父 Agent 决定不派发时直接自行执行 Phase 4 至 Phase 5，不需要记录 fallback 原因；派发失败或结果不可用时，可以在停止或释放对应 child 后收回该范围，不得与仍在执行的 child 重复查询。

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
- implementation claim 必须继续收敛到具体 primary symbol、source-relative file 和行号。

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
- Phase 3：确认 root repository identity、version / branch / commit、working tree 和 CodeGraph 索引状态。
- Phase 4：用 CodeGraph 定位符号、文件、调用关系和影响面，并解析目标文件所属 source repository。
- Phase 5：读取必要源码片段，核对 source symbol、行号、signature 和 key lines。
- Phase 6：使用模板写入 `E-CODE-*` evidence artifact。

## Evidence Output Layout

本技能不固定业务报告目录；上游或当前 role layout 决定 evidence artifact 的写入位置。

如果上游没有指定更具体位置，将 evidence artifact 写入当前 role 产物目录，并在返回结果中记录实际 artifact ref。

模板目录索引：

```text
templates/template-index.md
```

创建 evidence artifact 时使用本技能模板：

```text
templates/source-code-evidence.md
```

模板中未注明 `Nice to Have，可不填写` 的事实字段必须使用当前 repository、CodeGraph 或源码证据取得的确切信息；无法确认时记录需人工确认项或阻塞项。明确可不填写的字段缺失不阻塞 evidence 形成。结构字段按中文填写说明由 workflow 生成或由 contract 校验。所有 `<填写...>` 说明必须在提交 evidence artifact 前替换。

文件职责：

- `source-code-evidence.md`：记录 `E-CODE-*`，包括 root / source repository provenance、gitlink、唯一 primary symbol、source-relative file、line range、signature、key lines、CodeGraph 查询与源码采集命令、supports 和 limitations。

### Artifact Relationship Rules

- Summary artifact：本技能不生成 summary aggregation；上游 Skill 负责把 `E-CODE-*` 汇总到自己的 evidence pack。
- Detail artifact：`source-code-evidence.md` 是单条 detail evidence artifact。
- Registry / index：`templates/template-index.md` 只做模板导航；本技能不生成 evidence registry。
- Claim owner：`source-code-evidence.md` 只定义 source symbol evidence claim；业务 implementation claim 只能由上游 `code-evidence.md` 定义。
- Downstream reference rule：下游只能通过 evidence id、artifact ref、`source_commit + source_relative_file`、primary symbol 和 line range 引用本技能产物。
- Ref field policy：当下游聚合 `E-CODE-*` 时，必须记录实际 artifact ref；本技能返回或报告产物时也必须给出实际 artifact ref。

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

- 缺少 `scoutAssets`、`jarvis`、`codegraph`、`git`，或目标 repo 不在 supported codebase 输出中。

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
- 使用 `git -C "<codebase-path>" rev-parse --show-toplevel` 确认 root repository；provenance 必须记录 root repo、root codebase path、命令和输出摘要。

Exit：

- 已解析 managed checkout path，并记录命令 provenance。

Blocked：

- `jarvis codebase <repo> path` 失败、输出为空或 path 不可读时停止。

Partial：

- path 可解析但存在 checkout 刷新、索引刷新或其它副作用提示时，记录 limitation，并在版本确认前保持部分完成。

## Phase 3: Confirm Version and Index State
---

本阶段确认 root repository 的版本、branch、commit、working tree 和 CodeGraph 索引状态。

只读状态命令：

```bash
git -C "<codebase-path>" rev-parse --show-toplevel
git -C "<codebase-path>" branch --show-current
git -C "<codebase-path>" rev-parse HEAD
git -C "<codebase-path>" status --short
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
- 必须先确认 root repository identity、version / branch / commit 和 working tree state，再执行 `codegraph status`。
- version / branch / commit 任一不明确时，记录为需人工确认项，不主动猜测，也不得执行任何 `codegraph` 命令。
- `codegraph status` 失败、索引不可用或状态不确定时，立即停止当前源码证据范围，通过正式 `RequestHumanInput` 请求人工，并保留失败命令和输出摘要。
- root working tree state 必须记录；root branch 为空时写 `detached`，不得把空 branch 当成缺失 commit。

Exit：

- root repository identity、version / branch / commit、working tree state 和 CodeGraph index state 已确认，或上游授权的版本切换已完成并记录。

Blocked：

- 当前任务需要 current version evidence，但 root commit 不可确定、切换未授权、CodeGraph 索引不可用或状态命令失败。

Partial：

- 只能确认 checkout path 但缺少明确版本时，记录需人工确认项，不执行 `codegraph status`、查询或其它任何 CodeGraph 命令。

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
- CodeGraph 只能定位 candidate source semantics，查询输出不能作为独立 evidence 或直接支撑 current version implementation claim。
- 所有查询命令、query、options、matched symbol、matched file 和 relation 必须进入目标 `E-CODE-*` 的 `Collection` 或 provenance。
- 对每个 matched file，使用文件所在目录执行 `git rev-parse --show-toplevel`，解析实际 source repository。
- source repository 与 root repository 不同时，计算 `gitlink_path`，并使用 `git ls-tree` 读取 root commit 中的 `gitlink_commit`。
- source repository 与 root repository 相同时，source identity 复制 root identity，gitlink 字段明确写 `none`。
- source branch 为空时写 `detached`；必须记录 source commit、working tree state 和 CodeGraph status。

Exit：

- CodeGraph 已定位候选 symbol、file、relation 或 located symbols，并已解析每个源码核验目标所属的 source repository 与 gitlink 关系。

Blocked：

- CodeGraph 查询失败、无候选、候选不可映射源码文件或 source repository/gitlink 无法解析。

Partial：

- 只有弱候选或多候选时，记录查询结果、limitation 和未进入源码核验的原因，不得直接进入完成状态。

## Phase 5: Collect Source Code Evidence
---

本阶段在 CodeGraph 已定位的文件和符号基础上读取源码，核对当前版本 source symbol evidence。

记录要求：

- root repo / version / branch / commit / working tree state / codebase path。
- source repo / version / branch / commit / working tree state / codebase path。
- gitlink path / commit；非嵌套仓库明确写 `none`。
- source-relative file path 和该文件的 working tree state。
- 唯一 primary symbol name。
- primary symbol type。
- start_line / end_line。
- signature。
- key lines。
- reason。
- collection commands。
- limitations。

注意事项：

- 只有 CodeGraph 已定位到具体文件、符号或调用关系后，才直接读取源码片段做核验。
- 源码证据必须使用 source repo 相对路径和当前 source commit 下的行号。
- 每个 `E-CODE-*` 只记录一个 primary symbol；多个独立 symbol 必须拆成多个 evidence artifact。
- 目标源码文件必须对当前 source commit 保持 clean；有未提交修改时只能保留 candidate evidence 或阻塞项，不能标记 `source_verified`。
- 使用 `git status --short -- "<source-relative-file>"` 单独确认目标文件状态；source repository 其它无关文件的改动只记录在 provenance，不直接阻断该 symbol evidence。
- 嵌套仓库的 `gitlink_commit` 必须和 `source_commit` 对齐；不一致时记录 limitation 并停止 source-verified evidence。
- `E-CODE-*` 只拥有 source symbol evidence claim：证明所记录 symbol、signature 和 key lines 可在声明的 source commit 中重放；业务 implementation claim 由上游 `code-evidence.md` 定义，运行时行为仍需其它 observation。

Exit：

- 已核对 root/source repository provenance、gitlink、唯一 primary symbol、source-relative file、start_line / end_line、signature 和 key lines，且目标文件对 source commit 保持 clean。

Blocked：

- 源码文件不可读、source commit/gitlink 无法确认、目标文件有未提交修改、symbol 无法定位、行号无法确认或 key lines 无法支撑 source evidence claim。

Partial：

- CodeGraph 候选存在但源码行证据不足时，记录查询 provenance 和 limitation，不生成完成状态的 `E-CODE-*`。

## Phase 6: Write Code Evidence Artifacts
---

本阶段把 CodeGraph 查询 provenance 和源码符号证据写成 `E-CODE-*` 弱 schema Markdown artifact。

使用模板：

```text
templates/source-code-evidence.md
```

注意事项：

- `E-CODE-*` 使用 `templates/source-code-evidence.md`。
- CodeGraph 查询命令和结果摘要写入 `E-CODE-*` 的 `Collection`，不能获得独立 evidence id。
- `E-CODE-*` 的 `source_commit + source_relative_file` 必须可重放定位，并且只有一个 `Primary Symbol` 章节。
- `supports` 应引用上游提供的 verification point、claim id 或 evidence registry 项。
- 模板中的空字段必须用实际来源、命令、locator 或明确 limitation 填充。
- Artifact 的 Markdown 标题保留模板中的英文标题；标题下的 claim、reason、note、limitation 等自然语言内容使用中文，字段 key、symbol、命令和状态值保持原样。
- 不把命令输出原文当作业务结论；必须整理成 source symbol evidence claim、locator、supports 和 limitations。

Exit：

- `E-CODE-*` artifact 已按模板写入或返回，且实际 artifact ref 已记录。

Blocked：

- artifact target 不可写、模板缺失、必填 locator 缺失或 evidence id 重复时停止。

Partial：

- 只能形成源码候选时，必须记录查询 provenance、limitation 和缺少 `E-CODE-*` 的原因。

## Workflow Exit Rules (Enforcement)

- XR-001：Phase 1 只有在 required shell tools 可见且目标 repo 能用当前 `jarvis codebase supported` 输出判断时，才能进入 Phase 2。
- XR-002：Phase 2 只有在 managed codebase path 已解析并记录 provenance 后，才能进入 Phase 3。
- XR-003：Phase 3 必须先确认 root repository 的 version / branch / commit / working tree state，任一项未明确时不得执行任何 CodeGraph 命令；全部明确后才能检查 CodeGraph status，且 status 已记录后才能进入 Phase 4。
- XR-004：Phase 4 只有在 CodeGraph 查询结果已收敛到待核验源码候选、目标文件所属 source repository 与 gitlink 已解析，且未把候选当作实现事实时，才能进入 Phase 5。
- XR-005：Phase 5 只有在 root/source repository provenance、gitlink、唯一 primary symbol、source-relative file、start_line / end_line、signature 和 key lines 已核对后，才能进入 Phase 6。
- XR-006：Phase 6 只有在 `E-CODE-*` artifact ref、CodeGraph 查询 provenance、failed_commands、retry_log 和 limitations 已按需记录后，才能宣称本技能输出完成。

## Evidence Rules (Enforcement)

- ER-001：Guru managed codebase 的源码语义检索优先使用 CodeGraph。
- ER-002：`jarvis codebase` 只负责 codebase 管理、路径解析、版本切换和索引刷新；源码语义检索必须使用独立 `codegraph` CLI。
- ER-003：禁止把 `rg` 作为 Guru managed codebase 的首选源码语义检索方式。
- ER-004：CodeGraph 查询、状态输出和工具命令属于 Activity State，只能记录在 `E-CODE-*` 的 `Collection` 或 provenance；它们不能直接支撑 source claim。
- ER-005：本技能不生成 `rg-fallback`；CodeGraph 失败时必须停止并请求人工，不得用文本搜索或其它回退替代源码语义证据。
- ER-006：代码证据必须记录 root/source repo identity、version / branch / commit、working tree state、gitlink、source-relative file、唯一 primary symbol、start_line、end_line、signature、key lines 和 collection commands。
- ER-007：本机绝对路径只能作为本次 Scout runtime artifact provenance，不能作为 canonical source locator。
- ER-008：CodeGraph 查询结果不能获得 evidence id；implementation claim 必须有 `E-CODE-*` 支撑。
- ER-009：`E-CODE-*` 只拥有可重放的 source symbol evidence claim；业务 implementation claim 由上游 `code-evidence.md` 拥有，behavior observed claim 必须等待 runtime / log / UI / test / device evidence。
- ER-010：有副作用命令必须记录执行原因、授权来源、预期副作用和执行后的 version / branch / commit。
- ER-011：`E-CODE-*` 的 canonical replay locator 必须是 `source_commit + source_relative_file`；root commit 或本机绝对路径不能替代 source commit。
- ER-012：目标源码文件有未提交修改或嵌套仓库 gitlink commit 与 source commit 不一致时，不得标记为 `source_verified`。

## Failure Rules (Enforcement)

- FR-001：`scout-assets tools`、`jarvis codebase supported`、`jarvis codebase <repo> path` 或 `codegraph status` 失败、空输出、权限失败或解析失败时，必须记录 failed_commands、输出摘要和影响阶段。
- FR-002：CodeGraph 无命中、多命中、索引不可读或 node/range 不可定位时，不得生成 source-verified claim；只能记录查询失败、limitation 或阻塞项。
- FR-003：源码文件不可读、行号不稳定、signature 无法确认或 key lines 无法解释时，不得生成 `E-CODE-*`。
- FR-004：evidence artifact 写入失败或模板字段无法填充时，不得宣称本技能完成；必须向上游报告 artifact target 和失败原因。
- FR-005：source repository、source commit、gitlink 或目标文件 working tree state 无法解析时，不得把 root repository commit 代填为 source commit。
- FR-006：本技能声明的第三方工具、managed checkout 或 CodeGraph 能力发生错误、空输出、权限失败、参数失败、超时或状态不确定时，必须立即停止当前依赖范围，并通过正式 `RequestHumanInput` 请求人工解决；请求必须说明失败命令、原始错误摘要、受影响 repo/path、已确认的 provenance、缺失的解除条件和修复后需要重新执行的检查。

## Blocking Rules (Enforcement)

- BR-001：缺少 `scoutAssets`、`jarvis`、`codegraph` 或 `git` required shell tool 时必须停止。
- BR-002：目标 repo 不在当前 `jarvis codebase supported` 输出中，或 repo 无法唯一确定时必须停止。
- BR-003：需要切换版本、使用 `latest`、fetch 或 checkout 但缺少明确版本要求或上游授权时必须停止。
- BR-004：CodeGraph 不可用、索引打不开或状态不确定时必须立即停止当前源码证据范围并请求人工，不得继续补齐源码语义证据。
- BR-005：artifact target 不可写时，不能进入 Phase 6 的完成状态。
- BR-006：目标源码文件不属于已确认 source repository、source commit 不可确定或 gitlink 与 source commit 不一致时，不得形成 source-verified evidence。

## Retry Rules (Enforcement)

- RR-001：本技能声明的第三方工具、managed checkout 或 CodeGraph 能力首次失败后不得自动重试；必须立即停止当前依赖范围并请求人工。
- RR-002：不得通过 `remote add`、`remote set-url`、clone、删除或替换 checkout、切 branch、更新 submodule、刷新索引或其它修复动作自行改变故障环境。
- RR-003：不得改用未由本技能声明的工具、文本搜索、其它 checkout、Knowledge anchor 或模型推断来绕过失败并形成源码证据。
- RR-004：人工修复并明确回复后，才能从失败阶段重新执行必要检查；重跑必须记录修复后的命令、输出和 provenance 差异。

## Prohibited Rules (Enforcement)

- PR-001：禁止修改 Guru knowledge、代码库源码、synaptic 或 Scout runtime state。
- PR-002：禁止创建或变更 Runtime 事件、内部通信协议、profile、mount 或 MCP server。
- PR-003：禁止根据非当前 `jarvis codebase supported` 输出直接断言当前 repo 可用。
- PR-004：禁止在缺少 version / branch / commit 时主动选择 `latest`。
- PR-005：禁止在没有上游明确授权时执行 `jarvis codebase <repo> versions`、`latest` 或 `<version>`。
- PR-006：禁止在 CodeGraph 不可用、索引打不开或命令失败时改用文本搜索补齐语义证据。
- PR-007：禁止使用 `rg-fallback` 或其它文本回退替代 CodeGraph 源码语义证据。
- PR-008：禁止把 CodeGraph 命中当作运行时行为证明。
- PR-009：禁止把源码存在当作 BDD 已通过。
- PR-010：禁止把权限失败、空输出、命令错误或索引异常当作无证据成功。
- PR-011：禁止在 root repository 的 version / branch / commit / working tree state 未全部明确时执行任何 CodeGraph 命令。

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
5. 用 `codegraph query` / `explore` / `node` 定位相关 symbol 和 file，并解析文件所属 source repository 与 gitlink。
6. 读取定位文件的必要行，记录 source commit、source-relative file、primary symbol、start_line、end_line、signature 和 key lines。
7. 将 CodeGraph 查询命令和结果摘要写入 `Collection`，使用模板写入 `E-CODE-*` evidence artifact。

输出：

- `source-code-evidence.md`：记录可重放的 source commit/path、唯一 primary symbol、行号、key lines、CodeGraph 查询与源码采集命令和 supports。
