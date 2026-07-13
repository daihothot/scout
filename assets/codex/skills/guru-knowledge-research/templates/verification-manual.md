---
artifact_type: VerificationManual
artifact_version: 1
manual_id:
status: draft
completion_state: partial
source_artifacts:
  - index.md
  - bdd-fact.md
  - knowledge-evidence.md
  - code-evidence.md
  - evidence-registry.md
evidence_registry_ref: evidence-registry.md
---

# Verification Manual

## Manual State

- status:
- completion_state:
- human_confirmation_needed:
- blocking_items:
- failed_commands:
- retry_log:
- limitations:

状态枚举：

- `draft + partial`
- `ready + complete`
- `blocked + blocked`

## Manual Identity

- manual_id:
- created_for:
- source_artifacts:
  - index.md
  - bdd-fact.md
  - knowledge-evidence.md
  - code-evidence.md
  - evidence-registry.md
- evidence_registry_ref: evidence-registry.md

## Product Scope

- product:
- domain:
- capability:
- platform:
- app_version:
- target_version_or_commit:

## User Persona To Confirm

- persona_id:
- account_state:
- subscription_state:
- value_segment:
- demographic_flags:
- locale_or_region:
- platform:
- app_version:
- confirmation_needed:

画像字段规则：

- 已确认字段写实际值。
- 与当前 BDD 无关的字段写 `irrelevant`。
- 仍需确认的字段写 `unknown`，并在 `confirmation_needed` 中列出；此时 manual 只能是 `draft + partial`。

## Verification Points

### VP-001: <验证点标题>

- vp_id: VP-001
- function_point:
- user_role:
- persona_ref:
- bdd_evidence_ref: E-BDD-001
- evidence_registry_ref: evidence-registry.md

#### Given

-

#### When

-

#### Then

-

#### Supporting Evidence

- E-BDD-001
- E-KB-001
- E-CG-001
- E-CODE-001

#### Signals To Collect

- runtime_log:
- ui_state:
- callback_or_event:
- network:
- local_storage:
- backend_state:
- build_or_test:
- screenshot_or_recording:

#### 需人工确认项

-

#### Notes

-

### VP-002: <验证点标题>

- vp_id: VP-002
- function_point:
- user_role:
- persona_ref:
- bdd_evidence_ref: E-BDD-002
- evidence_registry_ref: evidence-registry.md

#### Given

-

#### When

-

#### Then

-

#### Supporting Evidence

- E-BDD-002
- E-KB-002
- E-CG-002
- E-CODE-002

#### Signals To Collect

- runtime_log:
- ui_state:
- callback_or_event:
- network:
- local_storage:
- backend_state:
- build_or_test:
- screenshot_or_recording:

#### 需人工确认项

-

#### Notes

-
