---
assetKind: scout.skill
name: meta-scout-internal-skill-creator
description: 创建或修改 Scout Internal Skill 的统一方法论，覆盖目录创建、metadata、phase、tags、模板、profile 挂载、边界和验证规则。
id: skills.scout.internal-skill-creator
version: 0.2.2
phase: [research, validate]
tags: [scout, skill, asset, template, workflow, governance]
devices: [any]
dependencies:
  shellTools:
    required: [scoutAssets]
    optional: [rg, find, sed, cat]
summary: 用统一模板生产 Scout 内部 Skill，并保证它们能被 profile、mount 和 Agent 工作流一致使用。
---

# Meta Scout Internal Skill Creator

当任务要求创建、修改、评审或规范化 `assets/codex/skills/**/SKILL.md` 时使用本技能。

本技能的目标是建立统一的 Scout 内部 Skill 系统：内部 Skill 负责沉淀方法论，Agent 负责读取并执行方法论，Asset Store / Runtime 负责 profile 挂载、mount、preflight 和运行记录。

## Skill Type

- type: meta
- structure_level: compact
- note: 本技能是治理型 meta Skill，可以使用中文治理章节；业务、工具、边界查询和工作流 Skill 仍必须以 `templates/internal-skill.md` 为结构基准。

## 核心边界

Scout Internal Skill 是 Scout 管理的 Codex 原生 skill 资产。源文件固定在：

```text
assets/codex/skills/<skill-name>/SKILL.md
```

它可以定义：

- 验证、研究、校验或工具使用的方法论。
- 角色内工作流、产物模板、证据要求和 gate 规则。
- 领域或工具边界，例如知识库读取、codebase 检索、artifact 写入、回放信息记录。
- 可复用示例和失败处理规则。

它不能定义：

- Runtime 事件实现、payload 包装或调度代码。
- 当前 run 的临时状态、真实设备 id、人工确认结果或工具调用结果。
- 未经归纳的 Guru 知识库原文、代码库源码、synaptic 开发事实或外部 workflow skill。
- 让 Agent 绕过 profile、mount、preflight、artifact 或 evidence ref 的规则。

## 创建目录

新建内部 Skill 时，目录名必须与 frontmatter 的 `name` 完全一致：

```text
assets/codex/skills/<skill-name>/
  SKILL.md
```

可选扩展目录：

```text
assets/codex/skills/<skill-name>/
  SKILL.md
  templates/template-index.md
  templates/*.md
  references/reference-index.md
  references/*.md
```

命名规则：

- 使用小写字母、数字和连字符。
- 使用类别前缀明确 Skill 的责任边界：
  - `domain-<domain>-<role-or-capability>`：领域工作流、角色入口或领域产物 contract。
  - `tool-<provider>-<capability>`：工具链的操作方法、约束和证据规则。
  - `signal-<signal>[-<acquisition>]`：信号 contract，或该信号的一种采集实现。
  - `meta-<scope>-<capability>`：Skill、资产或治理方法。
- Signal 采集 Skill 使用同一 Signal 名称作为前缀，例如 `signal-runtime-log-unity-pipeline-cli`；基础 Signal 不反向依赖采集实现。
- 不使用空格、下划线、中文、版本号或一次性任务名。
- 不用过宽泛名称，例如 `helper`、`workflow`、`tools`。

除非任务明确需要脚本、参考材料或额外模板文件，否则只创建 `SKILL.md`。内部 Skill 的正文应优先保持自包含。

目录规则：

- `SKILL.md` 负责主方法论、阶段、规则和使用边界。
- `templates/` 负责 reusable artifact 形态、弱 schema、字段约束和输出布局。
- `references/` 负责较长的稳定说明、术语表、读取地图或工具背景，不承载当前 run 状态。
- 当 `templates/` 下超过一个文件时，必须创建 `templates/template-index.md`。
- 当 `references/` 下存在文件时，必须创建 `references/reference-index.md`。
- `templates/template-index.md` 和 `references/reference-index.md` 只做导航、用途说明和读取顺序；不得写业务事实、证据事实、运行状态或当前 task 判断。
- 不使用 `templates/index.md` 作为模板目录导航；`index.md` 允许作为业务产物名称，因此导航索引必须避开该文件名。

