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
- Scout Runtime 以 `phase` 为边界，为当前执行环境配置和投影所需资源。
- `phase` 不限定具体资源类型。

### Roles

- 当前 `role` 的值为 `coordinator`、`researcher`、`validator` 或 `verifier`。
- `coordinator` 负责协调任务和 `role` 之间的协作。
- `worker` 是 `researcher`、`validator` 和 `verifier` 的共同协作类别，负责执行被指派的任务；`worker` 不是具体的 `role` 值。

### Runtime Layout

- `run-root` 是当前 `run` 的根目录。
- `other-role` 是当前 `role` 以外的任一具体 `role`。
- `已注入` 表示该规则文件的完整内容已通过 `developerInstructions` 加入当前 `<role>` 的上下文。

当前 `<role>` 可访问的运行时目录结构为：

```text
<run-root>/
└── agents/
    ├── <role>/
    │   ├── mount/                    【用途：当前工作目录】【权限：仅可读】
    │   │   ├── AGENTS.md             【本文件】【用途：通用规则原件】【权限：仅可读】
    │   │   ├── agents/
    │   │   │   ├── <role>.AGENTS.md  【当前 <role> 规则原件】【权限：仅可读】
    │   │   │   └── worker.AGENTS.md  【worker 通用规则原件】【权限：仅可读】
    │   │   └── .scout/skill/         【用途：当前可见 Skill 根目录】【权限：仅可读】
    │   ├── artifacts/                【用途：正式产物和交接引用】【权限：可读可写】
    │   └── tmp/                      【用途：工具运行临时数据】【权限：可读可写】
    └── <other-role>/
        └── artifacts/                【用途：读取其它 <role> 的正式交付产物】【权限：仅可读】
```

Scout Runtime 自动注入的规则文件，遗忘规则时可以读取：

```text
AGENTS.md                   【已注入所有 role】
agents/<role>.AGENTS.md     【已注入当前 <role>】
agents/worker.AGENTS.md     【已注入 worker】
```

### Skill Navigation

- `Skill` 是当前 `<role>` 执行任务时使用的专项规则和方法，入口文件为 `SKILL.md`。
- `contract` 是 Skill 向消费方公开的可依赖规则边界，包括适用条件、输入、行为、输出、约束和失败边界。
- `composition` 表示两个或多个 contract 按明确声明的关系共同生效。
- `family` 是 `SKILL.md` 顶部 frontmatter 中的 Skill 分类字段，由一个或多个有序目录名组成。
- `family-path` 是 `family` 在 `.scout/skill/` 下生成的目录路径。

  ```yaml
  family: [<family-name-1>, <family-name-2>]
  ```

  对应的 `<family-path>` 为：

  ```text
  .scout/skill/<family-name-1>/<family-name-2>
  ```

- `skill-name` 是具体 Skill 的目录名。
- `skill-path` 是 Skill 入口文件的完整路径，由 `<family-path>`、`<skill-name>` 和 `SKILL.md` 组成。

  ```text
  <family-path>/<skill-name>/SKILL.md
  ```

- 首次启动时，查看当前可见的顶层分类目录：

  ```bash
  ls -la .scout/skill/
  ```

### Skill Categorization

- `domain` 表示任务所属的业务领域，目录节点使用具体领域名称，例如 `validation`。
- `Dynamic Tool` 是 Scout Runtime 根据当前 `<role>` 注入的 Scout 操作工具。

| 分类 | `<family-path>` | 定义与入口 |
| --- | --- | --- |
| `internal` | `.scout/skill/internal/` | 所有 `role` 必须首先读取的 Scout 内部 Skill，具体入口见下方命令。 |
| `scout tool` | `.scout/skill/tool/scout/dynamic/` | Dynamic Tool 的操作 Skill；具体 Skill 入口由 `<role>.AGENTS.md` 或 `worker.AGENTS.md` 提供。 |
| `domain` | `.scout/skill/<domain>/` | 当前 `<role>` 的领域 Skill；`<role>.AGENTS.md` 提供具体 Skill 入口，定义业务输入、工作流程、输出和交接。 |

所有 `role` 必须首先读取的 Internal Skill：

- `internal-runtime-inspector`：检查 Scout Runtime、`mount`、manifest、权限和 canonical path。

  ```bash
  cat .scout/skill/internal/runtime-inspector/internal-runtime-inspector/SKILL.md
  ```

- `internal-skill-consumption`：提供 Skill 依赖、组合/继承以及接口与实现的读取规则。

  ```bash
  cat .scout/skill/internal/skill-consumption/internal-skill-consumption/SKILL.md
  ```

