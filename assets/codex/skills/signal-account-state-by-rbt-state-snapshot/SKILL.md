---
assetKind: scout.skill
name: signal-account-state-by-rbt-state-snapshot
description: 基于 RBT State Snapshot 解释 AccountDataStore 状态字段，或声明 Account 状态预期时使用。
id: signal-account-state-by-rbt-state-snapshot
version: 0.1.0
type: signal
family: [signal, local, unity, rbt, account]
tags: [signal, unity, rbt, account, state-snapshot]
devices: [any]
dependencies:
  skills:
    required: [signal-rbt-state-snapshot-by-rbt-evidence]
summary: 基于 RBT State Snapshot 定义 account.account_auth.state 的结果和预期 contract。
---

# Account State By RBT State Snapshot Signal

当需要解释 Campaign Journal 中由 `account.account_auth.state` 产生的 AccountDataStore 状态快照时使用本技能。

本技能基于 `signal-rbt-state-snapshot-by-rbt-evidence` 收窄 Account 状态语义；capture 机制、Account Restore workflow 和 BDD 结论由其它 Skill 负责。

职责边界：本技能只解释 `account.account_auth.state` 的字段和预期；命令调用、快照获取和最终业务结论由对应 Skill 负责。

## Skill Type

- type: signal
- layout: compact
- contract role: derived
- note: 本技能基于 RBT State Snapshot 定义具体 Account state snapshot。

## Core Use

使用本技能处理：

- 识别 `sourceId: account.account_auth.state` 的 `state_snapshot`。
- 解释 UID、匿名状态、账号状态、凭据类型和后置状态字段。
- 说明 Account state 字段能够支持和不能支持的 claim。
- 保留字段缺失、空值和执行前输入不足的限制。

## Account State Contract

适用 State Snapshot 必须满足：

```text
signal_ref: signal-rbt-state-snapshot-by-rbt-evidence
kind: state_snapshot
sourceId: account.account_auth.state
```

`data` 字段：

| field | 语义 |
| --- | --- |
| `uid` | capture 时 AccountDataStore 中当前 Guru user ID；空字符串表示该快照没有当前 UID。 |
| `isAnonymous` | capture 时当前账号是否被 AccountDataStore 标记为匿名账号。 |
| `accountDataStatus` | capture 时 AccountDataStore 状态的字符串表示，例如 `Initialized`。 |
| `credentialTypes` | capture 时绑定 credentials 的逗号分隔类型集合；按集合解释，不依赖输出顺序。 |
| `discreteCredentialTypes` | capture 时 discrete credentials 的逗号分隔类型集合；按集合解释。 |
| `hasDevice` | capture 时是否存在 device snapshot。 |
| `hasFirebaseUser` | capture 时是否存在 Firebase user snapshot。 |
| `firebaseTokenLastRefreshTime` | capture 时记录的 Firebase token 最后刷新时间；空字符串表示快照未提供该时间。 |

## Inputs

### I-001: Account State Snapshot
---

Required：满足 `sourceId: account.account_auth.state` 的完整 State Snapshot record。

Optional：执行前已确认的输入 UID、账号类型或其它用于比较的具体值。

Missing：缺少参与 claim 的字段时，该 claim 保持无法验证；不得从其它快照或默认值补齐。

Confirmation：确认所有参与判断的 `data.<field>` 来自同一 snapshot，并按本 contract 的字段语义比较。

## Interpretation Boundaries

- `uid` 只有与执行前已确认的输入 UID 比较时，才能支持“UID 符合计划输入”；单个快照不能自行证明前后保持不变。
- `accountDataStatus: Initialized` 只证明 capture 时 store 已初始化，不证明具体恢复分支、Hook 或 credential 被复用。
- `credentialTypes` 和 `discreteCredentialTypes` 只描述 capture 时的类型集合；它们不提供 credential identity、secret、来源或前后对象连续性。
- 空 credential 类型集合不能证明已有 credential 被复用，也不能证明 credential 从未存在。
- `isAnonymous` 只描述当前账号类型；它不能单独区分恢复已有匿名账号和新建匿名账号。
- device 与 Firebase fields 是后置状态；只有当前 requirement 明确包含这些结果时才解释。

## Result Semantics

- Account State Signal 保留 State Snapshot 的 `campaignId`、`captureId` 和 `sequence`；原始定位信息由 Via 在 record 外保存。
- 未由本 contract 定义的 Account 字段不能进入 Account state 解释。
- required 字段缺失、为空或无法与计划输入比较时，对应 claim 无法验证；不能补造默认值。

## Account State Expectation

本 Signal 使用 `signal-rbt-state-snapshot-by-rbt-evidence` 定义的 State Snapshot expectation，并补充以下规则：

- `signal_ref` 固定为 `signal-account-state-by-rbt-state-snapshot`，`record_match.sourceId` 固定为 `account.account_auth.state`。
- `record_match.captureId` 使用当前执行计划声明的实际 capture identity，不从 source identity 派生。
- `projection_fields` 只声明当前 BDD 判断和 `expected_values` 真正需要的 Account 字段。
- `expected_values` 使用 `data.uid`、`data.isAnonymous`、`data.accountDataStatus` 等原始字段路径。
- `credentialTypes` 和 `discreteCredentialTypes` 的预期按集合语义声明 match / not-match，不依赖逗号分隔值的输出顺序。
- 需要将快照值与执行输入比较时，expected value 必须是执行前已确认的具体值，不能写“和输入一致”而不保留实际值。

## Evidence Rules (Enforcement)

- ER-001：Account claim 必须引用同一实际快照中的字段；原始定位信息由 Via 在 record 外保存。
- ER-002：需要证明状态变化时，必须引用两个实际观察点或其它直接 evidence。
- ER-003：需要证明具体 credential 被复用时，必须有能够识别 credential identity 或连续性的其它直接 evidence。
- ER-004：每个参与 Account State 预期判断的 `data.<field>` 在 `projection_fields` 非空时必须出现在投影列表中，并在 `expected_values` 中声明；projection 为空时不要求重复列出投影字段。

## Failure Rules (Enforcement)

- FR-001：source、kind 或 claim 所需字段不匹配时，不形成对应 Account state 结果。

## Prohibited Rules (Enforcement)

- PR-001：禁止仅凭 `isAnonymous` 推断创建或恢复了匿名账号。
- PR-002：禁止仅凭 credential 类型集合推断同一个 credential 被复用。
- PR-003：禁止把 device 或 Firebase 状态自动纳入未声明这些结果的 requirement。

## Checklist

- State Snapshot 的 source 和 kind 均匹配 Account state contract。
- 只解释本技能定义且实际返回的字段。
- UID、账号状态、账号类型和 credential claims 使用各自充分证据。
- `campaignId`、`captureId`、`sequence` 没有被丢弃或改写；原始定位信息由 Via 保留。