## 统一模板

创建新内部 Skill 时，必须先读取并复用：

```text
templates/template-index.md
templates/internal-skill.md
```

`templates/template-index.md` 定义模板用途和读取顺序；`templates/internal-skill.md` 定义统一 frontmatter 和正文结构。使用模板时必须替换所有占位符，并根据具体 Skill 填写 Core Use、模型、Inputs、Workflow、Output Layout、Artifact Relationship Rules、Phase、Workflow Exit Rules、Evidence Rules、Failure Rules、Blocking Rules、Retry Rules、Prohibited Rules 和 Example；禁止留下模板占位文本。

Metadata 字段规则：

- `assetKind` 固定为 `scout.skill`。
- `name` 必须等于目录名。
- `description` 必须包含使用场景；这是 Agent 选择 Skill 的主要依据。
- `id` 是稳定资产身份，使用 `skills.<domain>.<stable-id>` 风格，后续改正文不改 id。
- `domain` 优先使用资产所有权或知识域，例如 `scout`、`guru`、`jarvis`；不要把一次性任务名、profile 名或阶段名当作 domain。
- `version` 使用语义版本；首次创建用 `0.1.0`。
- `phase` 使用当前工程支持的阶段，不能临时造词。
- `tags` 使用稳定扁平 token，不能写长句。
- `devices` 没有明确设备限制时使用 `[any]`。
- `dependencies` 只在存在内部 Skill、shell tool、MCP server 或 plugin 依赖时出现。
- `summary` 面向候选列表，必须短于正文标题。

Dependencies 规则：

- 没有任何依赖时，省略整个 `dependencies` 字段。
- 某一类没有依赖时，省略该类，例如没有 plugin 依赖就不写 `plugins`。
- `required` 或 `optional` 为空时，省略该字段。
- `skills` 使用 `assets/codex/skills/<name>` 的目录名，例如 `tool-jarvis-codebase`。
- `shellTools` 使用 `assets/codex/tools/shell-tools.json` 中的 tool id，例如 `scoutAssets`、`jarvis`、`codegraph`。
- `mcpServers` 使用 `assets/codex/mcp/servers.json` 中的 server id，例如 `scout_local_capability`。
- `plugins` 使用 `assets/codex/plugins/**/.codex-plugin/plugin.json` 中的 plugin name，例如 `scout-local-capability-plugin`。
- `required` 表示缺失时该 Skill 不应被认为可完整执行。
- `optional` 表示可增强能力、可诊断能力或有条件 fallback；使用前仍必须通过当前 mount 能力查询确认。

## Phase 规范

当前 Worker 主要阶段：

- `research`：清理输入、读取知识库、提取语义切片、形成 ResearchArtifact 或证据候选。
- `verify`：围绕 BDD / 验收条件采集证据、解释证据、产出 VerificationReport。
- `validate`：校验 artifact、schema、evidence refs、状态一致性、风险披露和 gate 结论。

选择规则：

- 只填该 Skill 实际服务的阶段。
- 不为了提高命中率把 `research`、`verify`、`validate` 全部填上。
- 同时服务多个阶段时，正文必须分阶段写清输入、输出和禁止范围。
- `coordinate` 只属于 Coordinator 调度语义，不作为普通 Worker Skill 的默认阶段。
- 已有历史 Skill 中出现的过渡阶段不能作为新 Skill 的默认依据；新 Skill 必须以当前代码和 profile 支持的阶段为准。

## Skill 类型

内部 Skill 按维护成本和执行方式分层，不要求所有 Skill 都写成最重的工作流形态。

