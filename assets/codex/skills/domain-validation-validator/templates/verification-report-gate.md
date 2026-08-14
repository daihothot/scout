---
scout:
  resource:
    requirement: optional
    description: 仅执行 Verification Report Gate 时使用的报告模板。
artifact_type: VerificationReportGate
artifact_version: 1
status: draft
completion_state: partial
gate: blocked
gate_id: "<填写当前 Gate ID>"
created_at: "<填写本次检查记录的创建时间>"
validator_task_id: "<填写当前 Verification Validator task ID>"
checked_report_ref: "<填写本次实际检查的 canonical Verification Report ref>"
checked_report_digest: "sha256:<填写 Validator 第二次计算得到的 64 位十六进制 digest>"
---

# Validator Handoff: Verification Report Gate

## Basic Information

- 当前角色：Validator
- 校验目标：<填写当前唯一 BDD ID>
- Gate ID：<填写当前 Gate ID>
- 创建时间：<填写本次检查记录的创建时间>
- Validator task：<填写当前 Verification Validator task ID>
- 上游角色：Verifier
- 上游 Verifier task：<填写上游 Verifier task ID>
- Verification Report：<填写本次实际检查的 canonical report ref>
- Report digest：sha256:<填写 Validator 第二次计算得到的 64 位十六进制 digest>
- Digest 算法：`sha256`
- Research Pack Gate：<填写作为 Verification 入口的 accepted Research Pack Gate ref>
- Research pack：<填写 accepted Gate 对应的唯一 pack ref>
- Pack digest：sha256:<填写 accepted Gate 对应的 64 位十六进制 digest>
- Verification Manual：<填写当前 report 使用的 manual ref>
- 适用 contract：<列出 Validator AGENTS、domain-validation-validator、domain-validation-verifier 和实际引用的 contract refs>

状态枚举：

- `status: ready | blocked`
- `completion_state: complete | blocked`
- `gate: accepted | needs_fix | insufficient_evidence | blocked`

## Checked Refs

- <逐项列出本次实际读取并检查的 report、manual、evidence 和 contract refs>

## Unchecked Scope

- <没有未检查范围时填写 none，否则列出未检查范围及原因>

## Verification Point Review

| verification_point | reported_state | requirement_ref | evidence_refs | inspection_result | limitations |
|---|---|---|---|---|---|
| <填写 verification point ID> | <填写 Verifier 报告状态> | <填写 Manual requirement ref> | <填写实际检查的 evidence refs> | <填写状态语义和 evidence 链检查结果> | <无局部限制时填写 none，否则说明限制> |

## Gate Conclusion

- 状态：<填写 accepted、needs_fix、insufficient_evidence 或 blocked>
- 摘要：<填写本次 Gate 对当前 digest 对应 Verification Report 的检查结论>

Gate 优先级：

```text
blocked > insufficient_evidence > needs_fix > accepted
```

`accepted` 表示 report contract 和 evidence 链可消费，不表示所有 verification point 都是 `verified`。

## Issue List

### V-001: Issue Title

- 严重性：Critical | High | Medium | Low
- 分类：structure | state | reference | requirement | observation | provenance | evidence | limitation | blocked
- 受影响 refs：<列出直接受该问题影响的 report、verification point 或 evidence refs>
- 检查依据：<列出对应模板、Skill 规则、Manual requirement 或可重放 evidence>
- 影响：<说明该问题为何影响当前 Gate 结论>
- 最小解除条件：<说明 Verifier 需要修正或补齐的最小事实或引用闭环>

没有问题时写：

```text
none
```

## Inspection Execution State

- failed_commands: <无失败命令时填写 none，否则记录命令及错误摘要>
- retry_log: <无重试时填写 none，否则记录重试动作和结果>
- limitations: <没有未检查范围时填写 none，否则说明本次 Gate 的检查边界>
