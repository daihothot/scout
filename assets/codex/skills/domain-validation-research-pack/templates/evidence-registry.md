---
artifact_type: EvidenceRegistry
artifact_version: 1
status: draft
completion_state: partial
---

# Evidence Registry

## Registry State

- status: <填写 draft、ready 或 blocked，并与 frontmatter 保持一致>
- completion_state: <填写 partial、complete 或 blocked，并与 status 组成合法状态>
- blocking_items: <无阻塞项时填写 none，否则说明阻塞事实>
- failed_commands: <无失败命令时填写 none，否则记录命令及错误摘要>
- retry_log: <无重试时填写 none，否则记录重试命令和结果>
- limitations: <没有已知限制时填写 none，否则说明 registry 的覆盖缺口>

状态枚举：

- `draft + partial`
- `ready + complete`
- `blocked + blocked`

## BDD Evidence

### E-BDD-001

- artifact_ref: bdd-evidence.md
- source: <填写 Behavior 来源文件>
- locator: <填写 Scenario 标题、段落或表格定位>
- claim_supported: <填写该 Behavior 能够支持的预期行为 claim>
- supports: <填写该 evidence 支持的 VP-* 引用>
- limitations: <填写 BDD evidence 的额外限制；Nice to Have，可不填写>

## Knowledge Evidence

### E-KB-001

- artifact_ref: knowledge-evidence.md
- source: <填写该聚合证据覆盖的 knowledge 来源集合>
- locator: Knowledge Aggregate
- claim_supported: <填写 `E-KB-001` 聚合能够支持的 knowledge claim>
- supports: <填写该聚合证据支持的 VP-* 引用>
- limitations: <填写 knowledge aggregate 的额外限制；Nice to Have，可不填写>

## Capability Evidence

### E-CAP-001

- artifact_ref: <填写 E-CAP-* 独立 evidence artifact ref>
- source: <填写 Capability 和 Specifications 来源文件>
- locator: <填写 Capability 身份、范围或规格定位>
- claim_supported: <填写该 Capability evidence 能够支持的 claim>
- supports: <填写该 evidence 支持的 VP-* 引用>
- limitations: <填写 Capability evidence 的额外限制；Nice to Have，可不填写>

## Availability Evidence

### E-AVAIL-001

- artifact_ref: evidence/E-AVAIL-001.md
- source: <填写该聚合覆盖的 Availability 来源文件>
- locator: Version Availability Matrix
- claim_supported: <填写目标版本下相关 Capabilities 的聚合可用性 claim>
- supports: <填写该 evidence 支持的 VP-* 引用>
- limitations: <填写 availability evidence 的额外限制；Nice to Have，可不填写>

## Platform Evidence

### E-PLATFORM-001

- artifact_ref: evidence/E-PLATFORM-001.md
- source: <填写该聚合覆盖的 Platform knowledge 来源文件>
- locator: Platform Evidence Matrix
- claim_supported: <填写目标平台下相关 Capabilities 的聚合平台 claim>
- supports: <填写该 evidence 支持的 VP-* 引用>
- limitations: <填写 platform evidence 的额外限制；Nice to Have，可不填写>

## User Persona Evidence

### E-PERSONA-001

- artifact_ref: <填写 E-PERSONA-* 独立 evidence artifact ref>
- source: <填写支撑画像事实的 evidence refs>
- locator: <填写用户画像 artifact 中的事实定位>
- claim_supported: <填写该用户画像 evidence 能够支持的 claim>
- supports: <填写该 evidence 支持的 VP-* 引用>
- limitations: <填写 user persona evidence 的额外限制；Nice to Have，可不填写>

## Human Confirmation Evidence

### E-HUMAN-001

- artifact_ref: <填写 E-HUMAN-* 独立 evidence artifact ref>
- source: <填写 initial_user_input 或 human_response>
- locator: <填写 task ID 和对应 step ID>
- claim_supported: <填写用户明确确认的事实>
- supports: <填写该人工确认 evidence 支持的 artifact、evidence 或 VP-* 引用>
- limitations: <填写 human confirmation evidence 的额外限制；Nice to Have，可不填写>

## Source Code Evidence

### E-CODE-001

- artifact_ref: <填写 E-CODE-* 独立 evidence artifact ref>
- source: <填写 SRC-* 引用>
- locator: <填写 source commit、相对路径、symbol 和行号>
- claim_supported: <填写 source code evidence 能够支持的 claim>
- supports: <填写该 evidence 支持的 IC-* 或 VP-* 引用>
- limitations: <填写 source code evidence 的额外限制；Nice to Have，可不填写>
