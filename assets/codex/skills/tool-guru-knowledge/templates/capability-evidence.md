---
scout:
  resource:
    requirement: optional
    description: 仅在相关 Capability 被选中时使用的明细证据模板。
evidence_id: E-CAP-001
evidence_type: capability
status: candidate
---

# E-CAP-001

## Artifact State

- status: <填写 candidate、ready 或 blocked，并与 frontmatter 保持一致>
- blocking_items: <无阻塞项时填写 none，否则说明阻塞事实>
- failed_commands: <无失败命令时填写 none，否则记录命令及错误摘要>
- retry_log: <无重试时填写 none，否则记录重试命令和结果>

状态枚举：

- status: candidate | ready | blocked

## Claim

- <填写该 Capability 对当前 BDD 能够支持的职责、边界或规格 claim>

## Capability Identity

- product: <填写经当前证据确认的产品名称>
- domain: <填写经当前证据确认的领域名称>
- capability: <填写 Capability 名称>
- capability_id: <填写 Capability knowledge frontmatter id>
- file: <填写 Capability index.md 的 knowledge 相对路径>
- status: <填写 Capability 当前声明状态>
- relation_to_bdd: <填写 primary、upstream、downstream 或 supporting>

## Capability Scope

- responsibility: <填写 Capability 职责摘要>
- boundary: <填写 Capability 边界摘要>
- upstream: <填写与当前 BDD 有关的上游依赖；没有时填写 none>
- downstream: <填写与当前 BDD 有关的下游能力；没有时填写 none>

## Source Refs

| source_id | document_type | file | locator | status |
|---|---|---|---|---|
| CAPSRC-001 | <填写 capability 或 specification> | <填写 knowledge 相对路径> | <填写标题、段落或表格定位> | <填写来源文档当前状态> |

## Specification Coverage Matrix

| dimension | coverage_state | claim | source_refs | gap_or_rationale |
|---|---|---|---|---|
| 系统目标 | <填写覆盖状态> | <填写该维度的当前事实；未覆盖时填写 none> | <填写 CAPSRC-* 引用；未覆盖时填写 none> | <填写缺口或覆盖理由> |
| 系统边界 | <填写覆盖状态> | <填写该维度的当前事实；未覆盖时填写 none> | <填写 CAPSRC-* 引用；未覆盖时填写 none> | <填写缺口或覆盖理由> |
| 用户角色 | <填写覆盖状态> | <填写该维度的当前事实；未覆盖时填写 none> | <填写 CAPSRC-* 引用；未覆盖时填写 none> | <填写缺口或覆盖理由> |
| 核心能力 | <填写覆盖状态> | <填写该维度的当前事实；未覆盖时填写 none> | <填写 CAPSRC-* 引用；未覆盖时填写 none> | <填写缺口或覆盖理由> |
| 关键流程 | <填写覆盖状态> | <填写该维度的当前事实；未覆盖时填写 none> | <填写 CAPSRC-* 引用；未覆盖时填写 none> | <填写缺口或覆盖理由> |
| 领域对象 | <填写覆盖状态> | <填写该维度的当前事实；未覆盖时填写 none> | <填写 CAPSRC-* 引用；未覆盖时填写 none> | <填写缺口或覆盖理由> |
| 状态变化 | <填写覆盖状态> | <填写该维度的当前事实；未覆盖时填写 none> | <填写 CAPSRC-* 引用；未覆盖时填写 none> | <填写缺口或覆盖理由> |
| 业务规则 | <填写覆盖状态> | <填写该维度的当前事实；未覆盖时填写 none> | <填写 CAPSRC-* 引用；未覆盖时填写 none> | <填写缺口或覆盖理由> |
| 数据与接口 | <填写覆盖状态> | <填写该维度的当前事实；未覆盖时填写 none> | <填写 CAPSRC-* 引用；未覆盖时填写 none> | <填写缺口或覆盖理由> |
| 非功能要求 | <填写覆盖状态> | <填写该维度的当前事实；未覆盖时填写 none> | <填写 CAPSRC-* 引用；未覆盖时填写 none> | <填写缺口或覆盖理由> |
| 验收场景 | <填写覆盖状态> | <填写该维度的当前事实；未覆盖时填写 none> | <填写 CAPSRC-* 引用；未覆盖时填写 none> | <填写缺口或覆盖理由> |

覆盖状态枚举：

- `covered`
- `not_applicable`
- `not_found`
- `needs_confirmation`

## Supports

- VP-001

## Limitations

- Capability evidence 说明当前 knowledge 中的职责、边界和规格事实；它不能证明当前版本代码实现或运行时行为。
