---
assetKind: scout.skill
name: internal-runtime-inspector
description: 当前 role 需要使用 pwd、scout-assets 和已物化 Shell Tool 定位 Scout Runtime 资源、解析访问路径或诊断资源缺失时使用。
id: internal-runtime-inspector
version: 1.0.0
type: internal
phase: [Internal]
family: [internal, general]
tags: [scout, runtime, resource, mount, manifest, path]
devices: [any]
dependencies:
  shellTools:
    required: [scoutAssets, pwd]
    optional: [ls, cat, sed, rg]
summary: 使用当前 mount 的稳定查询入口定位 Scout Runtime 资源并检查明确路径。
---

# Internal Runtime Inspector

当前 `role` 需要定位已物化资源、取得准确入口、检查明确路径或解释资源访问失败时，使用本技能。

本技能拥有 `pwd`、`scout-assets` 和当前可用 Shell Tool 的查询方法及结果解释。`AGENTS.md` 已定义 Scout Runtime 结构和访问规则；本技能使用这些规则，不复制或重新定义它们，也不修改 Scout Runtime 配置、资源或权限。

`Resource Park` 是 Workflow Profile 为一个或多个 Phase 声明的命名资源集合。

## Skill Type

- type: internal
- layout: compact
- note: 查询当前 `role` 已物化的 Scout Runtime 资源，并检查明确路径的文件系统事实。

## Core Use

使用本技能处理：

- 当前目录不确定时，确认它是否为当前 `role` 的 `mount`。
- 查询当前 `role` 参与的 Phase、使用的 Resource Park、可访问路径和资源数量。
- 按 family 逐步定位当前 `role` 已物化的 Skill 候选。
- 根据准确的 Skill identity 取得 Skill metadata、`skill-path` 和当前 `role` 的工具入口。
- 根据精确 plugin name 取得 plugin metadata。
- 检查一个或多个来源明确的路径，并区分路径事实与后续操作结果。

## Inspection Values

以下名称表示当前检查需要代入的实际值：

| 名称 | 实际内容 |
| --- | --- |
| `<domain>` | 当前 Workflow Profile 声明的实际 domain。 |
| `<phase>` | 当前 `role` 参与的一个实际 Phase 名称。 |
| `<phase-a>`、`<phase-b>` | 示例中的实际 Phase 名称；仅用于说明多个 Phase 的分组。 |
| `<family-name>` | `scout-assets family` 返回或当前上下文明确提供的一个 family 名称。 |
| `<family-name-or-path>` | 一个 family 名称或完整的点分隔 `family-path`。 |
| `<family-path>` | 用于 family 查询和 wildcard 依赖声明的点分隔值；例如 `signal.local.unity.general`。 |
| `<family-segment>` | `family-path` 中的一个实际段；多个段按 `.` 连接。 |
| `<child-family>` | 非叶节点查询返回的下一层 family 的实际名称段。 |
| `<skill-name>` | 需要定位的实际 Skill identity。 |
| `<skill-path>` | `scout-assets skill` 返回的 Skill 入口文件系统路径。 |
| `<plugin-name>` | 需要确认的 plugin name。 |
| `<resource-path>` | 当前上下文、`scout-assets` 或正式 `ref` 已提供的一个明确路径。 |
| `<start-line>` | 需要读取范围的起始行号。 |
| `<end-line>` | 需要读取范围的结束行号。 |
| `<pattern>` | 需要在明确路径中匹配的具体文本或表达式。 |

## Resource Queries

根据当前问题选择对应查询，不需要依次运行全部命令。当前目录不确定时先使用 `pwd`；需要发现未知 Skill 时先查询 family；已经知道准确的 Skill identity 或 plugin name 时可以直接查询。任何情况下都不要自行猜测路径。

### Confirm Mount

场景：当前 `role` 无法确认 shell 是否位于自己的 `mount`。

```bash
pwd
```

