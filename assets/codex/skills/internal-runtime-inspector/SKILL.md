---
assetKind: scout.skill
name: internal-runtime-inspector
description: 当前 role 需要使用 pwd、scout-assets 和已物化 Shell Tool 定位 Runtime 资源、解析访问路径或诊断资源缺失时使用。
id: internal-runtime-inspector
version: 1.0.0
phase: [coordinate, research, verify, validate]
family: [internal, runtime-inspector]
tags: [scout, runtime, resource, mount, manifest, path]
devices: [any]
dependencies:
  shellTools:
    required: [scoutAssets, pwd]
    optional: [ls, cat, sed, rg]
summary: 使用当前 mount 的稳定查询入口定位 Runtime 资源并检查明确路径。
---

# Internal Runtime Inspector

当前 `role` 需要定位已物化资源、取得准确入口、检查一个明确路径或解释资源访问失败时，使用本技能。

本技能拥有 `pwd`、`scout-assets` 和当前可用 Shell Tool 的查询方法及结果解释。`AGENTS.md` 已定义 Scout Runtime 结构和访问规则；本技能使用这些规则，不复制或重新定义它们，也不修改 Runtime 配置、资源或权限。

## Skill Type

- type: internal
- layout: compact
- note: 查询当前 `role` 已物化的 Runtime 资源，并检查一个明确路径的文件系统事实。

## Core Use

使用本技能处理：

- 确认当前工作目录是否为当前 `role` 的 `mount root`。
- 查询当前 `role`、`phase`、roots 和资源数量。
- 按 family 逐步定位当前 `phase` 支持的 Skill 候选。
- 根据精确 Skill identity 取得 Skill metadata、canonical path 和当前 `phase` 的工具入口。
- 根据精确 plugin name 取得 plugin metadata。
- 检查一个已经明确的路径是否存在，并区分路径事实与后续操作结果。

## Inspection Values

以下名称表示当前检查需要代入的实际值：

| 名称 | 实际内容 |
| --- | --- |
| `<skill-name>` | 需要定位的 Skill canonical identity。 |
| `<plugin-name>` | 需要确认的 plugin name。 |
| `<resource-path>` | 当前上下文、`scout-assets` 或正式 `ref` 已提供的一个明确路径。 |
| `<start-line>` | 需要读取范围的起始行号。 |
| `<end-line>` | 需要读取范围的结束行号。 |
| `<pattern>` | 需要在明确路径中匹配的具体文本或表达式。 |

## Query Workflow

按以下顺序查询：先确认当前 mount。需要发现未知 Skill 时，先查询 family 再读取精确 Skill；已经知道精确 Skill 或 plugin identity 时，可以直接查询。任何情况下都不要自行猜测路径。

### 1. Confirm Mount

场景：刚进入一个 Agent shell，需要确认当前目录。

```bash
pwd
```

`pwd` 的输出是当前 shell 的实际目录。`scout-assets` 必须从当前 `mount root` 运行；不要使用旧 run 或其它设备的路径替换当前输出。

### 2. Inspect Summary

场景：不知道当前 `role`、`phase`、roots 或资源是否已经物化。

```bash
scout-assets
```

显式写法如下：

```bash
scout-assets summary
```

示例输出（关键字段）：

```json
{
  "identity": { "agentId": "<role>", "phase": "<phase>", "mountRoot": "." },
  "roots": {
    "runtimeRoots": [
      { "name": "mount", "path": ".", "access": "read" },
      { "name": "artifacts", "path": "../artifacts", "access": "read-write" },
      { "name": "tmp", "path": "../tmp", "access": "read-write" }
    ],
    "profileRoots": [
      {
        "source": "~/.guru/knowledge",
        "path": "/Users/<user>/.guru/knowledge",
        "access": "read"
      }
    ]
  },
  "counts": { "skills": 0, "shellTools": 0, "mcpServers": 0, "plugins": 0, "issues": 0 }
}
```

路径语义：

- `runtimeRoots[*].path` 是以当前 `mount root` 为基准的相对路径，例如 `.`、`../artifacts` 和 `../tmp`。使用它们时保持当前 mount 上下文。
- `profileRoots[*].source` 是 profile 的可移植逻辑声明，例如 `~/.guru/knowledge` 或 `${SCOUT_ROOT}`。
- `profileRoots[*].path` 是 `scout-assets` 按当前设备解析出的绝对路径，始终以 `/` 开头；实际读取或写入使用 `path`。
- `counts.issues` 只是物化问题数量。它不证明具体资源内容、外部服务或后续操作成功。

### 3. Discover Families

场景：需要按语义定位 Skill 族，而不是先猜完整 Skill 名称。

不带参数时，返回当前 `phase` 支持的扁平 family 名称，不返回 parent：

```bash
scout-assets family
```

示例输出：

```json
{
  "phase": "<phase>",
  "families": ["<family-name-a>", "<family-name-b>", "<family-name-c>"]
}
```

输入一个 family 名称时，工具会在当前 `phase` 中解析它：

```bash
scout-assets family <family-name>
```

如果名称唯一，输出完整 family path 以及下一层 `children` 和/或该 family 下的 `skills`：

```json
{
  "phase": "<phase>",
  "family": "<parent>/<family-name>",
  "skills": [
    {
      "name": "<skill-name>",
      "family": ["<parent>", "<family-name>"],
      "path": ".scout/skill/<parent>/<family-name>/<skill-name>/SKILL.md"
    }
  ]
}
```

