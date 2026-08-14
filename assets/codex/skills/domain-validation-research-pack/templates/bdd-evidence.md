---
scout:
  resource:
    requirement: required
    description: 唯一 BDD 聚合证据模板。
artifact_type: BDDEvidence
artifact_version: 1
evidence_id: E-BDD-001
evidence_type: bdd
status: draft
completion_state: partial
---

# E-BDD-001

## Evidence State

- status: <填写 draft、ready 或 blocked，并与 frontmatter 保持一致>
- completion_state: <填写 partial、complete 或 blocked，并与 status 组成合法状态>
- blocking_items: <无阻塞项时填写 none，否则说明阻塞事实>
- human_confirmation_needed: <无需人工求证时填写 none，否则列出尚未确认的问题>
- failed_commands: <无失败命令时填写 none，否则记录命令及错误摘要>
- retry_log: <无重试时填写 none，否则记录重试命令和结果>
- limitations: <没有已知限制时填写 none，否则说明证据边界>

状态枚举：

- `draft + partial`
- `ready + complete`
- `blocked + blocked`

## Target

- product: <填写经当前证据确认的产品名称>
- domain: <填写经当前证据确认的领域名称>
- capability: <填写经当前证据确认的能力名称>
- platform: <填写当前验证目标平台>
- target_version_or_commit: <填写当前代码库版本对应的明确版本或 commit>

## Behavior Identity

- behavior_id: <填写唯一 Behavior ID>
- scenario_id: <填写 Behavior 文件声明的 scenario_id>
- file: <填写 knowledge 根目录下的相对文件路径>
- source_status: <填写 Behavior 当前声明的状态>
- source_locator: <填写可重放的标题、段落或表格定位信息>

## Claim

- <填写该 Behavior 能够支持的预期行为 claim>

## Given

- <填写 Behavior 明确声明的用户初始状态>

## When

- <填写 Behavior 明确声明的触发动作>

## Then

- <填写 Behavior 明确声明的系统结果>

## Expect

- <填写 Behavior 中额外声明的可观察预期>

## Candidate Resolution

- selected_reason: <填写该候选与目标输入唯一匹配的证据和理由>

| candidate | locator | reason_excluded |
|---|---|---|
| <填写被排除的候选 Behavior> | <填写候选的可重放定位信息> | <填写排除该候选的确切理由> |

## Evidence Registration

- evidence_id: E-BDD-001
- artifact_ref: bdd-evidence.md
- summary_ref: knowledge-evidence.md
- registry_ref: evidence-registry.md

## Supports

- VP-001

## Limitations

- <填写该 BDD evidence 的限制；没有额外限制时填写 none>