`pwd` 的输出是当前 shell 的实际目录。`scout-assets` 必须从当前 `mount` 运行；不要使用旧 run 或其它设备的路径替换当前输出。当前目录已经确定时不重复执行 `pwd`。

### Inspect Summary

场景：不知道当前 `role` 参与的 Phase、使用的 Resource Park、可访问路径或资源是否已经物化。

```bash
scout-assets
```

显式写法如下：

```bash
scout-assets summary
```

以下示例中，`<resource-park-name>` 表示当前 `role` 使用的一个实际 Resource Park 名称，`<absolute-profile-path>` 表示当前设备上的一个实际绝对路径。

示例输出（关键字段）：

```json
{
  "identity": { "agentId": "<role>", "mountRoot": "." },
  "profile": {
    "domain": "<domain>",
    "phases": ["<phase>"],
    "resourceParks": ["<resource-park-name>"]
  },
  "roots": {
    "runtimeRoots": [
      { "name": "mount", "path": ".", "access": "read" },
      { "name": "artifacts", "path": "../artifacts", "access": "read-write" },
      { "name": "tmp", "path": "../tmp", "access": "read-write" }
    ],
    "profileRoots": [
      {
        "source": "~/.guru/knowledge",
        "path": "<absolute-profile-path>",
        "access": "read"
      }
    ]
  },
  "counts": { "skills": 0, "shellTools": 0, "mcpServers": 0, "plugins": 0, "issues": 0 }
}
```

路径语义：

- `profile.phases` 是当前 `role` 参与的完整 Phase 列表，不表示 Scheduler 当前正在执行的 `current_phase`。
- `profile.domain` 是当前 Workflow Profile 声明的 domain。
- `profile.resourceParks` 是当前 `role` 使用的 Resource Park 名称列表。
- `runtimeRoots[*].path` 是以当前 `mount` 为基准的相对路径，例如 `.`、`../artifacts` 和 `../tmp`。使用它们时保持当前 mount 上下文。
- `profileRoots[*].source` 是 profile 的可移植逻辑声明，例如 `~/.guru/knowledge` 或 `${SCOUT_ROOT}`。
- `profileRoots[*].path` 是 `scout-assets` 按当前设备解析出的绝对路径，始终以 `/` 开头；实际读取或写入使用 `path`。
- `counts.issues` 只是物化问题数量。它不证明具体资源内容、外部服务或后续操作成功。

### Discover Families

场景：需要按语义定位 Skill 族，而不是先猜完整 Skill 名称。

#### 不传 family 参数

先查看当前 `role` 已物化的 family 范围。多个 phase 都拥有的内容放在以 `+` 连接的共同组中；只属于一个 phase 的内容放在该 phase 组中：

```bash
scout-assets family
```

示例输出：

```json
{
  "<phase-a>+<phase-b>": {
    "families": ["<family-path>"]
  },
  "<phase-a>": {
    "families": ["<family-path>"]
  }
}
```

`families` 使用点分隔的 `family-path`。不传 family 时只返回 family 范围，不返回 Skill。共同组的 key 只是 phase 集合的稳定文本表示，不是新的 family 名称。
这一步只用于了解当前可见范围，不代表可以跳过后续的精确 family 查询。

可以追加 `--phase`，只查看一个 phase：

```bash
scout-assets family --phase <phase>
```

这时只在该 phase 的有效 Skill 集合中返回结果；该集合包括该 phase 的 Domain Skill、Internal Skill 以及这些 Skill 的已物化依赖。`<phase>` 必须是当前 `role` 的 `profile.phases` 中已有的值。

#### 传入 family 名称

先传入一个不带点分隔路径的 family 名称进行模糊查询：

```bash
scout-assets family <family-name> [--phase <phase>]
```

如果名称在多个 family 中出现，工具不会猜测，只返回一个或多个完整候选 `family-path`。不指定 phase 时，候选按所属 phase 组返回：

