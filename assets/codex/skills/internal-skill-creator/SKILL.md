---
assetKind: scout.skill
name: internal-skill-creator
description: 创建或修改 Scout Skill 的统一方法论，覆盖 identity、phase、family 路由、tags 特征、依赖、模板索引、profile 挂载和共同边界。
id: internal-skill-creator
version: 0.6.0
phase: [coordinate, research, verify, validate]
family: [internal, skill-creator]
tags: [scout, skill, asset, template, governance]
devices: [any]
dependencies:
  shellTools:
    required: [scoutAssets]
    optional: [rg, find, sed, cat]
summary: 规范 Scout Skill 的 identity、family 路由、特征 metadata、依赖闭包、模板索引和挂载边界。
---

# Internal Skill Creator

当任务要求创建、修改、评审或规范化 `assets/codex/skills/**/SKILL.md` 时使用本技能。

本技能的目标是建立统一的 Scout Skill 系统：Scout Skill 负责沉淀方法论，Agent 负责读取并执行方法论，Asset Store / Runtime 负责 profile 挂载、mount、preflight 和运行记录。

## Skill Type

- type: internal
- structure_level: full
- note: 本技能属于 Internal Skill，拥有 Scout Skill 资产的创建与治理规则，不是某个领域 workflow 或工具操作 Skill。

## 核心边界

Scout Skill 是 Scout 管理、采用 Codex Skill 文件形态的按需资源。源文件固定在：

```text
assets/codex/skills/<skill-name>/SKILL.md
```

Runtime 只把 profile 授权的 Skill 物化到 `.scout/skills`，不放入 Codex 原生 `.agents/skills` 自动发现目录；Agent 必须通过动态筛选和受限读取入口加载正文。

它可以定义：

- 可复用的知识、contract、操作方法和责任边界。
- 用于 Runtime 初筛的 phase，用于入口导航的可选 family，以及不参与路由的 tags 特征。
- 由所选类型模板定义的输入、执行流程、输出和 enforcement rules。
- 产物模板、引用关系、证据要求和 provenance。
- Skill 与依赖、profile、mount 和 Runtime 的边界。

它不能定义：

- Runtime 事件实现、payload 包装或调度代码。
- 当前 run 的临时状态、真实设备 id、人工确认结果或工具调用结果。
- 未经归纳的外部知识原文、代码库源码、开发过程事实或外部资产。
- 让 Agent 绕过 profile、mount、preflight、artifact 或 evidence ref 的规则。

## 创建目录

新建 Scout Skill 时，目录名、frontmatter 的 `name` 和 `id` 必须完全一致：

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
- 使用当前稳定前缀表达责任边界：
  - `domain-<domain>-<role-or-capability>`：领域方法、角色入口或领域产物 contract。
  - `tool-<provider>-<capability>`：工具相关的方法和约束。
  - `signal-<signal>[-<implementation>]`：信号 contract 或信号实现。
  - `internal-<capability>`：Scout 内部资产和治理能力。
- 不为尚不存在的责任类别发明新前缀。
- 不使用空格、下划线、中文、版本号或一次性任务名。
- 不用过宽泛名称，例如 `helper`、`workflow`、`tools`。

除非任务明确需要脚本、参考材料或额外模板文件，否则只创建 `SKILL.md`。Scout Skill 的正文应优先保持自包含。

目录规则：

- `SKILL.md` 负责主方法论、阶段、规则和使用边界。
- `templates/` 负责 reusable artifact 形态、弱 schema、字段约束和输出布局。
- `references/` 负责较长的稳定说明、术语表、读取地图或工具背景，不承载当前 run 状态。
- 当 `templates/` 下超过一个文件时，必须创建 `templates/template-index.md`。
- 当 `references/` 下存在文件时，必须创建 `references/reference-index.md`。
- `templates/template-index.md` 和 `references/reference-index.md` 只做导航、用途说明和读取顺序；不得写业务事实、证据事实、运行状态或当前 task 判断。
- 不使用 `templates/index.md` 作为模板目录导航；`index.md` 允许作为业务产物名称，因此导航索引必须避开该文件名。

## 统一模板

创建新 Scout Skill 时，必须先读取：

```text
templates/template-index.md
```