- Workflow Skill：跨多个阶段产出 artifact、evidence pack、manual 或 gate 结果，必须使用完整 Inputs、Workflow Overview、Output Layout、`### Artifact Relationship Rules`、编号 Phase 和 XR / ER / FR / BR / RR / PR 规则。
- Tool Skill：主要规范工具链、命令顺序或 evidence 采集方法，可以使用较轻的 workflow，但仍必须写 Core Use、Tool / Command Model、Inputs、Output Layout、命令副作用、错误处理、阻塞规则和禁止规则。
- Boundary / Inspector Skill：主要查询当前 mount、profile、memory 或资产边界，不判断业务对错；必须写查询范围、输出模板、字段来源、limitation 和禁止修改规则。
- Meta Skill：用于治理、创建或规范其它 Skill，可以使用治理型章节；但必须明确业务 / 工具 / 工作流 Skill 仍以 `templates/internal-skill.md` 为结构基准。

## Tags 规范

`tags` 是稳定分类 token，不是自然语言摘要。

推荐从这些维度选择：

- 系统域：`scout`、`jarvis`、`guru`。
- 资产类型：`skill`、`asset`、`template`、`knowledge`、`codebase`。
- 证据类型：`evidence`、`codegraph`、`source`、`audit`、`replay`。
- 工作流类型：`research`、`verification`、`validation`、`workflow`、`governance`。
- 工具类别：`shell-tool`、`mcp`、`plugin`。

禁止：

- 用句子当 tag。
- 用一次性业务名、issue id、task id、run id 当 tag。
- 用同义词堆叠，例如同时写 `verify`、`verification`、`validate` 表达同一件事。
- 为当前任务临时发明无法复用的 tag。

如果没有现成 tag，先在正文 `keywords` 风格的说明中表达，不要把不稳定词写入 `tags`。

## 正文结构

新 Skill 正文必须优先采用 `templates/internal-skill.md` 的通用结构。可以按具体 Skill 替换模型、workflow 和 output 章节标题，但不能缺失核心语义。

通用结构：

- `# <Title>`：Skill 标题。
- 触发场景和目标说明：说明何时使用，以及本 Skill 沉淀的可复用方法论目标。
- `## Core Use`：列出本 Skill 负责和不负责的事项。
- `## <Domain / Tool / Knowledge Model>`：说明领域、工具、知识库或 codebase 模型；没有稳定模型时可省略，但不能把非当前输出、示例项或旧文档写成当前事实。
- `## Inputs`：用编号输入项描述上游必须提供或可推断的信息。
- `## <Workflow Overview>`：只列 Phase 顺序，不重复命令、模板正文或证据细节。
- `## <Output Layout>`：说明产物形态、模板和 artifact ref；不得随意发明 canonical artifact 目录。
- `### Artifact Relationship Rules`：固定章节名；当产物包含 summary、detail、registry、index 或下游引用关系时，必须写清职责边界和 ref 规则。
- `## Phase 1: <Phase Name>` 到 `## Phase N: <Phase Name>`：每个 Phase 写阶段目的、使用命令或模板、注意事项。
- `## Workflow Exit Rules (Enforcement)`：用编号规则说明跨阶段强约束、最终完成条件和不得越界的全局门禁；不要重复每个 Phase 的 `Exit` 细节。
- `## Evidence Rules (Enforcement)`：用编号规则说明证据成立条件。
- `## Failure Rules (Enforcement)`：用编号规则说明命令失败、空输出、解析失败、模板字段缺失或证据不闭环时如何记录。
- `## Blocking Rules (Enforcement)`：用编号规则说明缺 required 能力、输入不可唯一定位、目标不可写或证据链无法继续时必须停止。
- `## Retry Rules (Enforcement)`：用编号规则说明哪些失败可重试、重试次数、记录要求和禁止自动重试的副作用命令。
- `## Prohibited Rules (Enforcement)`：用编号规则说明禁止行为。
- `## Example`：给出最小可迁移示例，不引入一次性任务状态。

编号规则：

