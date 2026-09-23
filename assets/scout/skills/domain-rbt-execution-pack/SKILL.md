---
assetKind: scout.skill
name: domain-rbt-execution-pack
description: 为一次 RBT 执行维护可重放执行文件和原子交付证据目录时使用。
id: domain-rbt-execution-pack
version: 0.15.0
type: domain
domain: rbt
phase: [execute]
family: [rbt, artifact]
tags: [scout, rbt, execution, pack, evidence]
devices: [any]
dependencies:
  shellTools:
    required: [scoutRbtArtifactCheck]
summary: 定义按 BDD 与目标版本复用的 RBT 执行文件、原子证据目录和 handoff contract。
---

# Domain RBT Execution Pack

当需要把一次 Runtime Behavioral Test（RBT）的执行输入、源码事实、预期和 Human Input 定位信息写成正式交付时使用本技能。

本技能拥有 Pack 目录、artifact 归属、跨文件关系和 handoff contract。各 artifact 的内容规则由对应模板拥有。

## Skill Type

- type: domain
- layout: compact

## Ownership

- Executor 是 execute-file 和 Pack 目录的唯一 writer。
- 一个 Pack 只对应一个 BDD identity 和一个目标版本；同一组合原地更新，不按 Scout run 创建副本。
- `execute-file.json` 是唯一执行计划；Pack 内的 evidence 和 expectation 不复制执行计划。
- 实际执行记录由 Runtime 保存；Pack 不保存 command result、宿主 shell input/output、trace、live evidence、campaign journal/lifecycle 或 cleanup 正文。

## Artifact Layout

Pack 使用当前 Executor artifact root 下的固定目录：

```text
<artifactRoot>/<bdd-id>/<version>/
  execute-file.json
  execute-pack/
    bdd-evidence.md
    journal-expected.md
    signal-expected.md
    human-input-evidence.md
    evidence/
      E-CODE-*.md
```

`execute-pack/` 目录本身是 `pack_ref`。四个固定 Markdown artifact 均须保留；每个实际使用的 `E-CODE-*` 单独写入 `evidence/E-CODE-*.md`。

交付只允许创建本 Skill 模板定义的文件；禁止额外创建任何 artifact，包括 Markdown、JSON 等文件。

## Template Navigation

1. 读取 [template-index.md](templates/template-index.md)，按索引顺序读取对应模板。
2. 所有必需事实闭合后，一次性生成完整 artifacts 和 execute-file。
3. 正式执行前和 handoff 前运行格式检查；修正诊断后再提交。

存在未解决阻断时立即停止，不创建或修改 Pack、execute-file 或 handoff。Runtime 执行失败不改变已经完成的 Pack。

## Atomic Relations

| ID | 所属 artifact | Pack 内引用 |
| --- | --- | --- |
| `E-BDD-001` | `bdd-evidence.md` | 底层 BDD 事实 |
| `E-CODE-*` | `evidence/E-CODE-*.md` | 底层源码事实 |
| `SR-*` | `signal-expected.md` | 引用 `E-BDD-*` locator 和 `E-CODE-*` |
| `JR-*` | `journal-expected.md` | `signal_refs` 引用 `SR-*` |
| `HI-*` | `human-input-evidence.md` | 按模板引用已有事实 |

引用方向为 `JR-* -> SR-* -> E-BDD-*/E-CODE-*`。所有 refs 直接定位到所属 artifact；下层不反向登记 JR、HI 或 Review Result 等消费者。

## Handoff Contract

正式 handoff 只传递：

- `pack_ref`：`execute-pack/` 目录的稳定 ref；
- `bdd_id`：当前 BDD identity；
- `target_version`：当前 managed codebase 目标版本；
- `execute_file_ref`：同目录层级的 `execute-file.json` ref。

handoff 不携带 artifact 正文、聚合状态副本或 Runtime 结果。

## Integrity Rules

- 四个固定 Pack artifacts 和 `execute-file.json` 必须存在、可读且符合各自模板。
- 所有 Pack 内 refs 都能定位到对应 artifact 中已声明的 ID 或 locator。
- 目录、artifacts 和 handoff 使用同一 BDD identity 与目标版本；所引用的 `E-CODE-*` 使用该 managed codebase 目标版本。

## Artifact Check

```bash
scout-rbt-artifact-check pack "<pack_ref>" --bdd-id "<bdd_id>" --target-version "<target_version>"
```

- 正式执行前、handoff 前和 correction 后运行检查。
- 工具只读核对模板结构、版本、ID、引用方向、目录允许项、execute-file 的 identity/命令顺序，以及 root、activation、capture、trigger 的全部 ID 是否与 SR/JR 完整对应；退出码 `0` 表示格式通过，`1` 表示需修正，`2` 表示调用参数错误。
- 工具不决定交付状态，不验证源码事实、业务映射、Evidence 结论或实时 registry，不读取 Runtime 历史，也不生成额外 artifact。Runtime 会在首条 mutation 前统一核验实时 registry identity；失败时不会执行 Campaign mutation。
