---
assetKind: scout.skill
name: tool-jarvis-codebase
description: 使用 Jarvis Codebase 解析 Guru 托管代码库的名称、路径与当前版本，并导航到 CodeGraph 完成源码定位。
id: tool-jarvis-codebase
version: 0.7.0
type: tool
family: [tool, jarvis]
tags: [jarvis, codebase, source, evidence]
devices: [any]
dependencies:
  skills:
    required: [tool-codegraph]
  shellTools:
    required: [scoutAssets, jarvis-codebase]
    optional: [rg, sed, cat]
summary: 先取得固定的 managed codebase 路径和版本，再把源码定位交给 tool-codegraph。
---

# Jarvis Codebase Tool

当当前 `<role>` 需要访问 Guru 托管代码库，并从当前版本源码形成可追踪的代码证据时，使用本技能。

本技能只拥有 managed codebase 的名称、路径和版本解析，以及源码证据的来源约束。CodeGraph 的索引检查和查询方法由 `tool-codegraph` 负责；业务结论、artifact 结构和填写规则由消费本技能结果的 Skill 负责。

## Managed Codebase Model

Jarvis 管理的本机代码库位于：

```text
~/.guru/codebase/<repo>
```

不要在其它工程目录中搜索 managed codebase。必须先用当前命令确认 repo，再取得其实际绝对路径。

`jarvis-codebase` 是 Scout 暴露的专用命令，已经固定执行 `jarvis codebase`。调用时不要再次添加 `codebase` 子命令。

## Commands

| 目的 | 命令 | 结果 |
| --- | --- | --- |
| 查看帮助 | `jarvis-codebase --help` | 当前 Codebase CLI contract。 |
| 列出支持的 repo | `jarvis-codebase supported` | 当前环境可用的 managed repo 名称。 |
| 读取当前版本 | `jarvis-codebase <repo>` | 当前有效 SDK version。 |
| 取得绝对路径 | `jarvis-codebase <repo> path` | 当前 managed codebase path。 |
| 列出可用版本 | `jarvis-codebase <repo> versions` | 可切换的版本列表；可能刷新远端信息。 |
| 切换到最新版 | `jarvis-codebase <repo> latest` | 切换版本并刷新索引。 |
| 切换指定版本 | `jarvis-codebase <repo> <version>` | 切换版本并刷新索引。 |

`supported`、当前版本和当前路径用于读取。`versions`、`latest` 与显式版本切换可能修改 managed codebase 或索引；只有上游明确要求版本切换时才能执行。禁止自行选择 `latest`。

## Inputs

### Repository

Required：目标 repo 名称。

Missing：未给出或无法唯一确定时，先执行 `jarvis-codebase supported`；仍无法唯一确定则返回候选并停止。

Confirmation：repo 必须出现在本次 `supported` 输出中。

### Version

Required：当前任务使用的目标版本；可以由上游给出，也可以读取当前有效版本。

Missing：执行 `jarvis-codebase <repo>` 读取；不得从分支名、提交、其它工作区或旧 artifact 推断。

Confirmation：记录命令直接返回的版本。只有上游版本要求与当前版本不一致时，才进入显式版本切换。

### Source Target

Required：需要核对的已知文件、类型、方法、API 或业务代码线索。

Missing：返回所缺少的源码目标；不要用宽泛 CodeGraph 查询代替明确输入。

Confirmation：将已确认的 codebase path、version 和 source target 交给 `tool-codegraph`。

## Workflow

### 1. Resolve Repository

```text
jarvis-codebase supported
```

- 只接受当前输出中的 repo。
- 不根据示例、历史日志或目录猜测 repo 名称。

### 2. Resolve Path and Version

```text
jarvis-codebase <repo> path
jarvis-codebase <repo>
```

- path 必须是可读的绝对路径。
- version 必须来自当前命令结果或已完成的显式切换结果。
- 后续所有源码访问都限定在该 path 下。

### 3. Locate Source

使用 `tool-codegraph`，传入固定的 `codebase_path`、`version` 与尽可能精确的 source target。

- 从已知文件或符号开始。
- 先做有界窄查询，再查必要的调用关系。
- 只有窄查询无法定位时才扩大搜索。

### 4. Verify Source Evidence

- 回读命中的当前源码，不把 CodeGraph 摘要当作代码事实。
- 只记录与当前 claim 直接修改或重要间接参与的代码段。
- 多个代码段按执行时间顺序排列。

## Constraints

- 禁止在 Scout 仓库、Unity showcase 或其它猜测路径中寻找 managed codebase。
- 禁止记录 branch、commit 或 working-tree 状态；代码版本只使用当前 SDK version。
- 禁止在未获得明确版本目标时执行 `versions`、`latest` 或版本切换。
- 禁止复制 `tool-codegraph` 的命令方法；需要源码定位时直接读取并使用该 Skill。
- 禁止把 Knowledge、BDD 文档或旧报告写成 code evidence。
- CodeGraph locator 必须回到当前源码核对后才能形成代码事实。

## Result

返回：

- repo；
- managed codebase 的绝对路径；
- 当前 SDK version；
- `tool-codegraph` 返回并经源码核对的相对文件、符号与范围；
- 路径、版本、索引或源码定位中的 blocker。

## Exit

- 已确认 repo、路径和版本，并完成所需源码定位与核对；或
- repo、路径、版本或 source target 无法确认，已返回明确 blocker；或
- 需要版本切换但未获得明确授权，已停止在当前版本边界。
