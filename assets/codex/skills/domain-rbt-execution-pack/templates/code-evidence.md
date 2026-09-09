---
scout:
  resource:
    requirement: required
    description: RBT Execution Pack 的当前代码 evidence 聚合模板。
artifact_type: RBTCodeEvidence
artifact_version: 1
status: draft
completion_state: partial
---

# Code Evidence

## Code Evidence State

- status: <填写 draft、ready 或 blocked，并与 frontmatter 保持一致>
- completion_state: <填写 partial、complete 或 blocked，并与 status 组成合法状态>
- blocking_items: <无阻塞项时填写 none；否则说明阻塞事实>
- failed_commands: <无失败命令时填写 none；否则记录命令及错误摘要>
- retry_log: <无重试时填写 none；否则记录重试命令和结果>
- limitations: <无已知限制时填写 none；否则说明代码证据的适用边界>

状态枚举：

- `draft + partial`
- `ready + complete`
- `blocked + blocked`

## Codebase

- codebase: <填写当前 managed codebase 名称>
- version: <填写当前 managed codebase 的版本号>
- codebase_path: <填写本次 run 解析出的 managed codebase 路径>
- codegraph_status: <填写查询时确认的 CodeGraph 状态>

## Scope

- source_query_targets: <填写本文件登记的 SQT-* 引用>

## Source Query Targets

| target_id | derived_from | query_target | expected_claim |
|---|---|---|---|
| SQT-001 | <填写推导该查询目标的 E-BDD-*、JR-* 或 SR-* 引用> | <填写需要定位的实际业务源码语义目标；技术 identity 保持原样> | <填写需要由代码证据确认的 implementation claim> |

## Implementation Claims

| claim_id | claim | codebase | code_evidence | limitations |
|---|---|---|---|---|
| IC-001 | <填写当前版本业务源码能够支持的 implementation claim；技术 identity 保持原样> | <填写 codebase 名称> | <填写 E-CODE-* 引用> | <填写该 claim 的额外限制；没有时填写 none> |

## Source Code Evidence Refs

| evidence_id | artifact_ref | codebase | locator | claim_supported | supports | limitations |
|---|---|---|---|---|---|---|
| E-CODE-001 | `evidence/E-CODE-001.md` | <填写 codebase 名称> | <填写 version、相对路径、symbol 和实际行号> | <填写该源码证据能够支持的 claim；技术 identity 保持原样> | <填写 IC-*、JR-* 或 SR-* 引用> | <填写额外限制；没有时填写 none> |

## Aggregation Notes

- 本文件只聚合当前 managed codebase 中实际读取的业务源码证据引用及 claim mapping；不能替代独立 source code evidence artifact。每个 `E-CODE-*` 必须按 `tool-jarvis-codebase/templates/source-code-evidence.md` 写入 `evidence/E-CODE-*.md`。
- `E-CODE-*` 必须能回到当前源码的 version、相对路径、symbol 和实际行号。Knowledge 文档、Knowledge locator、BDD 文本或其中的 symbol anchor 不能代替源码证据。
- `E-CODE-*` 只证明与 BDD 业务路径、状态转换或预期值直接相关的业务代码。Behavioral control、hook 注册、schema、Gateway、Tool 或测试基础设施实现不得作为支持 BDD claim 的代码证据。
- 代码证据可以证明当前版本业务代码的实现事实，不能证明对应 node、variant 或 EvidenceSource 已在本次 Runtime 中可用。
- `behavior.node.variants`、`behavior.evidence.sources` 等 Runtime availability 事实，以及任何 Behavioral command request/result，属于 Runtime 记录，不写入本文件。
- 真实业务源码无法定位或读取时，不得创建 `E-CODE-*`；删除示例数据行，将状态标记为 `blocked + blocked` 并填写实际阻塞原因。
- Frontmatter 与 `Code Evidence State` 中的 `status`、`completion_state` 必须完全一致。