`templates/template-index.md` 定义分类、选择条件、模板用途和读取顺序。类型差异、Inputs、执行流程、输出结构、enforcement rules 和分类必检项只存在于对应类型模板中。

## 通用骨架

所有 Scout Skill 使用以下共同骨架；存在差异化结构时，再按照 `templates/template-index.md` 选择对应类型模板补充正文：

```markdown
---
assetKind: scout.skill
name: <填写与目录名完全一致的 Skill identity>
description: <填写 Skill 做什么，以及什么任务会触发使用>
id: <填写与目录名完全一致的 Skill identity>
version: 0.1.0
phase: [<填写 Runtime 适用 phase>]
family: [<直接可路由时填写有序路径；dependency-only 时删除本行>]
tags: [<填写稳定特征 tag>]
devices: [any]
summary: <填写候选展示用短描述>
---

# <填写 Skill 标题>

当 <填写触发场景> 时使用本技能。

本技能的目标是 <填写可复用方法论目标>。

## Core Use

使用本技能处理：

- <填写职责边界>

不使用本技能处理：

- <填写非目标边界>
```

通用骨架规则：

- 必须替换全部填写说明，完成态 `SKILL.md` 不得残留 `<填写...>`。
- 类型模板只补充差异化正文，不重复定义通用 frontmatter 和 `Core Use`；没有差异化结构时只使用通用骨架。
- 不需要的可选 frontmatter 字段必须省略，不保留空 block。

Metadata 字段规则：

- `assetKind` 固定为 `scout.skill`。
- `name`、`id` 和目录名必须完全一致；三者共同表达一个 canonical Skill identity。
- `description` 必须包含使用场景，用于确认 family 叶节点返回的入口是否符合 task；它不能替代 phase 初筛或 family 导航。
- Skill 重命名时必须同时修改目录、`name`、`id` 和全部显式引用，不保留旧 identity alias。
- 后续只修改正文时不得改变 canonical Skill identity。
- `version` 使用语义版本；首次创建用 `0.1.0`。
- `phase` 是必填的非空 inline list，只允许 `coordinate`、`research`、`verify`、`validate`；它表示 Runtime 中可将本 Skill 作为候选读取的 Agent phase。
- `phase` 不表示正文是否拥有编号阶段，也不由 Skill 类型决定；生产、消费或审计本 Skill contract 的 phase 都必须列出。
- `family` 是可选的非空 inline list，表示 Agent 可从根节点逐级导航的唯一 canonical 入口路径；只有应被直接路由的入口 Skill 才能声明它。
- 未声明 `family` 的 Skill 是 dependency-only 服务层，不能被 `FindSkills` 直接导航；它必须通过入口 Skill 的 `dependencies.skills.required` 进入 selection closure。
- `tags` 是必填的非空 inline list，使用稳定、扁平的特征 token，不能写长句；它不参与 Runtime 路由、过滤或 selection 生成。
- `devices` 没有明确设备限制时使用 `[any]`。
- `dependencies` 只在存在 Scout Skill、shell tool、MCP server 或 plugin 依赖时出现。
- `summary` 面向候选列表，必须短于正文标题。

Dependencies 规则：

- 没有任何依赖时，省略整个 `dependencies` 字段。
- 某一类没有依赖时，省略该类，例如没有 plugin 依赖就不写 `plugins`。
- `required` 或 `optional` 为空时，省略该字段。
- `skills` 使用 `assets/codex/skills/<name>` 的真实目录名。
- `shellTools` 使用 `assets/codex/tools/shell-tools.json` 中的真实 tool id。
- `mcpServers` 使用 `assets/codex/mcp/servers.json` 中的真实 server id。
- `plugins` 使用 `assets/codex/plugins/**/.codex-plugin/plugin.json` 中的真实 plugin name。
- `required` 表示缺失时该 Skill 不应被认为可完整执行。
- `optional` 表示可增强能力、可诊断能力或有条件 fallback；使用前仍必须通过当前 mount 能力查询确认。
- Runtime 导航到 family 叶节点后，将该叶节点下当前 profile 授权的入口 Skill 纳入 selection，再按 `dependencies.skills.required` 递归形成 closure，并以 dependency-first `loadOrder` 交给 Agent。
- required Skill 必须由同一 profile 授权且存在于当前 mount；不得通过依赖声明扩大 profile 能力边界。
- required Skill 的 `phase` 必须覆盖消费方的全部 `phase`。required Skill 不需要声明 `family`，也不继承消费方的 family 路径。

