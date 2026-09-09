---
scout:
  resource:
    requirement: required
    description: RBT Execution Pack 的平台类型和版本事实模板。
artifact_type: RBTPlatformEvidence
artifact_version: 1
evidence_id: E-PLATFORM-001
status: draft
completion_state: partial
---

# Platform Evidence

## Evidence State

- status: <填写 draft、ready 或 blocked，并与 frontmatter 保持一致>
- completion_state: <填写 partial、complete 或 blocked，并与 status 组成合法状态>
- blocking_items: <无阻塞项时填写 none；否则说明阻塞事实>
- limitations: <无已知限制时填写 none；否则说明适用边界>

状态枚举：

- `draft + partial`
- `ready + complete`
- `blocked + blocked`

## Platform Evidence

| evidence_id | platform_type | platform_version |
|---|---|---|
| E-PLATFORM-001 | <填写本次实际平台类型原始值> | <填写该平台报告的实际版本原始值> |

## Evidence Rules

- `platform_type` 和 `platform_version` 使用来源提供的原始技术值，不翻译、不规范化、不从示例或默认值推断。
- 平台事实只能写入上面的表格；不得用项目符号、说明段落或额外字段替代表格行。
- 本文件不保存 project、PID、endpoint、session、tool、branch、commit 或其它平台运行事实，也不保存 `JR-*` / `SR-*` 关系。
- 任一必需值无法确认时，状态为 `blocked + blocked`，并填写 `blocking_items`；不得猜测版本。
- Frontmatter 与 `Evidence State` 中的 `status`、`completion_state` 必须完全一致。
