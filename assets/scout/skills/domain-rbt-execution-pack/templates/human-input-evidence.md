---
scout:
  resource:
    requirement: required
    description: RBT Execution Pack 的 Human Input request、response 和计划影响模板。
artifact_type: RBTHumanInputEvidence
artifact_version: 1
---

# Human Input Evidence

## Human Input Records

只记录已经解决或取消且属于本次成功计划的 Human Input；仍为 `pending` 时停止，不生成 Pack。没有记录时填写 `none`。每个记录使用唯一 `HI-*`：

### HI-001

- request_id: <填写 Runtime Human Input request ID 原始值>
- task_id: <填写对应 task ID 原始值>
- reason: <填写缺失或冲突事实，以及为什么不能继续；技术值保持原样>
- question: <填写发给人的最小问题；技术值保持原样>
- status: <填写 resolved 或 cancelled>
- response_ref: <原样填写 human-response attachment 的 messageId；未收到时填写 none>
- response_summary: <填写回复如何解决或确认问题；技术值保持原样；没有回复时填写 none>
- effect_on_plan: <填写回复如何影响执行计划；技术值保持原样；没有时填写 none>
- related_refs: <只填写触发本次申请时已经存在的 E-BDD-* locator、E-CODE-*、SR-* 或 JR-*；没有时填写 none>

## Evidence Boundary

- 本文件只保存 Human Input request、response 和计划影响的定位信息，不保存完整 Runtime Human Input Store 或 Run Journal 正文。
- `request_id` 和 `task_id` 必须原样来自已接受的 Runtime 返回。禁止填写 `待返回`、自造后缀、阶段昵称或其它占位值。
- 已收到回复时，`request_id`、`task_id` 和 `response_ref` 分别原样使用 `<human-response>` 中的 `requestId`、`taskId` 和 `messageId`；不得从命名约定反推，也不得写成 Runtime 未返回 identity。
- Runtime 没有接受申请时，不得分配 `HI-*`，不得把申请意图写成已经存在的 request；`Human Input Records` 必须为 `none`。
- `resolved` 必须有真实 `response_ref`；`cancelled` 可以没有 response。
- `response_summary` 只记录对计划有影响的事实，不代替原始 response。
- `related_refs` 只从当前 Human Input record 指向其依据；被引用 artifact 不反向登记 `HI-*`。
