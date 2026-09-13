---
assetKind: scout.skill
name: domain-rbt-review-pack
description: 为 RBT Reviewer 保存结构化审查结果并生成面向人的时间线 HTML 时使用。
id: domain-rbt-review-pack
version: 0.1.0
type: domain
domain: rbt
phase: [review]
family: [rbt, artifact]
tags: [scout, rbt, review, report, artifact]
devices: [any]
dependencies:
  skills:
    required: [domain-rbt-execution-pack]
  shellTools:
    required: [rbtReviewReport]
summary: 定义 RBT 审查结果数据和 HTML 报告交付边界。
---

# Domain RBT Review Pack

当 RBT Reviewer 已完成独立证据比较，需要保存可审计的审查事实并交付人类可读报告时使用本技能。

本技能只拥有 Review Pack 的 artifact contract 和报告生成入口。Reviewer 提供结构化事实；HTML 的结构、样式、转义、状态汇总和交互由 `rbt-review-report` 工具实现。

## Skill Type

- type: domain
- layout: compact
- note: 定义审查结果 artifact，不重新执行 RBT，也不替代 Reviewer 的证据判断。

## Core Use

使用本技能处理：

- 保存每个 `JR-*`、`SR-*` 预期对应的比较事实。
- 生成一个自包含、可离线打开的 HTML 时间线报告。
- 保留预期、实际值、比较规则、差异和定位引用，供人复核。

## Ownership

- Reviewer 是 `review-result.json` 的唯一 writer；HTML 由 `rbt-review-report` 生成。
- 每个时间线点必须对应一个唯一的 `JR-*` 或 `SR-*`，并保留其独立比较状态。
- `match`、`warning`、`not_match` 是比较状态；总结果由工具根据全部点重新计算。
- Review Pack 只保存 Reviewer 提供的结构化审查事实，不复制完整 Runtime journal、Signal 正文或 Execution Pack。

## Artifact Contract

Review Pack 位于当前 Reviewer artifact root 下：

```text
<artifactRoot>/<bdd-id>/<version>/review-pack/
  review-result.json
  review-report.html
```

`review-result.json` 必须遵循 `templates/review-result.md`。它至少包含 BDD、目标版本、campaign、总结和一个非空 `timeline`。

`executorHistoryRef` 默认指向同一 `execute-file.json` 的最后一次 Executor 执行历史。该“最后一次”必须由执行历史的顺序或 Runtime 提供的 ref 确认，不能按文件修改时间猜测；若无法唯一关联，保留证据不足，不生成伪造关联。

`review-report.html` 必须由 `rbt-review-report` 从同一份 JSON 生成，不能手工拼接或修改状态。工具不访问网络，输出可独立打开。

## Status Contract

| status | 含义 | 总结果影响 |
| --- | --- | --- |
| `match` | 预期、实际值和比较规则均匹配。 | 不改变总结果。 |
| `warning` | 证据不完整、预期不精确或只能部分比较。 | 总结果为 `attention`，除非存在 `not_match`。 |
| `not_match` | 有效证据与预期不匹配。 | 总结果为 `fail`。 |

总结果只由工具计算：有一个 `not_match` 为 `fail`；没有红色点但有 `warning` 为 `attention`；全部为 `match` 为 `pass`。Reviewer 不能在输入中覆盖这个计算结果。

## Inputs

### I-001: Structured Review Facts
---

Required：

- `bddId`、`targetVersion`、`campaignId`：当前审查边界的原始 identity。
- `executorHistoryRef`：指向本次 Executor 执行历史文件的稳定 ref；只用于追溯，不复制历史正文。
- `summary`：中文总体说明。
- `timeline`：至少一个对象；每个对象包含唯一 `id`、`status`、`title`、`expected`、`actual`、`comparison`。

Optional：

- `scenarioId`：存在时写入页面元数据，缺失按 `none` 处理。
- `refs`：`journal`、`signal`、`runtime`、`code` 定位引用数组；缺失按空数组处理。
- `note`：该时间线点的中文补充说明；缺失按 `none` 处理。

Missing：

- 任一必需 identity、总结或时间线字段缺失、为空或类型不对时，不生成报告，保留原始校验错误。
- 时间线为空、ID 重复、ID 不是 `JR-*` 或 `SR-*`，或 status 不在允许集合时，不生成报告。
- 可选字段缺失不阻塞生成，也不由工具猜测默认业务值。

Confirmation：

- JSON 可解析，所有必需字段有效，`executorHistoryRef` 可定位到 Executor 历史文件，时间线 ID 唯一且只使用 `JR-*`/`SR-*`，每个点都有比较事实，引用数组中的值可直接定位。

## Generation Contract

通过已挂载的 `rbt-review-report` 工具调用：

```text
rbt-review-report --input <review-result.json> --output <review-report.html>
```

工具读取输入、重新计算总结果并生成 HTML。Reviewer 不需要知道 HTML/CSS 结构，也不在 Review Pack 中复制工具实现。

## Integrity Rules

- HTML 与 `review-result.json` 必须由同一次工具调用生成；修改 JSON 后必须重新生成 HTML。
- 页面必须展示全部时间线点，不能因状态、kind 或证据多少而隐藏点。
- 页面详情必须同时展示预期、实际值、比较规则和可用引用；对象值按 JSON 结构显示，不丢弃字段。
- 所有用户可控文字必须由工具转义后写入 HTML；报告不能执行输入中的 HTML 或脚本。
- 总结果只能按 `Status Contract` 计算，不能信任输入中的 summary status。

## Failure Rules

- 输入校验失败时工具以非零退出码结束，不写入不完整的 HTML。
- 输出无法写入时保留文件系统错误，不将其改写为审查结论。
- `not_match` 或 `warning` 是正常审查结果，不是渲染失败。

## Prohibited Rules

- 禁止 Review Pack 重新查询 Runtime、调用 trigger 或修改 Executor artifact。
- 禁止 Reviewer 手工维护 HTML/CSS/脚本或绕过 `rbt-review-report` 写入报告。
- 禁止把 `warning` 自动改写为 `match`，或把缺失证据自动改写为 `not_match`。

## Checklist

- `review-result.json` 使用模板结构，所有描述性内容为中文，技术 identity 保持原样。
- 每个 `JR-*`、`SR-*` 都有唯一时间线点和完整比较事实。
- `rbt-review-report` 已成功生成同目录 `review-report.html`。
- HTML 可离线打开，三种点状态、总结果、详情展开和引用均可见。
