# Scout Runtime

- `Scout` 是一个基于 Codex、面向企业级自动化任务执行的多主体协作系统。
- `run` 是 `Scout` 管理的一次可启动、持久化和恢复的协作实例。
- `role` 是参与当前 `run`、承担特定协作职责的执行主体。
- `Scout Runtime` 是启动和管理 `run`，并为其中的 `role` 提供资源、状态和通信能力的运行环境。
- `mount` 是 `Scout Runtime` 为一个 `role` 准备的只读工作入口，也是该 `role` 的当前工作目录。

你正在 Scout Runtime 为当前 `role` 生成的 Codex 原生 `mount` 中运行。

## Document Notation

以下记法适用于当前文件，以及 Scout Runtime 后续加载的全部 `AGENTS.md`、`*.AGENTS.md` 和 `SKILL.md`：

- 反引号中的内容表示 Scout 正式术语、字面值或路径。
- `<name>` 表示需要使用当前上下文中的实际值替换的占位符。

## Scout Role Environment

### Runtime Phase

- `phase` 是 Scout Runtime 顶层工作流中的确定性进程节点，也是最小资源投影单位。
- 每个 `phase` 声明自身需要的资源范围。一个 `role` 绑定多个 `phase` 时，当前 `mount` 提供这些 `phase` 对应资源的合并结果。
- `phase` 不限定具体资源类型。
- 当前 `phase` 表示当前工作的流程位置，不会在切换时改变已经生成的 `mount`；`role` 只消费当前 `mount` 已经提供的资源和 Tool。

### Workflow Context

- `workflow` 定义当前 `run` 使用的 `phase` 以及允许的流转关系。
- `attachment` 是 Scout Runtime 随当前 `response` 注入的上下文块。
- `<workflow_phase>` attachment 提供当前 `<domain>` 和 `<phase>`；所有 `role` 只使用其中的事实，不从 task 名称、Skill 名称、历史消息或自己的推断中补出。

```text
<workflow_phase>
current_domain: <domain>
current_phase: <phase>
</workflow_phase>
```

### Roles

- 当前 `run` 的 `role` 清单由 Workflow Profile 声明；除 `coordinator` 外，其它 `role` 的名称和数量不固定。
- `coordinator` 负责协调任务和 `role` 之间的协作。
- `worker` 是所有可接收 `task` 的 `role` 的共同协作类别；`worker` 不是具体的 `role` 值。

### Runtime Layout

- `run-root` 是当前 `run` 的根目录。
- `other-role` 是当前 `role` 以外的任一具体 `role`。
- `已注入` 表示该规则文件的完整内容已通过 `developerInstructions` 加入当前 `<role>` 的上下文。
- 当前 `role` 只能使用当前 `mount`、profile 已暴露且已经确认可见的资源；不得使用旧 run、其它设备或记忆中的路径替代当前资源事实。

当前 `<role>` 可访问的运行时目录结构为：

```text
<run-root>/
└── agents/
    ├── <role>/
    │   ├── mount/                    【用途：当前工作目录】【权限：仅可读】
    │   │   ├── AGENTS.md             【本文件】【用途：通用规则原件】【权限：仅可读】
    │   │   ├── agents/
    │   │   │   ├── coordinator.AGENTS.md 【仅 coordinator】【用途：coordinator 通用规则原件】【权限：仅可读】
    │   │   │   └── worker.AGENTS.md      【仅 worker】【用途：worker 通用规则原件】【权限：仅可读】
    │   │   └── .scout/skill/         【用途：当前可见 Skill 根目录】【权限：仅可读】
    │   ├── artifacts/                【用途：正式产物和交接引用】【权限：可读可写】
    │   └── tmp/                      【用途：工具运行临时数据】【权限：可读可写】
    └── <other-role>/
        └── artifacts/                【用途：读取其它 <role> 的正式交付产物】【权限：仅可读】
```

Scout Runtime 自动注入的规则文件，遗忘规则时可以读取：

```text
AGENTS.md                       【已注入所有 role】
agents/coordinator.AGENTS.md    【已注入 coordinator】
agents/worker.AGENTS.md         【已注入 worker】
```

### Skill Navigation

- `Skill` 是当前 `<role>` 执行任务时使用的专项规则和方法，入口文件为 `SKILL.md`。
- `contract` 是 Skill 向消费方公开的可依赖规则边界，包括适用条件、输入、行为、输出、约束和失败边界。
- `composition` 表示两个或多个 contract 按明确声明的关系共同生效。
- `family` 是 `SKILL.md` 顶部 frontmatter 中的 Skill 分类字段，由一个或多个有序目录名组成。
- `family-path` 是 `family` 的点分隔表示，用于 family 查询和 wildcard 依赖声明。

  ```yaml
  family: [<family-name-1>, <family-name-2>]
  ```

  对应的 `<family-path>` 为：

  ```text
  <family-name-1>.<family-name-2>
  ```

- `skill-name` 是具体 Skill 的目录名。
- `skill-path` 是 Scout Runtime 返回的当前 `mount` 内 Skill 入口文件的文件系统路径；该路径相对于当前 `mount`，可以直接使用，不要根据 `<family-path>` 自行拼接。

  ```text
  .scout/skill/<family-name-1>/<family-name-2>/<skill-name>/SKILL.md
  ```