- Inputs 使用 `### I-001: <Input Name>`、`I-002` 递增。
- Phase 使用 `## Phase 1: <Phase Name>`、`Phase 2` 递增。
- Workflow Exit Rules 使用 `XR-001`、`XR-002` 递增。
- Evidence Rules 使用 `ER-001`、`ER-002` 递增。
- Failure Rules 使用 `FR-001`、`FR-002` 递增。
- Blocking Rules 使用 `BR-001`、`BR-002` 递增。
- Retry Rules 使用 `RR-001`、`RR-002` 递增。
- Prohibited Rules 使用 `PR-001`、`PR-002` 递增。
- 只在 `### I-*` 和 `## Phase *` 标题下一行添加 `---` 分隔线。

术语规则：

- 使用 `上游` 表示当前 task 的请求来源、Coordinator、上层 Skill 或人工输入来源。
- 使用 `需人工确认项` 表示缺少版本、repo、业务边界或用户画像等必须确认的信息。
- 使用 `阻塞项` 表示缺少能力、工具不可用、权限不足、输入不可唯一定位或证据链无法继续。
- 不使用不一致的中英混杂状态词；统一写 `上游`、`需人工确认项`、`阻塞项`。
- 动态能力、仓库、工具、MCP server、plugin、profile 可见性必须以当前 mount 查询或当前工具输出为准；不得写非当前输出列表。

Phase 写法：

- Phase 只写阶段目的、必要命令或模板引用、注意事项。
- Phase 不内联模板正文；模板内容放在 `templates/` 或对应 Skill 的模板文件中。
- 有副作用命令必须单独标成“副作用命令”，并说明默认不执行和授权条件。
- 工具输出属于 Activity State；必须整理成 artifact、evidence ref、locator 或 limitation 后才能支撑业务表述。
- 每个 Phase 必须能根据 `Workflow Exit Rules` 判断是否进入下一 Phase、停止、标记部分完成或记录阻塞项。
- 多阶段 Workflow Skill 的每个 Phase 建议单独列出 `Exit`、`Blocked`、`Partial` 三段；简单 Tool Skill 可以只用全局 XR / FR / BR / RR 规则，但不得让阶段退出条件含糊。

Workflow Exit Rules 写法：

- `Workflow Exit Rules (Enforcement)` 不重复每个 Phase 的局部退出条件。
- XR 只写跨阶段强约束、最终完成门禁、阻塞项和部分完成状态如何影响整体交付。
- 如果某条规则只描述“Phase N 满足什么条件进入 Phase N+1”，优先放回对应 Phase 的 `Exit`。
- 如果某条规则约束多个 Phase、整体 artifact 完成状态、claim owner、ref policy 或 required capability 边界，放入 XR。

Output Layout 写法：

- Skill 不随意定义新的 canonical artifact 目录。
- 产物位置由上游、当前 role layout 或当前 task artifact layout 决定。
- 模板只定义 artifact 形态、字段约束、证据编号和 provenance 要求。
- Artifact 模板中的事实字段默认要求取得确切信息，不显式增加 `Verify`、`Required` 或其它分类标记。
- 当前输入、证据和工具结果都无法确认默认事实字段时，由使用该模板的 Skill 统一进入人工求证。
- 只有中文填写说明末尾明确写出 `Nice to Have，可不填写` 的字段允许缺失；缺失不阻塞完成，也不单独触发人工求证。
- 状态、ID、ref、digest 等由 workflow 生成或由 contract 校验的结构字段直接使用中文填写说明。
- 模板不得保留无说明的空字段；每个待填位置必须使用中文 `<填写...>` 说明，且 Skill 必须禁止把填写说明提交为 artifact 事实。
- 模板应包含弱 schema 状态字段，例如 `status`、`blocking_items`、`failed_commands`、`retry_log` 和 `limitations`，用于交接失败、阻塞和重试事实。
- 工作流总览、聚合、手册或 gate 类 artifact 应使用 `status: draft | ready | blocked` 和 `completion_state: complete | partial | blocked`。
- 轻量单条 detail / evidence artifact 可以只使用 `status`，但必须说明该状态的枚举或来源；参与交接时仍应包含 `blocking_items`、`failed_commands`、`retry_log` 和 `limitations`。
- 如果存在聚合产物和明细产物，必须说明聚合文件是摘要索引、完整块集合还是下游手册。
- 如果存在 registry 或 index，必须说明它只做导航、索引或 refs，不定义 claim 事实。
- 如果存在 claim，必须说明 claim owner 是哪个 artifact，避免多个文件重复定义同一 claim。
- 如果使用 `artifact_ref`、`detail_ref` 或类似字段，必须说明它是 required、optional 还是不使用。
- 如果 templates 或 references 多于一个文件，必须通过对应 `template-index.md` 或 `reference-index.md` 说明读取顺序和用途。