```json
{
  "family": "<family-name>",
  "ambiguous": true,
  "<phase-a>": {
    "candidates": ["<family-path-a>", "<family-path-b>"]
  }
}
```

指定 `--phase` 后，只在该 phase 的候选集中判断歧义：

```json
{
  "phase": "<phase>",
  "family": "<family-name>",
  "ambiguous": true,
  "candidates": ["<family-path-a>", "<family-path-b>"]
}
```

此时必须从候选中选择一个完整的 `family-path`，再进行精确查询。

#### 传入精确 family-path

输入完整的点分隔 `family-path` 后，工具才会返回该节点的下一层内容：

```bash
scout-assets family <family-path> [--phase <phase>]
```

如果该节点不是叶节点，只返回下一层 `children`，不会直接展开后代 Skill：

```json
{
  "family": "<family-path>",
  "<phase>": {
    "children": ["<family-path>.<child-family>"]
  }
}
```

上面的 `<phase>` 表示未指定 `--phase` 时的 phase 组 key；如果指定了 `--phase`，结果会直接使用 `phase` 字段表示查询范围。

继续使用返回的精确 `family-path` 查询。只有当该节点没有 `children` 时，才返回叶节点 Skill：

```json
{
  "family": "<family-path>",
  "<phase>": {
    "skills": [
      {
        "name": "<skill-name>",
        "family": ["<family-segment>"],
        "path": "<skill-path>"
      }
    ]
  }
}
```

只有 `skills[*].path` 是文件系统路径。查询成功后，只使用返回的 `skills[*].path` 或继续查询返回的 `children`；不要根据 family 名称自行拼接目录。

### Inspect Skill Metadata and Current Role Tools

场景：已经从 family 查询或当前上下文获得准确的 Skill name，需要取得完整 metadata 和当前 `role` 的工具入口。

```bash
scout-assets skill <skill-name>
```

以下示例中的 `<skill-type>` 和 `<skill-summary>` 分别表示 Skill 的实际 type 和摘要，`<tool-skill-name>`、`<shell-tool-id>` 和 `<mcp-server-name>` 分别表示当前 `role` 已物化的一项 Tool Skill、Shell Tool 和 MCP Server。

示例输出（关键字段）：

```json
{
  "skill": {
    "name": "<skill-name>",
    "type": "<skill-type>",
    "summary": "<skill-summary>",
    "path": "<skill-path>",
    "requiredSkills": [],
    "optionalSkills": []
  },
  "phaseTools": {
    "skills": [
      {
        "name": "<tool-skill-name>"
      }
    ],
    "shellTools": [
      {
        "id": "<shell-tool-id>",
        "commandPathKind": "absolute"
      }
    ],
    "mcpServers": [
      { "name": "<mcp-server-name>" }
    ]
  }
}
```

`skill` 返回的 `skill.path` 是当前 mount 的 Skill 入口。只有该 Skill 的实际 metadata 声明了 `phase` 时，返回结果才包含 `skill.phase`；Tool Skill 和 Signal Skill 不包含该字段。`phaseTools` 汇总当前 `role` 的 manifest 中已经物化的 tool family Skill、Shell Tool 和 MCP Server；Tool 的参数、绝对路径要求及使用时机仍由对应 Tool Skill 规定。

### Inspect Plugin Metadata

场景：已经知道 plugin name，需要取得当前 mount 中该 plugin 的 metadata。

```bash
scout-assets plugin <plugin-name>
```

以下示例中的 `<plugin-version>` 和 `<plugin-display-name>` 表示 plugin metadata 返回的实际值。

示例输出：

```json
{
  "plugin": {
    "name": "<plugin-name>",
    "path": "plugins/<plugin-name>",
    "metadata": {
      "name": "<plugin-name>",
      "version": "<plugin-version>",
      "interface": { "displayName": "<plugin-display-name>" }
    }
  }
}
```

