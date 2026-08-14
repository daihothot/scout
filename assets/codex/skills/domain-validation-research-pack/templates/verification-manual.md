---
scout:
  resource:
    requirement: required
    description: 下游运行验证手册模板。
artifact_type: VerificationManual
artifact_version: 1
manual_id: "<填写当前 manual ID>"
status: draft
completion_state: partial
source_artifacts:
  - bdd-evidence.md
  - knowledge-evidence.md
  - code-evidence.md
  - evidence-registry.md
evidence_registry_ref: evidence-registry.md
---

# Verification Manual

## Manual State

- status: <填写 draft、ready 或 blocked，并与 frontmatter 保持一致>
- completion_state: <填写 partial、complete 或 blocked，并与 status 组成合法状态>
- human_confirmation_needed: <无需人工求证时填写 none，否则列出待确认问题>
- blocking_items: <无阻塞项时填写 none，否则说明阻塞事实>
- failed_commands: <无失败命令时填写 none，否则记录命令及错误摘要>
- retry_log: <无重试时填写 none，否则记录重试命令和结果>
- limitations: <没有已知限制时填写 none，否则说明 manual 的适用边界>

状态枚举：

- `draft + partial`
- `ready + complete`
- `blocked + blocked`

## Manual Identity

- manual_id: <填写当前 manual ID>
- created_for: <填写当前唯一 BDD ID>
- source_artifacts:
  - bdd-evidence.md
  - knowledge-evidence.md
  - code-evidence.md
  - evidence-registry.md
- evidence_registry_ref: evidence-registry.md

## Product Scope

- product: <填写经当前证据确认的产品名称>
- domain: <填写经当前证据确认的领域名称>
- capability: <填写经当前证据确认的能力名称>
- platform: <填写当前验证目标平台>
- app_version: <填写当前验证目标应用版本>
- target_version_or_commit: <填写当前代码库版本对应的明确版本或 commit>

字段标记规则：

- 除明确注明 `Nice to Have，可不填写` 的事实字段外，其余事实字段都必须取得确切信息；现有输入、证据和工具结果都无法确认时，在 `human_confirmation_needed` 或 verification point 的 `Human Confirmation Needed` 中提出人工求证，此时 manual 只能是 `draft + partial`。
- `Nice to Have，可不填写` 的字段有可靠信息时填写；缺失不阻塞完成，也不单独触发人工求证。
- 状态、ID 和 ref 等结构字段按中文填写说明由 workflow 生成或由 contract 校验。
- 所有 `<填写...>` 说明必须在产出 artifact 时替换，不能进入 `ready + complete`。

## Verification Points

每个独立验证点都必须使用下面的完整结构；存在多个验证点时，复制完整区块并依次使用 `VP-002`、`VP-003` 等唯一编号。

### VP-001: Verification Point Title

- vp_id: VP-001
- function_point: <填写需要验证的具体功能点>
- persona_evidence_ref: E-PERSONA-001
- bdd_evidence_ref: E-BDD-001
- evidence_registry_ref: evidence-registry.md

#### Given

- <填写由 BDD fact 和用户画像 evidence 共同定义的初始状态>

#### When

- <填写 BDD fact 定义的触发动作>

#### Then

- <填写 BDD fact 定义的预期结果>

#### Supporting Evidence

- E-BDD-001
- E-KB-001
- E-CAP-001
- E-AVAIL-001
- E-PLATFORM-001
- E-PERSONA-001
- E-CODE-001

#### Signals To Collect

每个适用 Signal 都必须复制下面的完整区块；存在多个 Signal 时依次使用 `SR-002`、`SR-003` 等唯一编号。不得在 Manual 中发明未由当前 `signal_ref` contract 定义的字段或解释。

##### SR-001: Signal Requirement

- signal_ref: <填写当前 Signal Skill identity>
- match: <按当前 Signal Matching Contract 填写目标记录、状态或字段条件>
- non_match: <按当前 Signal Matching Contract 填写必须排除的相似记录、错误来源或不适用条件>
- required_fields: <按当前 Signal Matching Contract 填写解释命中必须保留的字段和 locator>
- correlation: <填写 Signal 与当前 action、session、request、user、对象或 verification point 的关联方式>
- ordering: <填写目标记录之间或与其它 requirement 的相对顺序；不要求时填写 none>
- observation_window: <填写观察开始、结束及记录适用的时间或生命周期边界>

#### Human Confirmation Needed

- <没有待确认项时填写 none，否则列出仍需人工确认的问题>

#### Notes

- <填写不影响验证点语义的补充说明；Nice to Have，可不填写>