## 使用流程

创建或修改内部 Skill 时按这个流程执行：

1. 读取现有 `assets/codex/skills/*/SKILL.md`，确认当前风格、metadata 和命名。
2. 读取 `assets/codex/agents/agent-profiles.json`，确认这个 Skill 是否需要被某个 profile 默认挂载。
3. 确认任务目标属于内部 Skill，而不是 AGENTS 通用规则、shell tool、MCP server、plugin、External Workflow Skill 或 Guru 知识库。
4. 创建或更新 `assets/codex/skills/<skill-name>/SKILL.md`。
5. 按 phase 和 tags 规范填写 frontmatter。
6. 按依赖规则填写 `dependencies`，只引用当前资产源中真实存在的 skill、shell tool、MCP server 或 plugin。
7. 读取 `templates/template-index.md` 和 `templates/internal-skill.md`，按通用结构写 Core Use、模型、Inputs、Workflow、Output Layout、Artifact Relationship Rules、Phase、Workflow Exit Rules、Evidence Rules、Failure Rules、Blocking Rules、Retry Rules、Prohibited Rules 和 Example。
8. 如果需要让 Agent 默认可见，单独修改对应 profile 的 `skills` 列表。
9. 做最小验证：路径存在、目录名等于 `name`、frontmatter 字段齐全、非空 dependencies 引用存在、profile 引用存在、正文没有 Runtime 实现细节或当前 run 临时事实，并按下方验证清单逐项检查。

## 使用场景

适合创建内部 Skill 的场景：

- 某类验证或研究流程会重复出现，需要统一方法论。
- 某个工具链使用容易出错，需要固定边界、命令顺序和证据规则。
- 某类 artifact 或 gate 产物需要统一模板。
- 某个领域知识需要转成 Agent 可执行的方法论，而不是直接塞进 prompt。
- 某个 profile 需要稳定挂载一组工作能力。

不适合创建内部 Skill 的场景：

- 只服务一次 task 的临时说明。
- Runtime 事件、状态机、mailbox、内部通信协议或调度实现。
- 需要写代码实现的 shell tool、MCP server 或 plugin。
- 还没有经过归纳的知识库原文、源码片段、聊天记录或开发过程事实。
- 需要用户确认的业务判断或产品决策。

## 示例：研究类 Workflow Skill

```markdown
---
assetKind: scout.skill
name: domain-validation-research-pack
description: Scout Researcher 在 Validation Domain 中编排知识与代码证据、构建唯一 Research Pack、Evidence Registry 和 Verification Manual 时使用。
id: skills.validation.research-pack
version: 0.1.0
phase: [research]
tags: [scout, validation, research, pack, evidence, manual]
devices: [any]
dependencies:
  skills:
    required: [tool-guru-knowledge, tool-jarvis-codebase]
  shellTools:
    required: [scoutAssets, scoutResearchArtifactCheck, scoutArtifactDigest]
summary: 编排知识和代码 producer contracts，形成唯一 Research Pack、证据索引和验证手册。
---
```