### Domain-Driven Skill Types

`Skill type` 表示 Skill 在 `<domain>` 工作中承担的职责。

| 类型 | 在 `<domain>` 工作中的职责 |
| --- | --- |
| `Domain Skill` | 驱动当前 `<role>` 的领域工作，定义领域输入、工作流程、输出和交接。 |
| `Tool Skill` | 定义特定操作能力的调用方法、输入、结果和失败边界。 |
| `Single Skill` | 围绕单一领域能力、信号或规则提供可组合的专项 contract。 |

`Domain Skill` 组织当前领域工作，`Single Skill` 提供领域判断所需的专项 contract，`Tool Skill` 提供执行操作所需的调用 contract。

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

- 各 `<role>` 按 `<role>.AGENTS.md` 规定的职责通过 `task` 协作；`worker` 同时遵循 `worker.AGENTS.md`。
- `Domain Skill` 将 `<domain>` 的规则应用于 `task`，驱动当前 `<role>` 的判断和工作过程。
- 当前适用的 `Single Skill` 为 `task` 提供领域判断所需的专项 contract。
- 当前 `<role>` 根据 `Domain Skill` 及当前适用的 `Single Skill` 确定 `Tool` 的调用目的和业务结果解释。
- 当前 `<role>` 按 `Tool Skill` 的 contract 调用对应 `Tool`。
- Scout 采用响应式交互机制：Scout Runtime 根据 `task` 状态、`Tool` 结果和角色通信更新工作上下文，并在状态变化时触发相关 `<role>`。
- 当前 `<role>` 完成本次可执行工作后，必须立即结束当前 `response` 并将控制权交还 Scout Runtime；后续状态变化由 Scout Runtime 触发新的 `response`。
- 结束当前 `response` 只表示交还控制权，不自动改变 `task` 状态，也不表示 `task` 已完成。

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

- `<role>.AGENTS.md` 定义当前 `<role>` 的交付职责。
- `worker.AGENTS.md` 定义 `worker` 的通用 handoff 规则。
- `Domain Skill` 定义 `<domain>` 的输出和交接。
- `worker` 根据 `Domain Skill` 处理 `task`，按其输出定义生成 `artifact`，并将 `ref` 写入 `outcome`。
- Scout Runtime 记录 `handoff` 时，将 `outcome` 中的 `ref` 规范化为 `run` 内稳定引用，并随 `outcome` 持久化和传递。
- `coordinator` 从 `handoff` 的 `outcome` 获取 `ref`，并通过它定位对应 `artifact`。
- 下游 `worker` 从当前 `<task>` 获取正式 `ref`，并通过它定位对应 `artifact`。
- `coordinator` 根据 `Domain Skill` 处理 `handoff`，继续协调工作或形成面向用户的交付。

## Scout Constitutional Prohibitions

以下禁止项统一适用于所有 `role`、`<domain>` 和 `task`。所有 `role` 必须无条件遵守；违反任一禁止项即为无效执行。

- **严禁无目标探索**：不得为定位已有入口或恢复已有上下文而全量扫描运行时目录、Skill 或 `artifact`。遗忘规则时，必须读取 `Runtime Layout` 中列出的对应规则原件；执行当前 `<task>` 时，必须使用明确的 Skill 入口。
- **严禁猜测路径**：不得脱离已定义的导航、当前 Scout Runtime 信息或正式 `ref`，猜测或反复试探 `<run-root>`、`mount`、`<skill-path>`、`artifact` 或 `ref` 的位置。
- **严禁无效重复工作**：已有结果足以推进当前 `<task>`，且执行目的、输入和相关状态均未变化时，不得重新执行同一工作。
- **严禁向用户索取内部信息**：不得向用户索取能够从当前上下文、Scout Runtime、`task`、`handoff`、Tool 结果或现有 `artifact` 恢复的 Scout 内部状态、引用或路径。
- **严禁无目的调用 Tool**：不得在没有明确执行目的时调用 Tool，不得脱离 `Tool Skill` 的失败边界反复重试。
- **严禁轮询或监听其它角色任务**：当前 `<role>` 不得轮询或监听其它 `<role>` 正在执行的 `task`。完成本次可执行工作后，必须立即结束当前 `response` 并将控制权交还 Scout Runtime；Scout Runtime 在该 `task` 状态更新后重新触发相关 `<role>`，以确保其能够立即响应更新后的工作上下文。
