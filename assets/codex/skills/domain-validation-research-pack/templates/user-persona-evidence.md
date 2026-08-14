---
scout:
  resource:
    requirement: required
    description: 用户画像证据模板。
evidence_id: E-PERSONA-001
evidence_type: user_persona
status: candidate
---

# E-PERSONA-001

## Artifact State

- status: <填写 candidate、ready 或 blocked，并与 frontmatter 保持一致>
- blocking_items: <无阻塞项时填写 none，否则说明阻塞事实>
- failed_commands: <无失败命令时填写 none，否则记录命令及错误摘要>
- retry_log: <无重试时填写 none，否则记录重试命令和结果>

状态枚举：

- status: candidate | ready | blocked

## Persona Claim

- <填写该用户画像 evidence 能够支持的用户状态 claim>

## Persona Identity

- persona_id: <填写当前用户画像 ID>

## Persona Facts

- user_role: <填写与场景相关的用户角色；Nice to Have，可不填写>
- account_state: <填写经当前证据确认的账号状态>
- subscription_state: <填写与场景相关的订阅状态；Nice to Have，可不填写>
- value_segment: <填写与场景相关的用户价值分层；Nice to Have，可不填写>
- demographic_flags: <填写与场景相关的人口属性；Nice to Have，可不填写>
- locale_or_region: <填写与场景相关的地区信息；Nice to Have，可不填写>
- platform: <填写该用户画像适用的平台>
- app_version: <填写该用户画像适用的应用版本>

## Source Evidence

- <填写支撑画像事实的 E-BDD-001、E-KB-001、E-CAP-* 或 E-HUMAN-* 引用>

## Supports

- VP-001

## Limitations

- <填写该用户画像 evidence 的限制；没有额外限制时填写 none>