`plugin` 查询失败表示当前 role 没有物化该 plugin，或 mount 中缺少其 `.codex-plugin/plugin.json`；不根据 plugin name 猜测其它目录。

### Preflight Smoke Check

`--smoke` 是 preflight 使用的内部健康检查，不是资源发现入口。除非某个 preflight 流程明确要求，否则不要用它代替 `summary`、`family`、`skill` 或 `plugin` 查询。

```bash
scout-assets --smoke
```

## Path and File Inspection

查询得到一个或多个明确的 `<resource-path>` 后，才可以使用已物化的 optional Shell Tool 检查文件系统事实。不要使用文件系统扫描代替 family 查询，也不要在未确认路径时遍历 mount。

### `ls`

场景：查看已确认目录中的链接或文件 metadata，不读取文件正文。

```bash
ls -la <resource-path>
```

### `cat`

场景：完整读取一个已经确认的 Skill 或其它小型配置文件。

```bash
cat <resource-path>
```

### `sed`

场景：文件较长，只读取已经确定的行范围。

```bash
sed -n '<start-line>,<end-line>p' <resource-path>
```

### `rg`

场景：只在已经确认的文件或目录内搜索一个明确 pattern，不进行未限定的全盘发现。

```bash
rg --line-number '<pattern>' <resource-path>
```

使用规则：

- `ls` 只查看已知目录项或链接 metadata。
- `cat` 读取需要完整消费的已知文件。
- `sed` 读取已知文件的明确范围。
- `rg` 只在已确认的文件或目录内搜索明确 pattern。
- optional Tool 缺失时，只能选择能够取得同一事实的其它已物化 Tool；不能改走未声明的系统命令或路径。

## Inspection Result

检查结果只需要说明当前问题实际涉及的内容：

- 使用的 identity、family、Skill name 或 plugin name。
- 实际执行的 `pwd` 和 `scout-assets` 查询结果。
- 返回的 logical path、profile absolute path 或 mount-relative path；不适用的字段不补造。
- 实际执行的 optional Tool 及其成功或失败事实。
- 当前能够继续的入口，或阻塞后续操作的具体原因。

本技能不要求生成独立 artifact 或固定格式的 Scout Runtime 报告。

## Failure Rules (Enforcement)

- FR-001：`pwd` 或 `scout-assets` 失败时，保留实际命令和错误，不使用旧路径或记忆补齐当前资源事实。
- FR-002：资源查询和实际文件操作互相冲突时，分别报告各自事实和受影响操作，不选择一个结果覆盖其它结果。

## Blocking Rules (Enforcement)

- BR-001：无法确认当前 `mount`、所需资源未物化，或明确路径操作返回错误时，阻塞依赖该资源或路径的操作。

## Retry Rules (Enforcement)

- RR-001：只有查询目标、输入路径、Scout Runtime 物化结果或实际权限发生变化后，才重试相同查询或访问。

## Prohibited Rules (Enforcement)

- PR-001：禁止把 `scout-assets` 的资源可见性或查询成功解释为业务操作成功。
- PR-002：需要发现未知 Skill 时，禁止跳过 `family` 查询并自行拼接资源路径。
- PR-003：禁止使用未声明的系统命令、全盘搜索或旧 run 路径替代当前 mount 的查询入口。

## Checklist

- 当前目录不确定时，`pwd` 已确认当前 `mount`；`scout-assets` 已从当前 `mount` 成功读取 manifest。
- 使用了与问题匹配的最小查询：`summary`、`family`、`skill` 或 `plugin`。
- family 有歧义时使用完整候选 `family-path`，没有自行猜测 parent。
- 每个被检查的 `<resource-path>` 都有明确来源，并记录了实际操作结果。
- optional 文件工具已经物化，且只用于来源明确的路径和检查目的。
- manifest 可见性、路径事实、文件操作结果和业务结论没有互相替代。