## Family 与 Tags 规范

`family` 是 Runtime 唯一的 Skill 路由信息源。Agent 只能从 `FindSkills` 返回的直接子节点中选择一个 token，每次只在已确认 prefix 后追加一级，直到叶节点。

Family 规则：

- 路径使用小写 kebab-case token，不写展示文本、长句、空格或一次性任务名。
- 第一级直接表达业务 domain 或 Scout 内部责任，例如 `validation`、`cyber-attack`、`market` 或 `internal`；不添加虚构的 `domain` 前缀。
- 后续层级只表达稳定的业务导航路径，例如 `[validation, signal, unity-runtime-log]`。
- 一个入口 Skill 只有一条 canonical family path；多个入口 Skill 可以共享同一叶节点。
- 工具、MCP server、plugin、通用研究包等服务层不为了可发现性声明 family；由入口 Skill 的 required dependencies 带入。
- family 重命名是路由 contract 变更，必须同步更新所有显式约束，不保留 alias。

`tags` 只是面向 format、catalog 和审查的稳定特征 metadata，不是 Agent 搜索词或 family 的备用索引。每个 token 应独立表达可复用的主题、对象或能力。

Tag catalog：

- 系统与领域：`scout`、`validation`、`guru`、`jarvis`、`unity`。
- 资产与业务对象：`skill`、`asset`、`template`、`knowledge`、`capability`、`codebase`、`signal`、`contract`、`boundary`、`memory`、`bdd`、`pack`、`manual`、`gate`。
- 证据与检查：`evidence`、`source`、`audit`、`replay`、`codegraph`。
- 信号与存储：`runtime`、`log`、`callback`、`event`、`local-storage`、`sqlite`。
- 执行与设备：`pipeline`、`cli`、`shell-tool`、`automation`、`editor`、`desktop`、`player`、`mcp`、`plugin`。
- 工作语义：`research`、`verification`、`workflow`、`governance`、`coordination`。

优先复用 catalog 和当前仓库已经存在的稳定 tag。新增 tag 必须表达可复用的系统域、责任或能力，不能用于影响 Skill 路由或命中率。

禁止：

- 用句子当 tag。
- 用一次性业务名、issue id、task id、run id 当 tag。
- 用同义词堆叠，例如同时写 `verify`、`verification`、`validate` 表达同一件事。
- 仅为了复制 `phase` 或 `family` 值而添加 tag；相同 token 必须同时表达 Skill 的真实主题或责任。
- 为当前任务临时发明无法复用的 tag。

如果没有现成 tag，先在正文 `keywords` 风格的说明中表达，不要把不稳定词写入 `tags`。

## 通用术语

- 使用 `上游` 表示当前 task 的请求来源、Coordinator、上层 Skill 或人工输入来源。
- 使用 `需人工确认项` 表示缺少版本、repo、业务边界或用户画像等必须确认的信息。
- 使用 `阻塞项` 表示缺少能力、工具不可用、权限不足、输入不可唯一定位或证据链无法继续。
- 不使用不一致的中英混杂状态词；统一写 `上游`、`需人工确认项`、`阻塞项`。
- 动态能力、仓库、工具、MCP server、plugin、profile 可见性必须以当前 mount 查询或当前工具输出为准；不得写非当前输出列表。

## 使用流程

创建或修改 Scout Skill 时按这个流程执行：

1. 读取现有 `assets/codex/skills/*/SKILL.md`，确认当前风格、metadata 和命名。
2. 读取 `assets/codex/agents/agent-profiles.json`，确认这个 Skill 是否需要被某个 profile 默认挂载。
3. 确认任务目标适合沉淀为 Scout Skill，而不是 AGENTS 通用规则、可执行工具、plugin、外部资产或未经归纳的知识原文。
4. 读取 `templates/template-index.md`；存在差异化结构时，按实际责任选择且只选择一个类型模板。
5. 使用本 Skill 的通用骨架和适用的类型模板创建或更新 `assets/codex/skills/<skill-name>/SKILL.md`。
6. 按 Runtime 适用性填写非空 `phase` 和特征 `tags`；只有直接可路由入口填写有序 `family`，dependency-only 服务层必须省略它。
7. 按依赖规则填写 `dependencies`，只引用当前资产源中真实存在的 skill、shell tool、MCP server 或 plugin。
8. 如果需要让 Agent 默认可见，单独修改对应 profile 的 `skills` 列表，并检查该 profile phase 与 Skill `phase` 相容。
9. 完成通用验证；选择了类型模板时，再执行该模板中的必检项。

