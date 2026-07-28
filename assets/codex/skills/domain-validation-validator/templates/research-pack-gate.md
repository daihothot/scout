---
artifact_type: ResearchPackGate
artifact_version: 1
status: draft
completion_state: partial
gate: blocked
gate_id: "<填写当前 Gate ID>"
created_at: "<填写本次检查记录的创建时间>"
validator_task_id: "<填写当前 Validator task ID>"
checked_pack_ref: "<填写本次实际检查的 Research pack 路径>"
checked_pack_digest: "sha256:<填写 Validator 第二次计算得到的 64 位十六进制 digest>"
---

# Validator Handoff: Research Pack Gate

## Basic Information

- 当前角色：Validator
- 校验目标：<填写当前唯一 BDD ID>
- Gate ID：<填写当前 Gate ID>
- 创建时间：<填写本次检查记录的创建时间>
- Validator task：<填写当前 Validator task ID>
- 上游角色：Researcher
- 上游 Research task：<填写上游 Researcher task ID>
- 上游声明状态：<填写上游 handoff 声明状态>
- Research pack：<填写本次实际检查的唯一 pack 路径>
- Pack digest：sha256:<填写 Validator 第二次计算得到的 64 位十六进制 digest>
- Digest 算法：`scout-directory-sha256-v1`
- 适用 contract：<列出 Validator AGENTS、domain-validation-validator 和生产者 Skill refs>

状态枚举：

- `status: ready | blocked`
- `completion_state: complete | blocked`
- `gate: accepted | needs_fix | insufficient_evidence | blocked`

## Checked Refs

- <逐项列出本次实际读取并检查的 artifact ref>

## Unchecked Scope

- none

## Gate Conclusion

- 状态：<填写 accepted、needs_fix、insufficient_evidence 或 blocked>
- 摘要：<填写本次 Gate 对当前 digest 对应 Research pack 的检查结论>

Gate 优先级：

```text
blocked > insufficient_evidence > needs_fix > accepted
```

## Issue List

### V-001: Issue Title

- 严重性：Critical | High | Medium | Low
- 分类：structure | state | reference | knowledge | code | evidence | limitation | blocked
- 受影响 refs：<列出直接受该问题影响的 artifact 或 evidence refs>
- 检查依据：<列出对应模板、Skill 规则或当前代码证据>
- 影响：<说明该问题为何影响当前 Gate 结论>
- 最小解除条件：<说明 Researcher 需要修正的最小事实或引用闭环>

没有问题时写：

```text
none
```

## Inspection Execution State

- failed_commands: <无失败命令时填写 none，否则记录命令及错误摘要>
- retry_log: <无重试时填写 none，否则记录重试命令和结果>
- limitations: <没有未检查范围时填写 none，否则说明本次 Gate 的检查边界>
