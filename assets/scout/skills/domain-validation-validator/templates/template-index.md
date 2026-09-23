---
scout:
  resource:
    requirement: required
    description: Validator 两类 Gate 模板的目录与选择规则。
artifact_type: TemplateIndex
artifact_version: 1
status: ready
---

# Template Index

## Purpose

本文件只负责 `domain-validation-validator` 的模板导航和读取顺序，不承载当前 Gate 事实。

## Reading Order

1. 先读取上级 `SKILL.md`，确认当前 task 是 Research Pack Gate 还是 Verification Report Gate。
2. Research Pack Gate 只读取 `templates/research-pack-gate.md`。
3. Verification Report Gate 只读取 `templates/verification-report-gate.md`。
4. 不得在同一 Gate artifact 中混用两套模板。

## Template List

| template | 用途 | 输入对象 | 输出模式 |
|---|---|---|---|
| `templates/research-pack-gate.md` | 检查 Researcher 的 canonical Research pack。 | 唯一 Research pack ref 与稳定 digest。 | `research-pack-gate-NNNN.md` |
| `templates/verification-report-gate.md` | 检查 Verifier 的 canonical Verification Report。 | 唯一 `verification-report.md` ref 与稳定 digest。 | `verification-report-gate-NNNN.md` |

## Maintenance Rules

- 新增、删除或重命名 Validator 模板时必须同步更新本索引。
- 模板 Markdown 标题保持英文，标题下的自然语言内容使用中文。
- 本索引不记录 artifact、evidence、Gate、task 或当前 run 的事实。
