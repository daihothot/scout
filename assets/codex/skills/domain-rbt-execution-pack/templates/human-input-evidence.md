---
scout:
  resource:
    requirement: required
    description: RBT Execution Pack 的 Human Input request、response 和计划影响模板。
artifact_type: RBTHumanInputEvidence
artifact_version: 1
status: draft
completion_state: partial
---

# Human Input Evidence

## Evidence State

- status: <填写 draft、ready 或 blocked>
- completion_state: <填写 partial、complete 或 blocked>
- blocking_items: <无阻塞项时填写 none；否则说明阻塞事实>
- limitations: <无已知限制时填写 none；否则说明适用边界>

## Human Input Records

只有 `RequestHumanInput` 被 Scout Runtime 接受并返回真实 `request_id` 后，才建立 `HI-*`。没有已接受申请时填写 `none`；调用失败或未被接受不算 Human Input record，只在 `Evidence State.blocking_items` 记录实际错误。每个已接受申请使用唯一 `HI-*`：

### HI-001

- request_id: <填写 Runtime Human Input request ID 原始值>
- task_id: <填写对应 task ID 原始值>
- reason: <填写缺失或冲突事实，以及为什么不能继续；技术值保持原样>
- question: <填写发给人的最小问题；技术值保持原样>
- status: <填写 pending、resolved 或 cancelled>
- response_ref: <原样填写 human-response attachment 的 messageId；未收到时填写 none>
- response_summary: <填写回复如何解决或确认问题；技术值保持原样；没有回复时填写 none>
- effect_on_plan: <填写回复如何影响执行计划；技术值保持原样；没有时填写 none>
- related_refs: <填写相关 E-BDD-*、JR-* 或 SR-*；没有时填写 none>

## Evidence Boundary

- 本文件只保存 Human Input request、response 和计划影响的定位信息，不保存完整 Runtime Human Input Store 或 Run Journal 正文。
- `request_id` 和 `task_id` 必须原样来自已接受的 Runtime 返回。禁止填写 `待返回`、自造后缀、阶段昵称或其它占位值。
- 已收到回复时，`request_id`、`task_id` 和 `response_ref` 分别原样使用 `<human-response>` 中的 `requestId`、`taskId` 和 `messageId`；不得从命名约定反推，也不得写成 Runtime 未返回 identity。
- Runtime 没有接受申请时，不得分配 `HI-*`，不得把申请意图写成已经存在的 request；`Human Input Records` 必须为 `none`。
- `pending` 表示该申请仍未解决；不能把它改写成执行完成或 BDD 结论。
- `resolved` 必须有真实 `response_ref`；没有 response 时只能是 `pending` 或 Runtime 明确返回的 `cancelled`。
- `response_summary` 只记录对计划有影响的事实，不代替原始 response。
- Frontmatter 与 `Evidence State` 中的 `status`、`completion_state` 必须完全一致。
