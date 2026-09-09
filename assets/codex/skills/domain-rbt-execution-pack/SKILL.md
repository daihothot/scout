---
assetKind: scout.skill
name: domain-rbt-execution-pack
description: 为一次 RBT 执行建立和维护 Execution Pack 时使用。
id: domain-rbt-execution-pack
version: 0.5.0
type: domain
domain: rbt
phase: [execute, review]
family: [rbt, artifact]
tags: [scout, rbt, execution, pack, evidence]
devices: [any]
dependencies:
  skills:
    required: [tool-jarvis-codebase]
summary: 定义 RBT Execution Pack 的全局边界、语言规范、模板导航、生命周期和 handoff contract。
---

# Domain RBT Execution Pack

当需要把一次 Runtime Behavioral Test（RBT）的 Agent 侧事实、预期和交付引用写成正式 Execution Pack 时使用本技能。后续 `RBT` 均表示 Runtime Behavioral Test。

本技能只拥有 Execution Pack 的全局 contract，不拥有执行动作、Runtime 查询、命令解释或 BDD coverage 结论。

## Skill Type

- type: domain
- layout: compact
- note: 本技能统一 Pack 的边界和填写语言；每个 artifact 的字段、表格、ID 和细节由对应 template 定义。

## Ownership

- Executor 是 Execution Pack 的唯一 writer；其它 role 只能读取正式 refs。
- 一个 Pack 只对应一个 BDD identity 和一次最终有效 Executor 作业；执行前调整原地更新，不创建 retry 或 attempt Pack。
- Pack 完整只表示 Agent 侧交付内容完整，不表示 BDD 已通过、失败或已被 Runtime 覆盖。
- BDD、代码、平台、Journal expectation、Signal expectation 和 Human Input 是不同事实，必须由对应 artifact 分开保存。
- Pack 只保存 Agent 侧可定位事实、选择、预期、观察和 refs；不复制 Runtime 命令、返回值、trace、evidence、campaign journal 或 cleanup 正文。

## Global Language Contract

- 所有 Agent 填写的 claim、说明、理由、限制、问题、摘要、判断条件和其它描述性内容必须使用中文。
- ID、status、command、schema 字段、Runtime identity、symbol、文件系统 path、URL、version、时间、枚举和其它原始技术值保持原样，不翻译、不改写。
- 模板中的英文 heading、字段 key、表格列和 frontmatter key 按模板保留；只替换 placeholder 并填写实际值。
- 不适用字段按对应 template 允许的方式填写 `none` 或删除，不留下未处理的 `<填写...>` placeholder。

## Template Navigation

创建、读取或更新 Pack 时：

1. 从本 Skill 目录直接读取 `templates/template-index.md`；
2. 按 `template-index.md` 的 required 列表读取对应 templates；
3. 生成 `E-CODE-*` 时，再读取 `tool-jarvis-codebase` 实际 Skill 目录中的 `templates/source-code-evidence.md`；
4. 以对应 template 作为 artifact 的唯一结构基线，不在本 Skill 重复字段、表格、ID 生成方式或 artifact 专属判断规则；
5. handoff 前按 `template-index.md` 再检查全部 required templates、状态和引用闭合。

Skill 目录可能是符号链接；不要用未跟随符号链接的 `find` 结果判断 templates 是否存在。

## Inputs

### I-001: Execution Identity

必须有：

- 唯一 BDD identity 和可读 BDD source ref；
- Scout Runtime 注入的 `SCOUT_RUN_ID`；
- Executor 已确认或标记为待 Runtime 确认的 Behavioral identities。

缺失唯一 BDD、source ref 或必要 identity 时，只能保持 `draft + partial` 或 `blocked + blocked`，不得猜测补齐。

### I-002: Execution Facts

由 Executor 提供：

- BDD 和业务代码事实；
- managed codebase version；
- 实际平台类型和版本；
- 执行前计划、Journal expectation、Signal expectation；
- Human Input 记录和限制；
- Runtime capability 缺口及其影响。

这些事实的字段和记录方式由对应 template 定义。

### I-003: Artifact Target

Pack 使用当前 Executor 私有 artifact root 下的 canonical 目录。目录命名、`pack_ref`、artifact 文件和引用格式以 `templates/template-index.md` 与 `execution-pack.md` 为准；同一执行原地更新，不创建副本。

## Lifecycle

Pack 只使用以下整体状态：

- `draft + partial`：已保留真实进度，但 Agent 侧内容尚未闭合；
- `ready + complete`：required artifacts、来源和引用均已闭合，可以提交 handoff；
- `blocked + blocked`：存在无法继续执行或交付 ready Pack 的真实阻塞，必须保留已确认事实、缺口和 Human Input 状态。

