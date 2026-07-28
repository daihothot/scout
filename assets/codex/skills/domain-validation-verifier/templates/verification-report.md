---
artifact_type: VerificationReport
artifact_version: 1
report_id: "<填写当前 Verification Report ID>"
status: draft
completion_state: partial
created_at: "<填写报告创建时间>"
verifier_task_id: "<填写当前 Verifier task ID>"
research_gate_ref: "<填写作为验证入口的 accepted Research Pack Gate ref>"
checked_pack_ref: "<填写 accepted Gate 对应的 Research pack ref>"
checked_pack_digest: "sha256:<填写 accepted Gate 对应的 64 位十六进制 digest>"
verification_manual_ref: "<填写当前 Verification Manual ref>"
---

# Verification Report

## Report State

- status: <填写 draft、ready 或 blocked，并与 frontmatter 保持一致>
- completion_state: <填写 partial、complete 或 blocked，并与 status 组成合法状态>
- human_confirmation_needed: <ready + complete 时填写 none，否则列出仍待人工确认的必需事实>
- blocking_items: <无报告级阻塞项时填写 none，否则说明导致报告无法完成的事实>
- failed_commands: <无报告级失败命令时填写 none，否则记录命令及错误摘要>
- retry_log: <无报告级重试时填写 none，否则记录重试动作和结果>
- limitations: <无报告级限制时填写 none，否则说明未覆盖范围和适用边界>

状态枚举：

- `draft + partial`
- `ready + complete`
- `blocked + blocked`

`ready + complete` 表示所有 verification point 均已按实际证据形成明确状态，且 `human_confirmation_needed` 为 `none`；它不表示所有 verification point 都是 `verified`。

## Source Context

- target_bdd_id: <填写当前唯一 BDD ID>
- research_gate_ref: <填写作为验证入口的 accepted Research Pack Gate ref>
- research_gate: accepted
- checked_pack_ref: <填写 accepted Gate 对应的唯一 Research pack ref>
- checked_pack_digest: sha256:<填写 accepted Gate 对应的 64 位十六进制 digest>
- evidence_registry_ref: <填写当前 Research evidence registry ref>
- verification_manual_ref: <填写当前 Verification Manual ref>
- target_version_or_commit: <填写当前验证目标的确切版本或 commit>

## Execution Boundary

- target_environment: <填写当前验证环境>
- platform: <填写当前目标平台>
- device_or_target: <填写当前设备、模拟目标或 Editor target>
- configuration: <填写影响本次验证的配置>
- started_at: <填写本次验证开始时间>
- completed_at: <填写本次验证完成时间>

## Verification Points

每个 verification point 都必须使用下面的完整结构；存在多个验证点时，复制完整区块并依次使用 `VP-002`、`VP-003` 等唯一编号。

### VP-001: Verification Point Title

- vp_id: VP-001
- requirement_ref: <填写 Verification Manual 中当前 verification point 的稳定 ref>
- status: <填写 verified、not_verified、insufficient_evidence 或 blocked>
- observed_claim: <填写当前 evidence 能够直接支持的 observation；没有可成立 observation 时填写 none>
- evidence_refs: <填写支撑当前状态的稳定 evidence refs；没有时填写 none>
- signal_refs: <填写本点实际解释的 Signal refs；没有时填写 none>
- acquisition_refs: <填写本点实际使用的 Acquisition refs；没有时填写 none>

#### Requirement

- expected_behavior: <填写当前 verification point 要求观察的目标行为>
- match: <填写从 Manual 原样引用的匹配条件>
- non_match: <填写从 Manual 原样引用的排除条件>
- correlation: <填写从 Manual 原样引用的关联条件>
- ordering: <填写从 Manual 原样引用的顺序条件；不要求时填写 none>
- observation_window: <填写从 Manual 原样引用的观察窗口>

#### Observations

| evidence_ref | signal_ref | acquisition_ref | locator | observation | provenance | limitations |
|---|---|---|---|---|---|---|
| <填写稳定 evidence ref> | <填写 Signal ref> | <填写 Acquisition ref> | <填写原始 observation 的可重放 locator> | <填写实际观察内容> | <填写版本、环境、时间和采集来源> | <无局部限制时填写 none，否则说明限制> |

没有取得可定位 observation 时删除占位行，并在本节填写：

```text
none
```

#### Evaluation

- requirement_result: <填写 satisfied、contradicted、inconclusive 或 not_executed>
- conclusion: <填写当前 observation 与 requirement 的直接关系>
- rationale: <填写该关系为何足以得到当前 verification point 状态>

映射规则：

- `satisfied` 对应 `verified`，必须有可定位 observation 直接满足 requirement。
- `contradicted` 对应 `not_verified`，必须有可定位 observation 直接反证目标行为。
- `inconclusive` 对应 `insufficient_evidence`。
- `not_executed` 对应 `blocked`。
- 命令失败、权限失败、解析失败、超时、空结果或未执行不能填写 `contradicted`。

#### Execution State

- failed_commands: <无失败命令时填写 none，否则记录命令及错误摘要>
- retry_log: <无重试时填写 none，否则记录重试动作和结果>
- blocking_items: <无局部阻塞项时填写 none，否则说明阻塞事实>
- limitations: <无局部限制时填写 none，否则说明 observation 的适用边界>

## Report Notes

- <填写不改变逐项状态的报告级补充说明；Nice to Have，可不填写>