正文必须说明如何编排 producer contracts、分配 evidence ids、区分明细与聚合、处理人工门禁，以及如何生成 registry、manual、digest 和 handoff；不得复制 Tool Skill 的采集方法。

## 示例：工具链 Skill

```markdown
---
assetKind: scout.skill
name: tool-guru-knowledge
description: Scout Agent 从 Guru Knowledge 定位 Behavior、Domain、Module、Capability、Availability、API 和 Platform 文档，记录可重放来源并形成知识证据时使用。
id: skills.guru.knowledge-research
version: 0.1.0
phase: [research]
tags: [guru, knowledge, bdd, capability, evidence, source]
devices: [any]
dependencies:
  shellTools:
    required: [scoutAssets, git]
    optional: [rg, sed, find, cat]
summary: 只读检索 Guru Knowledge，并形成可追溯的 Capability、Availability 和 Platform 知识证据。
---
```

正文必须说明只读来源边界、可重放 locator、knowledge repository provenance、知识明细 evidence、失败排查和禁止写回规则；不得拥有 Research Pack、唯一 BDD 决策、Registry、Manual 或人工门禁。

```markdown
---
assetKind: scout.skill
name: tool-jarvis-codebase
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
```

正文必须说明命令副作用、只读查询、版本确认，以及 CodeGraph 查询与 `E-CODE-*` 源码行号证据的边界；CodeGraph 查询结果不得建模为独立 evidence。

## 示例：边界查询 Skill

```markdown
---
assetKind: scout.skill
name: tool-scout-boundary-inspector
description: 查询当前 Scout Agent 的 mount 资产边界、工作边界、能力入口和 run 级共享记忆摘要，并整理为 Boundary Snapshot。
id: skills.scout.boundary-inspector
version: 0.1.0
phase: [research, verify, validate]
tags: [scout, asset, boundary, memory, audit, workflow]
devices: [any]
dependencies:
  shellTools:
    required: [scoutAssets, scoutMemory]
    optional: [pwd, ls, cat, sed, rg]
summary: 用 scout-assets 与 scout-memory 查询当前 Agent 可见边界，并整理为中立的 Boundary Snapshot。
---
```

正文必须说明只做中立边界快照，不判断业务 task 是否继续、是否通过或是否完成。

## Profile 挂载规则

内部 Skill 源目录存在，不代表当前 Agent 可使用。

如果任务要求某个 Agent 默认可见该 Skill，必须修改：

```text
assets/codex/agents/agent-profiles.json
```

规则：

- Researcher 只挂载服务 `research` 的 Skill。
- Verifier 只挂载服务 `verify` 的 Skill。
- Validator 只挂载服务 `validate` 的 Skill。
- 跨阶段 Skill 可以同时挂载到多个 profile，但正文必须分阶段写清职责边界。
- Coordinator 默认不挂载 Worker 方法论 Skill；除非该 Skill 专门服务调度、观察或资产治理。
- Skill 可以存在但未挂载；未挂载表示不会默认进入任何 profile 的可见能力，除非 Runtime 或某个 profile 显式挂载。
- 新建 Skill 不自动修改 profile；只有任务明确要求默认可见时才更新 `agent-profiles.json`。

修改 profile 后必须确认 `skills` 中的名字与目录名一致。

## 验证清单

通用必检项：

- 目录存在：`assets/codex/skills/<skill-name>/SKILL.md`。
- `name` 等于目录名。
- `assetKind` 是 `scout.skill`。
- `id` 稳定且没有和其它 Skill 重复。
- `phase` 只包含当前工程支持且实际需要的阶段。
- `tags` 是扁平稳定 token。
- `devices` 明确，通常是 `[any]`。
- 非空 `dependencies` 引用都能在当前资产源中定位；没有依赖时不写空 block。
- 正文声明 Skill Type 和 structure_level；Meta Skill 可使用治理型章节，但必须说明例外范围。
- `templates/` 多于一个文件时存在 `templates/template-index.md`；`references/` 存在文件时存在 `references/reference-index.md`。
- template / reference index 只做导航和读取顺序，不承载业务事实、证据事实、运行状态或当前 task 判断。
- 没有写入 Runtime 实现细节、当前 run 临时状态或未经归纳的外部事实。
- 如果修改 profile，profile 引用的 skill 名称能在 `assets/codex/skills/` 中找到。

