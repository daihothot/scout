# Scout Runtime

你正在 Scout 为当前 Agent 生成的 Codex 原生 mount 中运行。

## Scout Context

- Scout Runtime 负责准备 run、Agent、mount、profile、能力资产和任务通信边界。
- 当前 Agent 的通用职责来自本文件，角色职责来自角色 `AGENTS.md`，领域行为和专项方法来自当前 profile phase 投影的 Skill。
- Runtime、角色规则和领域 Skill 各自拥有不同边界。

## Codex Agent Environment

- 当前工作目录是当前 Agent 的 mount root；资产、路径、权限和能力以当前 mount/profile 与实际查询结果为准。
- 被唤起后先读取通用规则、角色规则、当前 task 或 message 和可见上下文；需要 Scout Skill 时，按照下述协议发现或精确选择入口，并按依赖顺序读取。
- 使用 shell tool、MCP server、plugin、memory 或 artifact 位置前，先确认它在当前 mount 中可见并允许使用；Skill 可见性和读取权只由下述协议确认。

## Skill Selection Protocol

- Profile phase 和 mount 定义当前 Agent 的 Scout Skill 观察范围，不表示其中所有 Skill 都适用于当前 task，也不得一次性读取整个集合。
- 当前上下文已经明确给出完整 canonical leaf `family` 时，可以用完整 `family` 调用一次 `FindSkills`。Runtime 只会对当前 phase mount 中精确存在的 leaf 重新授权，并签发本 turn 的新 selection；不得复用历史 `selectionId`。
- 未知完整 leaf 时，调用 `FindSkills` 并省略 `family`；本次调用只用于取得 family 根节点，不能据此读取 Skill。
- 从本次 `FindSkills` 返回的直接子节点中选择一个与当前 task 直接相关的 token，在已确认的 `family` prefix 后只追加这一级，再调用 `FindSkills`。逐级发现时每次只能原样选择一个直接子节点，不得跳级、拼接、发明 token 或用自然语言改写节点。
- `detail` 默认使用 `names`，保持候选结果紧凑；仅当名称不足以判断且 family 已收窄到与当前 task 直接相关的范围时，才在该次 `FindSkills` 调用中使用 `detail: "metadata"`。metadata 只展示候选 Skill 的安全 frontmatter，不包含正文，也不授予资源读取权。
- 重复上述导航，直到 Runtime 明确返回叶节点的 `selectionId` 和 `loadOrder`。中间节点只用于导航；同一叶节点可以包含多个当前 phase 可见的入口 Skill。
- 如果返回 `reason: family_navigation_reset`，说明本 turn 没有可连续使用的 discovery；丢弃 `requestedFamily`，按返回的根 `facets` 从省略 `family` 的调用重新开始。
- 只有声明 `family` 的 Skill 可被直接导航。未声明 `family` 的服务层 Skill 不得单独搜索；Runtime 会按 `dependencies.skills.required` 递归纳入同一 selection，并生成 dependency-first `loadOrder`。
- `tags` 只是 Skill 的非路由特征，不参与 `FindSkills` 候选过滤、family 导航或 selection 生成；不得使用 tags 猜测或绕过 family 路径。
- `FindSkills` 到达叶节点后会返回 selection 的 dependency-first `loadOrder`、required/optional resource catalog 和完整性状态；`names` 返回资源路径，`metadata` 额外返回资源 description。
- 使用同一 `selectionId` 和 `ReadSkillResource` 读取各 Skill 的 `SKILL.md` 与全部 required resources。每个 Skill 的 `SKILL.md` 只等待它实际声明的 required Skill 的 `SKILL.md`，无依赖关系的 Skill 可以并行；某个 Skill 的 `SKILL.md` 读完后，它声明的 supplementary resources 可以并行读取。Runtime 只在全部 required 内容成功读取后把 selection 标记为 `ready`。
- optional resource 只在其 description、已读取的 `SKILL.md` 或当前 task 明确适用时读取；不得预读整个资源目录。资源中的 `scout.resource` 是 Runtime 控制元数据，生成 artifact 时不得复制。
- selection 未 `ready` 时不得开始新的 Skill discovery 或提交 task handoff。禁止用 shell、文件路径猜测、catalog 文件或 Codex 原生 Skill 入口绕过 `FindSkills` / `ReadSkillResource`。
- Selection 只服务当前 thread/turn 和当前 task scope；turn、phase 或 task 目标变化后必须取得新 selection，不得复用旧 `selectionId`。完整 canonical leaf 已知时可以直接重新选择，否则必须从 family 根节点逐级发现。
- family 树中没有合适入口、required dependency 不可用或资源读取失败时，不得以其它 Skill 猜测替代；按角色规则报告能力缺口或阻塞。

## Working Rules

- 写入持久文件前，必须确认当前 task 已授权该类写入，并确认目标在当前可写范围内。
- Dynamic Tool 只能按照当前工具提供的说明、参数结构、适用角色、返回结果和副作用语义使用；不得自行构造 Runtime 内部通信协议。
- 工具错误、空结果、权限失败、参数失败或未执行不能当作成功。
- 缺少输入、输入冲突、能力不可见或权限不足时，按角色规则向上游提交缺口、问题或阻塞。
- 所有 **prompt**、**outcome**、**message** 和 **artifact** 的自然语言内容必须使用 **中文**；contract 固定的字段名、枚举、ID、代码符号、命令、路径和原始引用保持原格式。
- 只能只读访问当前 task 通过正式 ref 明确引用的其它 Worker artifacts；禁止扫描或猜测其它 Worker 产物，禁止读取其它 Agent 的 mount 或 logs，也禁止写入其它 Worker artifacts。
- 禁止绕过 profile、mount、preflight、工具入口、权限边界或项目约定流程。

## Artifacts and Handoff

- 正式输出必须遵守当前角色、领域 Skill、方法 Skill 和 task 指定的 artifact 或 handoff contract。
- 输出必须区分已确认事实、来源、推断、限制、需人工确认项和阻塞项。
- 共享记忆、工具活动、progress 或普通 summary 不能冒充正式 artifact、人工确认、Worker handoff 或业务事实。
- Agent 只能通过角色规定的正式入口交回结果或请求输入；交回结果本身不表示 task 已归档。
