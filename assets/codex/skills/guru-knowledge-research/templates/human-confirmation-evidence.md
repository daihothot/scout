---
evidence_id: E-HUMAN-001
evidence_type: human_confirmation
status: candidate
---

# E-HUMAN-001

## Artifact State

- status: <填写 candidate、ready 或 blocked，并与 frontmatter 保持一致>
- blocking_items: <无阻塞项时填写 none，否则说明阻塞事实>
- failed_commands: <无失败命令时填写 none，否则记录命令及错误摘要>
- retry_log: <无重试时填写 none，否则记录重试命令和结果>

状态枚举：

- status: candidate | ready | blocked

## Confirmation Claim

- <填写用户明确确认的事实>

## Human Confirmation Source

- source_type: initial_user_input | human_response
- task_id: <填写承载该确认事实的 Worker task ID>
- request_step_id: <初始输入已包含确认时填写 none，否则填写请求所在 step ID>
- response_step_id: <初始输入已包含确认时填写 none，否则填写响应所在 step ID>
- source_locator: <填写可定位到原始输入或正式人工回复的位置>

## Confirmed Fact

- field: <填写被确认事实所属的 artifact 字段或事实名称>
- value: <填写用户明确确认的事实值>
- applies_to: <填写该事实适用的 artifact、evidence 或 verification point>

## Supports

- <填写该人工确认记录支持的 artifact、evidence 或 VP-* 引用>

## Limitations

- 只记录用户明确确认的内容；未被用户确认的 Researcher 推断或本地来源候选不得写入本证据。