如果名称在多个 family path 中出现，工具不会猜测，返回候选 path：

```bash
scout-assets family <family-name>
```

```json
{
  "phase": "<phase>",
  "family": "<family-name>",
  "ambiguous": true,
  "candidates": ["<parent-a>/<family-name>", "<parent-b>/<family-name>"]
}
```

此时使用候选中的完整 path 重新查询：

```bash
scout-assets family <parent-a>/<family-name>
```

查询成功后，只使用返回的 `skills[*].path` 或继续查询返回的 `children`；不要根据 family 名称自行拼接目录。

### 4. Inspect Skill Metadata and Current Phase Tools

场景：已经从 family 查询或当前上下文获得准确的 Skill name，需要取得完整 metadata 和当前 `phase` 的工具入口。

```bash
scout-assets skill <skill-name>
```

示例：

```bash
scout-assets skill <skill-name>
```

示例输出（结构化字段）：

```json
{
  "skill": {
    "name": "<skill-name>",
    "summary": "<skill-summary>",
    "family": ["<parent>", "<family-name>"],
    "phase": ["<phase>"],
    "path": ".scout/skill/<parent>/<family-name>/<skill-name>/SKILL.md",
    "requiredSkills": []
  },
  "phaseTools": {
    "skills": [
      {
        "name": "tool-scout-send-message",
        "family": ["tool", "scout", "dynamic"],
        "path": ".scout/skill/tool/scout/dynamic/tool-scout-send-message/SKILL.md"
      }
    ],
    "shellTools": [
      {
        "id": "<tool-id>",
        "exposeAs": "<tool-name>",
        "wrapperPath": "bin/<tool-name>",
        "command": "<command>",
        "commandPathKind": "absolute"
      }
    ],
    "mcpServers": [
      { "name": "<mcp-name>", "wrapperPath": "mcp/<mcp-name>" }
    ]
  }
}
```

`skill` 返回的 `skill.path` 是当前 mount 的 Skill 入口。`phaseTools` 汇总当前 manifest 中的 tool family Skill、Shell Tool 和 MCP Server；Tool 的参数、绝对路径要求及使用时机仍由对应 Tool Skill 规定。

### 5. Inspect Plugin Metadata

场景：已经知道 plugin name，需要取得当前 mount 中该 plugin 的 metadata。

```bash
scout-assets plugin <plugin-name>
```

示例：

```bash
scout-assets plugin scout-local-capability-plugin
```

示例输出：

```json
{
  "plugin": {
    "name": "scout-local-capability-plugin",
    "path": "plugins/scout-local-capability-plugin",
    "metadata": {
      "name": "scout-local-capability-plugin",
      "version": "<version>",
      "interface": { "displayName": "<display-name>" }
    }
  }
}
```

`plugin` 查询失败表示当前 role 没有物化该 plugin，或 mount 中缺少其 `.codex-plugin/plugin.json`；不根据 plugin name 猜测其它目录。

### 6. Preflight Smoke Check

`--smoke` 是 preflight 使用的内部健康检查，不是资源发现入口。除非某个 preflight 流程明确要求，否则不要用它代替 `summary`、`family`、`skill` 或 `plugin` 查询。

```bash
scout-assets --smoke
```

## Path and File Inspection

查询得到明确的 `<resource-path>` 后，才可以使用已物化的 optional Shell Tool 检查文件系统事实。不要使用文件系统扫描代替 family 查询，也不要在未确认路径时遍历 mount。

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
- `pwd` 和对应 `scout-assets` 查询结果。
- 返回的 logical path、profile absolute path 或 mount-relative path；不适用的字段不补造。
- 实际执行的 optional Tool 及其成功或失败事实。
- 当前能够继续的入口，或阻塞后续操作的具体原因。

本技能不要求生成独立 artifact 或固定格式的 Runtime 报告。

## Failure Rules (Enforcement)

- FR-001：`pwd` 或 `scout-assets` 失败时，保留实际命令和错误，不使用旧路径或记忆补齐当前资源事实。
- FR-002：资源查询和实际文件操作互相冲突时，分别报告各自事实和受影响操作，不选择一个结果覆盖其它结果。

## Blocking Rules (Enforcement)

- BR-001：无法确认当前 `mount root`、所需资源未物化，或明确路径操作返回错误时，阻塞依赖该资源或路径的操作。

## Retry Rules (Enforcement)

- RR-001：只有 resource identity、输入路径、Runtime 物化结果或实际权限发生变化后，才重试相同查询或访问。

## Prohibited Rules (Enforcement)

- PR-001：禁止把 `scout-assets` 的资源可见性或查询成功解释为业务操作成功。
- PR-002：禁止跳过 `family` 查询，根据 family、Skill 或 plugin 名称自行拼接资源路径。
- PR-003：禁止使用未声明的系统命令、全盘搜索或旧 run 路径替代当前 mount 的查询入口。

## Checklist

- `pwd` 已确认当前 `mount root`，`scout-assets` 从该目录成功读取 manifest。
- 使用了与问题匹配的最小查询：`summary`、`family`、`skill` 或 `plugin`。
- family 有歧义时使用完整候选 path，没有自行猜测 parent。
- 需要检查文件时只检查了一个已明确的 `<resource-path>`，并记录实际操作结果。
- optional 文件工具已经物化，且只用于已明确的路径和检查目的。
- manifest 可见性、路径事实、文件操作结果和业务结论没有互相替代。