## 使用场景

适合创建 Scout Skill 的场景：

- 已经形成稳定、可复用的知识、contract、操作方法或责任边界。
- 同一能力会在多个任务中重复使用，需要统一输入、流程、输出或规则。
- Agent 需要通过 profile 稳定获得这项能力，而不是依赖一次性 prompt。

不适合创建 Scout Skill 的场景：

- 只服务一次 task 的临时说明。
- Runtime 事件、状态机、mailbox、内部通信协议或调度实现。
- 需要写代码实现的 shell tool、MCP server 或 plugin。
- 还没有经过归纳的知识库原文、源码片段、聊天记录或开发过程事实。
- 需要用户确认的业务判断或产品决策。

## Profile 挂载规则

Scout Skill 源目录存在，不代表当前 Agent 可使用。

如果任务要求某个 Agent 获得该 Skill 的访问授权，必须修改：

```text
assets/codex/agents/agent-profiles.json
```

规则：

- 先读取当前 profile 的真实责任和能力边界，不根据 Skill 名称或预设类别推断挂载目标。
- 只挂载到实际需要该 Skill 的 profile；跨 profile 挂载必须具有相同的可复用责任。
- Profile 只定义可访问集合，不表示其中所有 Skill 都应进入当前 task；Agent 必须先按 phase 初筛，再从 family 根节点每次导航一级。
- Profile 挂载的每个无 `family` Skill，必须能在该 profile 适用的某个入口 Skill required dependency closure 中到达；否则它是无法读取的悬空挂载。
- Skill 可以存在但未挂载；未挂载表示不会进入任何 profile 的授权集合，除非 Runtime 或某个 profile 显式挂载。
- 新建 Skill 不自动修改 profile；只有任务明确要求对应 Agent 可访问时才更新 `agent-profiles.json`。

修改 profile 后必须确认 `skills` 中的名字与目录名一致。

## 验证清单

- 目录存在：`assets/codex/skills/<skill-name>/SKILL.md`。
- `name`、`id` 和目录名完全一致。
- `assetKind` 是 `scout.skill`。
- canonical Skill identity 没有和其它 Skill 重复。
- `phase` 是非空 inline list，值属于 Runtime phase 枚举，并覆盖所有合法生产、消费和审计场景；它不表示正文阶段顺序。
- 直接可路由入口拥有唯一非空有序 `family`，每级是小写 kebab-case；dependency-only 服务层不存在 `family`。
- `tags` 是扁平稳定的非路由特征 token。
- `devices` 明确，通常是 `[any]`。
- 非空 `dependencies` 引用都能在当前资产源中定位；没有依赖时不写空 block。
- required Skill 依赖能够在同一 profile 授权集合中形成无环 selection closure，并覆盖消费方的全部 phase。
- 每个 profile/phase 中挂载的 dependency-only Skill 都可从至少一个直接可路由入口的 required dependency closure 到达。
- 正文包含明确的触发场景、目标、职责和非目标。
- 存在差异化结构时，已按照 `templates/template-index.md` 选择唯一类型模板并完成其必检项。
- 完成态 `SKILL.md` 不存在模板填写说明或无说明的空字段。
- `templates/` 多于一个文件时存在 `templates/template-index.md`；`references/` 存在文件时存在 `references/reference-index.md`。
- template / reference index 只做导航和读取顺序，不承载业务事实、证据事实、运行状态或当前 task 判断。
- 没有写入 Runtime 实现细节、当前 run 临时状态或未经归纳的外部事实。
- 如果修改 profile，profile 引用的 skill 名称能在 `assets/codex/skills/` 中找到，且该 profile 的 Runtime phase 包含在 Skill `phase` 中。

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