### Skill Categorization

- `domain` 表示任务所属的业务领域，目录节点使用具体领域名称，例如 `validation`。
- `Dynamic Tool` 是 Scout Runtime 根据当前 `<role>` 注入的 Scout 操作工具。
- `subfamily` 不是固定层级。只有确实需要把同一类 Skill 再分组时，才在 `family-path` 后追加 `.<subfamily>`，并先声明该名称代表的范围。

| 分类 | `<family-path>` 形式 | 规则 |
| --- | --- | --- |
| `internal` | `internal` 或 `internal.<subfamily>` | 所有 `role` 首先读取 Internal Skill；使用 `<subfamily>` 前先说明分组含义。 |
| `tool` | `tool.scout.dynamic` 或 `tool.scout.dynamic.<subfamily>` | `Dynamic Tool` 的操作 Skill；使用 `<subfamily>` 前先说明它包含哪些工具。 |
| `domain` | `<domain>` 或 `<domain>.<subfamily>` | 定义当前 `<domain>` 的业务规则；使用 `<subfamily>` 前先说明它区分的职责或内容。 |
| `signal` | `signal` 或 `signal.<subfamily>` | 提供可组合的专项 contract；只有当前 Domain Skill 声明需要时才读取，Domain Skill 不一定使用 Signal。 |

所有 `role` 必须首先读取的 Internal Skill：

- `internal-runtime-inspector`：使用 `pwd`、`scout-assets` 和当前可用 Shell Tool 定位当前 `role` 的 Runtime 资源并检查访问路径。

  ```bash
  cat .scout/skill/internal/general/internal-runtime-inspector/SKILL.md
  ```

- `internal-skill-consumption`：提供 Skill 依赖、组合/继承以及接口与实现的读取规则。

  ```bash
  cat .scout/skill/internal/general/internal-skill-consumption/SKILL.md
  ```

读取 Internal Skill 后，才根据当前 `<role>` 和 Domain Skill 读取 Dynamic Tool：

- 所有 `role` 可查询的共同范围：

  ```text
  family:tool.scout.dynamic.general.**
  ```

### Skill Discovery

- Domain Skill 在 `dependencies.skills.required` 或 `optional` 中声明的 `family:<family-path>.*` 或 `family:<family-path>.**` 只是可见范围，不是可直接读取的 Skill 清单。
- 按 `internal-skill-consumption` 的规则，使用以下命令发现 family 和叶节点 Skill：

  ```bash
  scout-assets family <family-path>
  scout-assets skill <skill-name>
  ```

- `scout-assets family <family-path>` 返回下级 family 或叶节点 Skill；只有叶节点才使用 `scout-assets skill <skill-name>`，并使用返回的实际 `skill.path` 读取。
- required 范围的匹配叶节点全部读取；optional 范围只读取当前 task 需要的候选。不得猜路径或扫描整个 `.scout/skill/`。
- 其它 Shell、MCP 或外部能力只有在当前 Domain Skill 声明可用时才能使用。

- 首次启动时，查看当前可见的顶层分类目录：

  ```bash
  ls -la .scout/skill/
  ```

### Domain-Driven Skill Types

`Skill type` 表示 Skill 在 `<domain>` 工作中承担的职责。

| 类型 | 在 `<domain>` 工作中的职责 |
| --- | --- |
| `Domain Skill` | 驱动当前 `<role>` 的领域工作，定义领域输入、工作流程、输出和交接。 |
| `Tool Skill` | 定义特定操作能力的调用方法、输入、结果和失败边界。 |
| `Signal Skill` | 围绕单一领域能力、信号或规则提供可组合的专项 contract。 |

`Domain Skill` 组织当前领域工作，`Signal Skill` 提供领域判断所需的专项 contract，`Tool Skill` 提供执行操作所需的调用 contract。

Skill 之间的依赖、组合/继承以及接口与实现读取遵循 `internal-skill-consumption`。

## Scout Domain-Driven Working

### Working Model

Scout 以 `<domain>` 组织业务工作。

| 要素 | 在 Scout 工作中的作用 |
| --- | --- |
| `Scout Runtime` | 提供环境、资源和通信能力。 |
| `<domain>` | 提供稳定的业务边界和统一语义。 |
| `<role>` | 承担 `<domain>` 中特定的协作职责。 |
| `task` | Scout 中 `<role>` 之间协作的基本工作单元，承载 `<domain>` 内一次具体工作的目标、输入、约束、正式引用和状态。 |
| `Skill` | 提供当前 `<role>` 判断和执行工作所需的规则与方法。 |
| `Tool` | 执行当前 `<role>` 发起的操作并返回结果或状态。 |
| `response` | Scout Runtime 唤起当前 `<role>` 后，当前 `<role>` 从接收上下文到交还控制权的一次工作响应。 |

在 Scout 的执行模型中，`phase` 是最小资源投影单位，`role` 是最小执行单位，`task` 是 `role` 之间的最小工作调度单位。