整体状态不自动覆盖单个 artifact 的状态：每个 artifact 按自身 template 的必需事实独立判断。Hook 缺失可以阻塞整体 Pack，但不能把已经完整的其它 artifact 自动改成 blocked。

如果 required Given 无法由当前 Runtime Hook 完整表达：

- 在 campaign mutation 前记录已确认映射和缺口；
- 按 Human Input template 记录正式申请；
- Pack 保持 `blocked + blocked`；
- 不伪造 campaign、trigger 或通过结论。

## Artifact Boundary

- `template-index.md` 是 artifact 清单和读取顺序的唯一入口。
- `execution-pack.md` 拥有 Pack 总体状态、执行身份、计划、artifact refs 和 handoff；具体字段以该 template 为准。
- 各类 evidence、Journal expectation、Signal expectation、Human Input 和 Registry 只由各自 template 定义细节。
- `E-CODE-*` 必须来自 managed codebase 当前版本的业务源码 evidence；Behavioral control、Hook 注册、schema、Gateway 或 Tool 实现不能替代业务代码证据。
- Platform artifact 只记录 template 要求的平台事实；连接、session、命令、campaign 和 live evidence 属于 Runtime 或 Tool，不写入 Platform artifact。

## Handoff Contract

正式 handoff 只使用 `execution-pack.md` 中声明的 handoff 字段。当前 handoff 的跨角色边界是：

- `pack_id`：Pack identity；
- `pack_ref`：当前 Pack 目录 ref；
- `bdd_id`：本 Pack 的 BDD identity；
- `status`：`ready`、`partial` 或 `blocked`，表示交付状态而非 BDD 结论；
- `blocking_items`：没有阻塞时按 template 填写 `none`，否则使用中文说明。

handoff 不携带 Pack 正文，不把普通消息、Tool 活动或 Runtime 状态摘要当作正式 handoff。

## Global Integrity Rules

- 每个 artifact 必须保留对应 template 的 heading、字段 key、表格列、章节顺序和状态结构；自定义等价格式不能替代 template contract。
- 每个 artifact 的 frontmatter 状态与正文状态必须一致；状态冲突时 Pack 不能提交。
- 所有 ID、artifact refs、locators 和 supports 关系必须按对应 template 闭合；本 Skill 不重新定义各类 ID 语义。
- Runtime 事实与 Agent 侧预期不能互相替代；Pack 不保存实际 Runtime journal 或 live evidence 正文。
- Pack、Human Input 已解决或 requirement 已定义都不能解释为 BDD 已覆盖。
- 执行结果与预期不一致时记录事实和限制，不改写为通过，不因不匹配自动启动新的执行。

## Failure Rules

- 必需 artifact 缺失、来源不可读、ID 冲突、引用断裂、平台事实未确认或 required Signal expectation 未按 template 写入时，不能提交 `ready + complete`。
- 只有 Scout Runtime 接受 Human Input 并返回真实 request identity 后，才能建立 Human Input artifact；失败调用不算正式申请。
- managed codebase 业务源码无法定位或读取时，不创建伪造的 `E-CODE-*`，按 code template 记录 blocked。
- 任何失败、限制和未覆盖范围都必须使用中文描述，并保留实际技术值。

## Prohibited Rules

- 禁止本 Skill 制定或执行 Behavioral 计划、查询 Runtime、解释 Tool 命令或形成 BDD coverage 结论。
- 禁止除 Executor 外的角色创建、补写或修改 Pack。
- 禁止把 Runtime command、return value、trace、evidence、campaign lifecycle 或 cleanup 正文复制进 Pack。
- 禁止在本 Skill 中发明 template 未声明的字段、ID、状态、Signal expectation 或比较方法。
- 禁止使用 Knowledge locator、BDD 文本或 Knowledge symbol anchor 代替当前 managed codebase 的 `E-CODE-*`。

## Checklist

- 已读取 `template-index.md` 及当前所需的全部 templates。
- Pack 只对应一个 BDD 和一次最终有效执行，目录和 `pack_id` 稳定。
- 所有 Agent 描述性内容为中文，技术原始值保持原样。
- 每个 artifact 使用对应 template 结构，状态、ID、refs、locators 和 supports 关系闭合。
- 已确认的代码、平台、Journal、Signal 和 Human Input facts 没有混为一种事实。
- Runtime 命令、返回值、journal 和 live evidence 没有复制进 Pack。
- Hook capability 缺口在 campaign mutation 前形成 blocked Pack，并保留正式 Human Input 状态。
- handoff 只携带 Pack 定位、BDD identity、交付状态和阻塞信息。
- Pack 状态没有被解释为 BDD coverage 结论。
