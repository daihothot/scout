# Scout Runtime

你正在 Scout 为当前 Agent 生成的 Codex 原生 mount 中运行。

## Scout Agent Environment

### Agent Roles

- `role` 表示当前 Agent 在 Runtime 中承担的角色。
- `coordinator` 负责协调任务和 Agent 协作。
- `worker` 负责执行被指派的任务；`researcher`、`validator`、`verifier` 属于 `worker` 角色。

### Runtime Layout

- `run-root` 是当前 run 的根目录。
- `other-role` 是当前 `role` 以外的任一 role。
- `已注入` 表示该规则文件的完整内容已通过 `developerInstructions` 加入当前 `<role>` 的上下文。

Agent 可访问的运行时目录结构为：

```text
<run-root>/
└── agents/
    ├── <role>/
    │   ├── mount/                    【用途：当前工作目录】【权限：仅可读】
    │   │   ├── AGENTS.md             【本文件】【用途：通用规则原件】【权限：仅可读】
    │   │   ├── agents/
    │   │   │   ├── <role>.AGENTS.md  【所有角色规则原件】【权限：仅可读】
    │   │   │   └── worker.AGENTS.md  【<worker> 通用规则原件】【权限：仅可读】
    │   │   └── .scout/skill/         【用途：当前可见 Skill 根目录】【权限：仅可读】
    │   ├── artifacts/                【用途：正式产物和交接引用】【权限：可读可写】
    │   └── tmp/                      【用途：工具运行临时数据】【权限：可读可写】
    └── <other-role>/
        └── artifacts/                【用途：读取正式 ref 指向的 handoff 产物】【权限：仅可读】
```

Runtime 自动注入的规则文件，遗忘规则时可以读取：

```text
AGENTS.md                   【已注入所有 <role>】
agents/<role>.AGENTS.md     【已注入所有 <role>】
agents/worker.AGENTS.md     【已注入 <worker>】
```

### Skill Navigation

- `Skill` 是 Agent 执行任务时使用的专项规则和方法，入口文件为 `SKILL.md`。
- `family` 是由一个或多个有序目录名组成的 Skill 分类路径。
- `family-path` 是 `family` 在 `.scout/skill/` 下生成的目录路径。

  ```yaml
  family: [family1, family2]
  ```

  对应的 `<family-path>` 为：

  ```text
  .scout/skill/family1/family2
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
- `Dynamic Tool` 是 Runtime 根据当前 `<role>` 注入的 Scout 操作工具。

| 分类 | `<family-path>` | 定义与入口 |
| --- | --- | --- |
| `internal` | `.scout/skill/internal/` | 所有 `<role>` 必须首先读取的 Scout 内部 Skill，具体入口见下方命令。 |
| `scout tool` | `.scout/skill/tool/scout/dynamic/` | Dynamic Tool 的操作 Skill；具体 Skill 入口由 `<role>.AGENTS.md` 或 `worker.AGENTS.md` 提供。 |
| `domain` | `.scout/skill/<domain>/` | 当前 `<role>` 的领域 Skill；`<role>.AGENTS.md` 提供具体 Skill 入口，定义业务输入、工作流程、输出和交接。 |

所有 `<role>` 必须首先读取的 Internal Skill：

- `internal-runtime-inspector`：检查 Runtime、mount、manifest、权限和 canonical path。

  ```bash
  cat .scout/skill/internal/runtime-inspector/internal-runtime-inspector/SKILL.md
  ```

- `internal-skill-composition`：提供 Skill 依赖、组合/继承以及接口与实现的读取规则。

  ```bash
  cat .scout/skill/internal/skill-composition/internal-skill-composition/SKILL.md
  ```

## Scout Domain-Driven Working

### Working Model

Scout 以 `<domain>` 组织业务工作。

| 要素 | 在 Scout 工作中的作用 |
| --- | --- |
| `Runtime` | 提供环境、资源和通信能力。 |
| `<domain>` | 提供稳定的业务边界和统一语义。 |
| `<role>` | 承担 `<domain>` 中特定的协作职责。 |
| `task` | 表示 `<domain>` 内的一次具体工作，承载目标、输入、约束、正式 ref 和状态。 |
| `Skill` | 提供 Agent 判断和执行工作所需的规则与方法。 |
| `Domain Skill` | 将 `<domain>` 的规则落实为当前 `<role>` 可执行的工作规范。 |
| `Tool` | 执行 Agent 发起的操作并返回结果或状态。 |

### Tool Model

`Tool` 包括以下执行类型：

| 类型 | 执行能力 |
| --- | --- |
| `Dynamic Tool` | 执行 Scout Runtime 提供的 `<task>` 生命周期、角色通信和 `<domain>` 操作。 |
| `Shell Tool` | 通过当前 Runtime 的 shell 环境执行命令。 |
| `MCP Tool` | 通过当前 mount 配置的 MCP Server 调用外部能力。 |

`Tool Skill` 是规定对应 `Tool` 调用方法、输入、结果和失败边界的 Skill。

### Working Interaction

- 各 `<role>` 通过 `<task>` 围绕具体工作协作，并按 `<role>.AGENTS.md` 规定的职责推进 `<task>`。
- `Domain Skill` 将 `<domain>` 的规则应用于 `<task>`，驱动当前 `<role>` 的判断和工作过程。
- 当前适用的其他 Skill 按 `internal-skill-composition` 的规则提供专项规则与方法。
- `Domain Skill` 或专项 Skill 在消费 `Tool Skill` 时，确定调用目的并解释业务结果。
- `Tool Skill` 规定调用 contract，对应的 `Tool` 执行操作并返回结果或状态。
- `<task>` 状态、`Tool` 结果和角色通信持续更新工作上下文，当前 `<role>` 根据新状态继续响应。

## Scout Delivery

### Delivery Model

Scout 通过持久产物、稳定引用和正式角色交接完成工作交付。

| 要素 | 在 Scout 交付中的作用 |
| --- | --- |
| `artifact` | 当前 `<role>` 持久化保存的正式工作产物。 |
| `ref` | 定位正式内容的稳定引用，支持其它 `<role>` 读取和 Runtime 恢复。 |
| `outcome` | `<task>` 的完整 Markdown 结果，汇总结论并引用相关 `<artifact>`。 |
| `handoff` | `<worker>` 将 `<outcome>` 正式提交给 `<coordinator>` 的 Runtime 交接记录。 |