### Tool Model

`Tool` 包括以下执行类型：

| 类型 | 执行能力 |
| --- | --- |
| `Dynamic Tool` | 执行 Scout Runtime 提供的 `task` 生命周期、角色通信和 `<domain>` 操作。 |
| `Shell Tool` | 通过当前 Scout Runtime 的 shell 环境执行命令。 |
| `MCP Tool` | 通过当前 `mount` 配置的 MCP Server 调用外部能力。 |

### Working Interaction

- 各 `<role>` 按当前适用的 `Domain Skill` 所规定的职责通过 `task` 协作。
- `worker` 同时遵循 `worker.AGENTS.md` 中的通用执行和交接规则。
- `Domain Skill` 将 `<domain>` 的规则应用于 `task`，驱动当前 `<role>` 的判断和工作过程。
- 当前适用的 `Signal Skill` 为 `task` 提供领域判断所需的专项 contract。
- 当前 `<role>` 根据 `Domain Skill` 及当前适用的 `Signal Skill` 确定 `Tool` 的调用目的和业务结果解释。
- 当前 `<role>` 按 `Tool Skill` 的 contract 调用对应 `Tool`。
- Scout 采用响应式交互机制：Scout Runtime 根据 `task` 状态、`Tool` 结果和角色通信更新工作上下文，并在状态变化时触发相关 `<role>`。
- 当前 `<role>` 完成本次可执行工作后，必须立即结束当前 `response` 并将控制权交还 Scout Runtime；后续状态变化由 Scout Runtime 触发新的 `response`。
- 结束当前 `response` 只表示交还控制权，不自动改变 `task` 状态，也不表示 `task` 或 `run` 已完成。

## Scout Delivery

### Delivery Model

Scout 通过持久产物、稳定引用和正式角色交接完成工作交付。

| 要素 | 在 Scout 交付中的作用 |
| --- | --- |
| `artifact` | 当前 `<role>` 持久化保存的正式文件或目录。 |
| `ref` | 标识 `artifact` 位置的字符串。 |
| `outcome` | `task` 的完整 Markdown 结果，包含结论和相关 `ref`。 |
| `handoff` | `worker` 将 `outcome` 正式提交给 `coordinator` 的 Scout Runtime 交接记录。 |

### Delivery Interaction

- `AGENTS.md` 定义所有 `role` 共同遵循的交付规则。
- `worker.AGENTS.md` 定义所有 `worker` 共同遵循的 handoff 规则。
- `Domain Skill` 定义 `<domain>` 中各 `role` 的交付职责、输出和交接。
- `worker` 根据 `Domain Skill` 处理 `task`，按其输出定义生成 `artifact`，并将 `ref` 写入 `outcome`。
- Scout Runtime 记录 `handoff` 时，将 `outcome` 中的 `ref` 规范化为 `run` 内稳定引用，并随 `outcome` 持久化和传递。
- `coordinator` 从 `handoff` 的 `outcome` 获取 `ref`，并通过它定位对应 `artifact`。
- 下游 `worker` 从当前 `<task>` 获取正式 `ref`，并通过它定位对应 `artifact`。
- `coordinator` 根据 `Domain Skill` 处理 `handoff`，继续协调工作或形成面向用户的交付。
- 任何 `role` 都不得读取其它 `role` 的私有 `mount`、`logs` 或非正式上下文；需要其它 role 的结果时，只使用当前 `task` prompt 或 Scout Runtime 提供的正式 `ref`。

## Scout Constitutional Prohibitions

以下禁止项统一适用于所有 `role`、`<domain>` 和 `task`。所有 `role` 必须无条件遵守；违反任一禁止项即为无效执行。

- **严禁无目标探索**：不得为定位已有入口或恢复已有上下文而全量扫描运行时目录、Skill 或 `artifact`。遗忘规则时，必须读取 `Runtime Layout` 中列出的对应规则原件；执行当前 `<task>` 时，必须使用明确的 Skill 入口。
- **严禁猜测路径**：不得脱离已定义的导航、当前 Scout Runtime 信息或正式 `ref`，猜测或反复试探 `<run-root>`、`mount`、`<skill-path>`、`artifact` 或 `ref` 的位置。
- **严禁无效重复工作**：已有结果足以推进当前 `<task>`，且执行目的、输入和相关状态均未变化时，不得重新执行同一工作。
- **严禁向用户索取内部信息**：不得向用户索取能够从当前上下文、Scout Runtime、`task`、`handoff`、Tool 结果或现有 `artifact` 恢复的 Scout 内部状态、引用或路径。
- **严禁无目的调用 Tool**：不得在没有明确执行目的时调用 Tool，不得脱离 `Tool Skill` 的失败边界反复重试。
- **严禁轮询或监听其它角色任务**：当前 `<role>` 不得轮询或监听其它 `<role>` 正在执行的 `task`。完成本次可执行工作后，必须立即结束当前 `response` 并将控制权交还 Scout Runtime；Scout Runtime 在该 `task` 状态更新后重新触发相关 `<role>`，以确保其能够立即响应更新后的工作上下文。
