---
evidence_id: E-PLATFORM-001
evidence_type: platform_knowledge
status: candidate
---

# E-PLATFORM-001

## Artifact State

- status: <填写 candidate、ready 或 blocked，并与 frontmatter 保持一致>
- blocking_items: <无阻塞项时填写 none，否则说明阻塞事实>
- failed_commands: <无失败命令时填写 none，否则记录命令及错误摘要>
- retry_log: <无重试时填写 none，否则记录重试命令和结果>

状态枚举：

- status: candidate | ready | blocked

## Claim

- <填写目标平台下所有相关 Capabilities 的共享契约或平台差异聚合 claim>

## Platform Scope

- product: <填写经当前证据确认的产品名称>
- platform: <填写当前 Research 的目标平台>
- capability_refs: <填写本证据覆盖的 E-CAP-* 引用>

## Platform Evidence Matrix

| capability_ref | source | locator | document_type | shared_contract | difference | status | limitations |
|---|---|---|---|---|---|---|---|
| E-CAP-001 | <填写平台知识来源> | <填写平台事实定位> | <填写来源文档类型> | <填写该 Capability 在目标平台仍需遵守的共享契约> | <填写平台差异；没有差异时填写 none> | <填写来源文档当前状态> | <填写平台事实限制；Nice to Have，可不填写> |

## Supports

- VP-001

## Limitations

- Platform evidence 在整个 Research Pack 中只能有一份；它描述目标平台知识，不能证明当前源码实现或运行时行为。
