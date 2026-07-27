---
artifact_type: TemplateIndex
artifact_version: 1
status: ready
---

# Template Index

本文件索引 `tool-guru-knowledge` 拥有的知识明细 evidence 模板。

## Templates

| template | purpose | required | use_when |
|---|---|---|---|
| templates/capability-evidence.md | 单个 Capability 的身份、范围、来源和 11 个规格维度。 | 条件必需 | 调用方确认某个 Capability 与当前知识查询范围相关，并分配 `E-CAP-*` 时使用。 |
| templates/availability-evidence.md | 目标版本下相关 Capabilities 的聚合可用性。 | 条件必需 | 调用方提供目标版本和完整 `E-CAP-*` 范围，并分配 `E-AVAIL-001` 时使用。 |
| templates/platform-evidence.md | 目标平台下相关 Capabilities 的共享契约和差异。 | 条件必需 | 调用方提供目标平台和完整 `E-CAP-*` 范围，并分配 `E-PLATFORM-001` 时使用。 |

## Maintenance Rules

- 本索引只做模板导航和读取条件说明。
- 模板标题保持英文，填写内容和说明使用中文。
- 未注明 `Nice to Have，可不填写` 的事实字段必须有确切来源；本技能不能确认时记录缺口，不得补写推断。
- 模板只产生知识明细 evidence，不创建 Research Pack 聚合文件。
- `templates/` 下新增模板后必须登记到本索引。
