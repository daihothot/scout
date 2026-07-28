---
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

- runtime_log: <需要 Unity runtime log 时保留并填写以下完整区块；不需要时删除整个区块。Nice to Have，可不填写>
  - signal_ref: signal-unity-runtime-log
  - match: <填写可以命中目标信号的消息、事件或字段条件>
  - non_match: <填写必须排除的相似消息、错误来源、旧 session 或字段条件>
  - required_fields: <填写解释命中时必须保留的原始或结构化字段>
  - correlation: <填写日志与当前 action、session、request、user 或 verification point 的关联方式>
  - ordering: <填写目标记录之间或与其它信号的相对顺序；不要求时填写 none>
  - observation_window: <填写观察开始、结束及记录适用的时间或生命周期边界>
- ui_state: <填写需要记录的界面状态；Nice to Have，可不填写>
- callback_or_event: <填写需要记录的回调或事件；Nice to Have，可不填写>
- network: <填写需要记录的请求和响应；Nice to Have，可不填写>
- local_storage: <填写需要记录的本地状态；Nice to Have，可不填写>
- backend_state: <填写需要记录的服务端状态；Nice to Have，可不填写>
- build_or_test: <填写需要记录的构建或测试输出；Nice to Have，可不填写>
- screenshot_or_recording: <填写需要记录的截图或录屏；Nice to Have，可不填写>

#### Human Confirmation Needed

- <没有待确认项时填写 none，否则列出仍需人工确认的问题>

#### Notes

- <填写不影响验证点语义的补充说明；Nice to Have，可不填写>
