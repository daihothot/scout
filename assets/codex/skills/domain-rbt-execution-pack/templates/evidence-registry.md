---
scout:
  resource:
    requirement: required
    description: RBT Execution Pack 的稳定 ID 与引用关系索引模板。
artifact_type: RBTEvidenceRegistry
artifact_version: 1
status: draft
completion_state: partial
---

# Evidence Registry

## Registry State

- status: <填写 draft、ready 或 blocked>
- completion_state: <填写 partial、complete 或 blocked>
- blocking_items: <无阻塞项时填写 none；否则说明阻塞事实>
- limitations: <无已知限制时填写 none；否则说明适用边界>

## Registry

| id | kind | artifact_ref | locator | claim_or_requirement | supports | limitations |
| --- | --- | --- | --- | --- | --- | --- |
| E-BDD-001 | bdd_evidence | `bdd-evidence.md` | <填写 artifact 内 locator 原始值> | <填写 BDD claim；技术值保持原样> | <填写 JR-*、SR-*、HI-*；没有时填写 none> | <没有时填写 none；否则说明限制> |
| E-CODE-001 | code_evidence | `evidence/E-CODE-001.md` | <填写该 source artifact 内 locator 原始值> | <填写 code claim；技术值保持原样> | <填写 IC-*、JR-*、SR-*；没有时填写 none> | <没有时填写 none；否则说明限制> |
| E-PLATFORM-001 | platform_evidence | `platform-evidence.md` | <填写 artifact 内 locator 原始值> | <填写本次平台类型和版本事实；类型与版本保持原样> | none | <没有时填写 none；否则说明限制> |
| JR-001 | journal_expected | `journal-expected.md` | <填写 section locator 原始值> | <填写预期流程、Signal 观察点和 Journal 对照条件；技术值保持原样> | <填写 E-BDD-*、SR-*；没有时填写 none> | <没有时填写 none；否则说明限制> |
| SR-001 | signal_expected | `signal-expected.md` | <填写 section locator 原始值> | <填写实际 Signal Interface、presence、定位和具体预期；技术值保持原样> | <填写 E-BDD-*、E-CODE-*> | <没有时填写 none；否则说明限制> |
| HI-001 | human_input_evidence | `human-input-evidence.md` | <填写 section locator 原始值> | <填写 Human Input request / response 事实；技术值保持原样> | <填写 E-BDD-*、JR-*、SR-*；没有时填写 none> | <没有时填写 none；否则说明限制> |

## Registry Rules

- 每个实际 ID 恰好出现一次；同一行的 artifact ref 和 locator 必须能定位到拥有该对象的正文。
- `supports` 只登记真实引用方向，不表示被引用对象已经满足。
- 删除或改变对象时同步修正所有引用；registry 中不得保留孤立 ID。
- `E-PLATFORM-*` 只登记 `platform_type` 和 `platform_version`，不登记与 `JR-*` / `SR-*` 的 supports 关系。
- `E-CODE-*` 的 `artifact_ref` 指向 `tool-jarvis-codebase` 生成的独立 source code evidence artifact；`code-evidence.md` 只聚合这些 refs，不替代它们。
- 没有真实源码时，不登记 `E-CODE-*`；不得使用 Knowledge 内容填补 Registry 中的 code evidence 行。
- 每个登记的 `evidence/E-CODE-*.md` 必须真实存在，并与 `code-evidence.md` 使用相同 ID、artifact ref 和 locator。
- 只有 Scout Runtime 已接受并返回真实 `request_id` 的 Human Input 才登记 `HI-*`；没有已接受 request 时删除示例 `HI-*` 行。
- Frontmatter 与 `Registry State` 中的 `status`、`completion_state` 必须完全一致。
