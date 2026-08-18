# Scout Runtime

你正在 Scout 为当前 Agent 生成的 Codex 原生 mount 中运行。

## Scout Context

- Scout Runtime 负责准备 run、Agent、mount、profile、能力资产和任务通信边界。
- 当前 Agent 的通用职责来自本文件，角色职责来自角色 `AGENTS.md`，领域行为和专项方法来自当前 profile phase 投影的 Skill。
- Runtime、角色规则和领域 Skill 各自拥有不同边界。

## Codex Agent Environment

- 当前工作目录是当前 Agent 的 mount root；资产、路径、权限和能力以当前 mount/profile 为准。
- 被唤起后先读取通用规则、Worker 通用规则（如适用）、角色规则、当前 task 或 message 和可见上下文。
- 在探索路径、mount、artifact 或可用能力前，先读取 `.scout/skill/internal/boundary-inspector/internal-boundary-inspector/SKILL.md`；它说明稳定目录结构和权限边界，避免通过试错探查禁止路径。
- 使用动态工具前，读取角色 AGENTS 指定的对应 Tool Skill；使用领域能力时，读取当前角色适用的 Domain Skill。

## Skill Filesystem

- Profile 的 `phase` 决定哪些 Skill 被物化到当前 mount；当前 Agent 只能看到自己的 phase 集合及其 required Skill 依赖。
- Skill 位于 `.scout/skill/<family...>/<skill-name>/SKILL.md`。`family` 是稳定类型和目录分类，不是需要交互导航的 Runtime 状态。
- 普通 Skill 直接通过文件系统按角色、领域和任务需要定位；Domain Skill 负责指出其依赖、resources、工具和专项方法的适用条件。
- `dependencies.skills.required` 和 required supplementary resources 是当前 Skill contract 的组成部分；使用该 Skill 时遵守其声明，不用 catalog、selection 或专用读取协议。
- Single 是例外：只有角色 Domain Skill 要求消费 Single 时，才按它指定的目录和 `internal-single-skill-reader` 完整读取通用集合及已选 capability 集合。
- 不扫描当前 mount 之外的 Skill 源目录，也不通过其它 Agent mount 获取不同 phase 的 Skill。

## Working Rules

- 写入持久文件前，必须确认当前 task 已授权该类写入，并确认目标在当前可写范围内。
- Dynamic Tool 的 description 只说明名称与主要用途；调用契约、生命周期和失败语义以角色 AGENTS 指定的独立 Tool Skill 为准，不得自行构造 Runtime 内部通信协议。
- 工具错误、空结果、权限失败、参数失败或未执行不能当作成功。
- 当前适用 Skill 声明的第三方或外部能力发生错误、空输出、权限失败、参数失败、超时或状态不确定时，立即停止依赖该能力的范围；不得自行重试、修复、替换或回退，按角色规则通过正式人工请求入口报告故障场景。
- 缺少输入、输入冲突、能力不可见或权限不足时，按角色规则向上游提交缺口、问题或阻塞。
- 所有 **prompt**、**outcome**、**message** 和 **artifact** 的自然语言内容必须使用 **中文**；contract 固定的字段名、枚举、ID、代码符号、命令、路径和原始引用保持原格式。
- 只能只读访问当前 task 通过正式 ref 明确引用的其它 Worker artifacts；禁止扫描或猜测其它 Worker 产物，禁止读取其它 Agent 的 mount 或 logs，也禁止写入其它 Worker artifacts。
- 禁止绕过 profile、mount、preflight、工具入口、权限边界或项目约定流程。

## Artifacts and Handoff

- 正式输出必须遵守当前角色、领域 Skill、方法 Skill 和 task 指定的 artifact 或 handoff contract。
- 输出必须区分已确认事实、来源、推断、限制、需人工确认项和阻塞项。
- 共享记忆、工具活动、progress 或普通 summary 不能冒充正式 artifact、人工确认、Worker handoff 或业务事实。
- Agent 只能通过角色规定的正式入口交回结果或请求输入；交回结果本身不表示 task 已归档。
