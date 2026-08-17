---
assetKind: scout.skill
name: internal-boundary-inspector
description: Scout Agent 在访问 mount、artifact、Skill、共享资产或其它运行路径前确认稳定目录结构与读写边界时使用。
id: internal-boundary-inspector
version: 1.0.0
phase: [coordinate, research, verify, validate]
family: [internal, boundary-inspector]
tags: [scout, run, mount, artifact, permission, boundary]
devices: [any]
dependencies:
  shellTools:
    required: [scoutAssets, pwd]
    optional: [ls, cat, sed, rg]
summary: 说明当前 Run 的 mount 结构、允许访问范围、软链接 canonical 权限和安全查询入口。
---

# Internal Boundary Inspector

在探索路径、读取 Skill、访问 artifact 或判断当前 Agent 能力前，先使用本技能。它提供稳定环境模型，避免通过遍历父目录、其它 mount 或 Skill 源目录来猜测权限。

本技能只拥有 Scout 运行目录和访问边界说明；领域源码位置、业务 artifact contract、工具操作方法和当前任务事实由各自 Skill 或正式 ref 所有。

## Skill Type

- type: internal
- structure_level: compact
- note: 默认只用于建立工作边界；只有任务明确要求边界报告时才生成 Boundary Snapshot。

## Run Layout

当前工作目录就是当前 Agent 的 mount root。稳定结构为：

```text
<run-root>/
  codex-home/.codex/          # 当前 Run 的隔离 Codex 配置与会话
  agents/
    <role>/
      mount/                  # 该 Agent 的只读运行投影与工具入口
      artifacts/              # 该 Agent 拥有的持久产物
      logs/                   # Runtime 日志，不是 Agent 工作输入
```

当前 mount 中常用入口：

```text
./AGENTS.md
./agents/worker.AGENTS.md      # 仅 Worker
./agents/<role>.AGENTS.md
./.scout/skill/<family...>/<skill-name>/SKILL.md
./bin/
./mcp/
./plugins/
./mount-manifest.json
```

不要依赖从 mount 反推 Scout checkout、Run 父目录或其它 Agent 目录。跨设备恢复后，这些物理位置可以变化，但 mount 内相对入口和正式 artifact ref 保持语义稳定。

## Access Matrix

| 对象 | 读取 | 写入 | 规则 |
|---|---|---|---|
| 当前 Agent mount | 允许 | 禁止 | 只消费已物化配置、Skill、工具和链接。 |
| 当前 Agent artifacts | 允许 | 允许 | 仅写当前 task 与角色 contract 授权的产物。 |
| 其它 Agent artifacts | 条件允许 | 禁止 | 只读取 task prompt、handoff 或 Runtime 明确给出的正式 ref；禁止扫描和猜测。 |
| 其它 Agent mount | 禁止 | 禁止 | 不用于通信、Skill 借用或能力发现。 |
| 任意 Agent logs | 禁止 | 禁止 | 日志由 Runtime 与诊断流程拥有。 |
| 其它 Run | 禁止 | 禁止 | 不遍历 run 父目录，不复用其它 Run 状态。 |
| 当前 phase 物化的 Skill | 允许 | 禁止 | 从 `.scout/skill/` 的分类目录读取。 |
| 未物化 Skill 与 Skill 源目录 | 禁止 | 禁止 | 不扫描源码资产目录寻找其它 phase 或角色 Skill。 |
| profile 额外根目录 | 按配置 | 按配置 | 只为当前任务使用；不能据此扩大 Run 或 Agent 边界。 |

## Symlink and Canonical Target Rules

- mount 中的 Skill、AGENTS、plugin 和部分工具可以是软链接。
- 权限同时检查用户看到的逻辑路径和软链接解析后的 canonical target；链接本身不会扩大权限。
- 当前 phase 已物化 Skill 的 mount 路径及对应 canonical source 可读，是同一项授权，不是对整个 Skill 源目录的授权。
- 指向本来已允许的共享资产的链接仍可读取该共享资产；这不意味着链接所在的其它 Agent mount 可读，也不允许借此枚举其它 mount。
- 链接 target 未被当前 profile 放行时应停止，并把它当作真实权限边界；禁止改走父目录、替代链接或原始 asset 路径绕过。

## Stable Inspection Entry Points

优先使用这些已知入口，不先遍历目录：

```bash
pwd
scout-assets list
scout-assets skills
scout-assets tools
scout-assets mcp
scout-assets plugins
```

- `pwd` 确认当前 mount root。
- `scout-assets list` 读取当前 mount manifest 的身份、路径边界和已物化能力。
- 其它子命令只查看对应的当前 mount 清单。
- 清单中不存在的能力不应通过 Scout checkout、其它 mount 或缓存目录自行寻找。
- 只有需要读取具体文件时，才在已知允许目录内使用 `ls`、`rg`、`sed` 或 `cat`；不要以递归扫描作为环境发现的第一步。

## Environment Facts

- `SCOUT_RUN_ID`、`SCOUT_RUN_ROOT`、`SCOUT_ARTIFACT_ROOT` 和 `SCOUT_ASSET_COMMIT_ID` 可作为当前 Run 的 Runtime facts。
- 当前工作目录代表 mount root；不要要求或推断额外的 `SCOUT_MOUNT_ROOT`。
- 本地绝对路径只用于当次执行，不能作为跨设备恢复后的唯一 artifact locator。
- `mount-manifest.json` 是当前 mount 投影的权威清单；它不是其它 Agent 私有状态或业务事实来源。

## Boundary Snapshot

只有任务明确要求“边界快照”“能力清单”或权限诊断时，才输出快照。最小内容为：

```markdown
# Boundary Snapshot

- run_id: <SCOUT_RUN_ID>
- agent_id: <manifest agentId>
- phase: <manifest agentProfile.phase>
- mount: <pwd>
- asset_commit_id: <manifest assetCommitId>

## Access
- own_mount: read-only
- own_artifacts: read-write
- referenced_other_artifacts: read-only
- other_mounts_and_logs: denied

## Materialized Capabilities
- skills: <manifest skills>
- shell_tools: <manifest shellTools>
- mcp_servers: <manifest mcpServers>
- plugins: <manifest plugins>

## Limitations
- <仅记录实际缺失、权限失败或未检查项；没有则写 none>
```

快照只陈述当前可见运行边界，不证明任何业务行为、工具成功、外部服务可用或 artifact 内容正确。

## Enforcement Rules

- BR-001：先按本技能建立路径边界，再执行领域探索；禁止用权限失败驱动的盲目路径枚举代替边界理解。
- BR-002：其它 Agent artifact 只有正式 ref 授权读取；“同一个 Run”不构成扫描权限。
- BR-003：禁止读取其它 Agent mount、任意 Agent logs、其它 Run 或未物化 Skill 源目录。
- BR-004：软链接权限以逻辑路径与 canonical target 的共同授权为准，不得利用链接绕过 deny。
- BR-005：Boundary Snapshot 是可见性报告，不得冒充业务 evidence、验证结果、人工确认或 task handoff。
