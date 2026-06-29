---
assetKind: scout.skill
name: jarvis-codebase
description: Scout 使用 Jarvis codebase 管理 Guru 代码库路径、版本与 CodeGraph 索引，并用独立 codegraph CLI 执行语义检索的工作流。
id: skills.jarvis.codebase
version: 0.1.0
phase: [context_understanding, research, verify]
tags: [jarvis, codebase, codegraph, source, semantic-search]
devices: [any]
summary: 先用 jarvis codebase 解析托管代码库路径，再用独立 codegraph CLI 在该路径上检索源码语义。
---

# Jarvis Codebase

当 Scout Agent 需要从 Guru 托管代码库获取源码语义证据时使用本技能。

## 边界

`jarvis codebase` 负责管理本机托管代码库，路径固定在 `~/.guru/codebase/<repo>`。

它负责：

- 查询支持的代码库名称。
- 解析本机托管 checkout 路径。
- 缺失代码库时 clone。
- 切换 SDK 版本分支。
- 更新 git submodule。
- 在 clone 或切版本后刷新 CodeGraph 索引。

它不负责源码语义检索。没有 `jarvis codebase codegraph` 子命令。索引建好后，必须使用独立 `codegraph` CLI 在 Jarvis 返回的 codebase 路径上检索。

## 支持的代码库

先执行：

```sh
jarvis codebase supported
```

当前支持的仓库名：

- `gurusdk-unity`
- `gurusdk-flutter`
- `fusionads`
- `analytics`

禁止猜测仓库名。如果目标代码库不在 supported 输出中，向 Coordinator 报告 `blocked`，或请求用户选择受支持的仓库。

## 推荐工作流

第一步，解析托管路径：

```sh
CODEBASE=$(jarvis codebase gurusdk-unity path)
```

第二步，确认索引状态：

```sh
codegraph status "$CODEBASE"
```

第三步，开始检索：

```sh
codegraph query "AdsManager" -p "$CODEBASE"
```

规则：

- `jarvis codebase <repo> path` 返回的路径就是 `codegraph -p` 的项目根。
- CodeGraph 命中结果中的路径是相对 codebase 根目录的相对路径。
- 完整本机路径是 `"$CODEBASE/<命中结果相对路径>"`。
- provenance 必须记录 repo 名、解析出的 codebase 路径、当前 version / branch、CodeGraph 状态和实际执行的检索命令。

## 命令副作用

这些命令副作用不同，不能混用：

- `jarvis codebase supported`：无副作用，只列出支持的仓库。
- `jarvis codebase --help`：无副作用，只输出帮助。
- `jarvis codebase <repo> path`：如果 checkout 缺失，可能 clone、更新 submodule、刷新 CodeGraph。
- `jarvis codebase <repo> versions`：会 fetch 远端分支。
- `jarvis codebase <repo> latest`：会 checkout 最新 `sdk/*` 分支、更新 submodule、刷新 CodeGraph。
- `jarvis codebase <repo> <version>`：会 checkout `sdk/<version>`、更新 submodule、刷新 CodeGraph。

只有任务明确要求某个版本，或 Coordinator 明确授权使用 `latest` 时，才能切换版本。

## 常用 CodeGraph 命令

按符号或名称搜索：

```sh
codegraph query "AdsManager" -p "$CODEBASE" -l 10
codegraph query "ShowRewarded" -p "$CODEBASE" -k method
codegraph query "GuruFusion" -p "$CODEBASE" -j
```

不知道具体符号时，用自然语言探索：

```sh
codegraph explore "rewarded ad show" -p "$CODEBASE" --max-files 5
codegraph explore "remote config ads" -p "$CODEBASE"
```

深入已定位符号：

```sh
codegraph node AdsManager -p "$CODEBASE"
codegraph node ShowRewarded -p "$CODEBASE" -f gurusdk-framework/.../MaxRewarded.cs
```

查询调用关系：

```sh
codegraph callers ShowInterstitial -p "$CODEBASE"
codegraph callees InitSdk -p "$CODEBASE"
```

评估影响面：

```sh
codegraph impact AdsManager -p "$CODEBASE"
```

查看索引文件结构：

```sh
codegraph files -p "$CODEBASE"
```

## 证据规则

- Guru 托管代码库的源码语义检索优先使用 CodeGraph。
- 只有 CodeGraph 已定位到具体文件、符号或调用关系后，才直接读取源码片段做核验。
- 不得把 `rg` 作为托管 Guru 代码库的首选源码语义检索方式。
- 如果 CodeGraph 不可用、索引打不开或命令失败，必须报告 blocker，并附上失败命令；不得静默改用文本搜索补齐语义证据。
- 如果 Coordinator 明确授权低置信度文本回退，必须标记为 `rg-fallback`，检索范围必须限制在 `"$CODEBASE"`，并记录 CodeGraph 失败原因。
- 不得把本机绝对源码路径写入 canonical knowledge。
- Scout runtime artifact 可以记录 repo 名、解析出的 codebase 路径、相对路径、符号名、检索命令和 CodeGraph 状态，作为本次 run provenance。

## 示例

```sh
CODEBASE=$(jarvis codebase gurusdk-unity path)
codegraph status "$CODEBASE"
codegraph query "GuruFusionAds" -p "$CODEBASE"
codegraph node GuruFusionAds -p "$CODEBASE"
codegraph callers InitSdk -p "$CODEBASE"
codegraph explore "ads sdk initialization" -p "$CODEBASE"
```