Workflow Skill 必检项：

- 正文包含 Core Use、模型或边界、编号 Inputs、Workflow Overview、Output Layout、`### Artifact Relationship Rules`、编号 Phase、Workflow Exit Rules、Evidence Rules、Failure Rules、Blocking Rules、Retry Rules、Prohibited Rules 和 Example。
- 每个 Phase 已写清 `Exit`、`Blocked`、`Partial`。
- `Workflow Exit Rules (Enforcement)` 只写跨阶段强约束和最终完成门禁，不重复 Phase 的局部 `Exit`。
- `### Artifact Relationship Rules` 明确 summary artifact、detail artifact、registry / index、claim owner、downstream reference rule 和 ref field policy。
- workflow / summary / manual / gate 类模板包含 `status: draft | ready | blocked` 和 `completion_state: complete | partial | blocked`，或明确说明为何不需要 `completion_state`。
- 单条 detail / evidence 模板至少包含 `status`、`blocking_items`、`failed_commands`、`retry_log` 和 `limitations`，或明确说明不适用原因。
- Artifact 模板的事实字段默认要求确切信息，只有填写说明中明确写出 `Nice to Have，可不填写` 的字段允许缺失。
- 模板没有无说明的空字段；待填位置包含中文 `<填写...>` 说明，且完成态产物禁止残留填写说明。

Tool Skill 必检项：

- 正文包含 Core Use、Tool / Command Model、Inputs、Output Layout、命令副作用、错误处理、阻塞规则、重试规则和禁止规则。
- 如果存在多个 Phase，可以用每个 Phase 的 `Exit` / `Blocked` / `Partial`，也可以用全局 XR / FR / BR / RR 给出清晰退出条件。
- 必须说明只读命令和副作用命令的边界。
- 必须说明工具输出如何整理成 artifact、evidence ref、locator 或 limitation。
- 如果产出 detail evidence artifact，模板至少包含 `status`、`blocking_items`、`failed_commands`、`retry_log` 和 `limitations`。

Boundary / Inspector Skill 必检项：

- 正文包含查询范围、输出模板、字段来源、limitation、禁止修改规则和 `### Artifact Relationship Rules`。
- 可以使用查询型 Phase；多 Phase 时应写清 `Exit`、`Blocked`、`Partial`，或在全局 XR / FR / BR / RR 中给出清晰退出条件。
- 必须说明查询结果只代表当前可见边界，不能替代业务 evidence id。
- Snapshot / summary 类模板包含 `status: draft | ready | blocked` 和 `completion_state: complete | partial | blocked`，或明确说明为何不需要 `completion_state`。

Meta Skill 必检项：

- 正文声明 `type: meta` 和 `structure_level`。
- 可以使用治理型章节，不强制使用业务 Skill 的完整章节名。
- 必须明确业务、工具、边界查询和工作流 Skill 仍以 `templates/internal-skill.md` 为结构基准。
- 必须维护自身模板目录索引，并把 `templates/template-index.md` 自身登记进索引。
- 验证清单必须按 Skill 类型分层，不能用 Workflow Skill 的最重标准检查所有 Skill。

## 最小命令

查看现有 Skill：

```sh
find assets/codex/skills -maxdepth 2 -name SKILL.md -print
```

查看 profile：

```sh
cat assets/codex/agents/agent-profiles.json
```

检查实际 frontmatter：

```sh
find assets/codex/skills -maxdepth 2 -name SKILL.md -print -exec sed -n '1,12p' {} \;
```

检查新增 Skill：

```sh
sed -n '1,80p' assets/codex/skills/<skill-name>/SKILL.md
```
