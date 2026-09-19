---
assetKind: scout.skill
name: signal-rbt-evidence-via-rbt-behavior
description: 仅使用 RBT campaign 查询结果，按完整 Evidence expectation 定位记录、执行声明的比较语义并保留原始证据。
id: signal-rbt-evidence-via-rbt-behavior
version: 0.8.0
type: signal
family: [signal, local, unity, rbt, general]
tags: [signal, rbt, evidence, jarvis, campaign, verification]
devices: [any]
dependencies:
  skills:
    required: [signal-rbt-evidence, tool-rbt-behavior]
summary: 从 campaign 历史 evidence 整体核验 Signal 预期，不依赖 codebase 或 execution history 断言。
---

# RBT Evidence via RBT Behavior

本技能拥有完整 Evidence expectation 的采集与比较过程。业务含义、观察边界和比较条件由 Executor 事先声明；本技能使用同一次执行的 campaign 查询结果形成 `match | not_match | unresolved`，交给 Reviewer Domain Skill 汇总本轮声明比较结果。

## Inputs

- 一条符合 `signal-rbt-evidence` 的完整 expectation。
- 当前执行的 campaign/scenario identity。
- 同一次 `behavior.campaign.query` 的 request 与 Agent 可见 `{ status, command, result }`；需要多页时保留每页 request/result。
- expectation 的 BDD/code refs 只保留为来源引用，不打开对应 artifact 或 codebase，也不参与实际字段比较。

缺少当前执行 identity、完整预期或可关联的查询结果时，比较为 unresolved。Runtime history ref 可用于定位执行，但其 command request/result 不参与 Evidence 断言。

## Acquire Campaign Evidence

调用入口和重试遵循 `tool-rbt-behavior` 与 Reviewer Domain Skill；本技能定义查询应保留的范围：

1. 使用 `behavior.campaign.query`，限定已确认的 campaign/scenario，并请求 historical evidence。
2. 只将必要的 `locate` 条件用于缩小查询；不要使用 `assert` 中的预期值过滤实际 records。
3. 查询用于比较 Journal 顺序或多个 SR 时，保留足够的关联 records；需要分页时用实际 `sequence` 游标继续，直到覆盖声明的观察范围。
4. 保留原始返回字段和每条 record 的 locator。单次结果中可用 `result.evidence[index]` 定位；跨页必须附带对应 query ref。
5. `behavior.evidence.query` 是 live source 查询，不能替换当次 campaign 已采集的历史证据。

## Validate Scope

- Query output 必须 completed、command 一致、campaign/scenario 属于当前执行，并提供可读取的 `result.evidence`。
- `evidenceCount` 是 campaign 总数量，不等于过滤后数量。不能把 limit 截断、过滤不明或未完成分页当作完整结果。
- 按 `observation_scope` 核对实际查询边界。所有决定结论的观察发生事实和范围关系必须在返回的 metadata/evidence 中可见。
- 不用命令成功、执行计划、源码 claim 或 cleanup 成功证明目标 Evidence 已经采集。
- 无法区分未观察与观察结果为空时，为 unresolved；不得把空数组直接解释为业务 absence。

## Compare One Complete Expectation

1. 从每条原始 evidence 读取完整字段，保留缺失、空字符串、null 和类型差异；原始表示不同本身不决定匹配结果。
2. 按 Interface 的 Comparison Semantics 应用 `fields` 中的 `locate` 条件，保留全部 candidates；定位字段缺失导致归属无法判断的 records 也保留为未知，不能直接排除后证明 absence。
3. 对每个 candidate，按声明的比较类型和条件判断同一表内的全部 `assert` 字段；记录每个 field 的 expected、原始 actual、comparison 与判定依据。语义比较允许声明范围内的表示差异，不把它升级为未声明的类型要求；`exact` 仍严格执行。
4. 全部字段条件在同一 record 上成立时，该 record 是完整匹配。不得把不同 records 的字段拼接使用。
5. 字段未返回时，先区分已确认路径不存在与字段未采集、被投影或返回范围不明；只有前者可直接判断 `absent`，后者保留未知。比较条件不明确或所需事实不足时也保留未知，不用 source evidence、执行历史或其它 record 补值。
6. 将观察范围、全部候选和逐字段事实作为整体判断 presence。多候选不隐式选择某一条。

| presence | 实际事实 | result |
| --- | --- | --- |
| present | 观察范围有效，至少一条 record 满足全部声明条件 | match |
| present | 观察范围与采集覆盖已确认，结果完整，没有完整匹配且无影响判断的未知项 | not_match |
| absent | 观察范围与采集覆盖已确认，结果完整，没有完整匹配且无影响判断的未知项 | match |
| absent | 观察范围有效，存在一条满足全部声明条件的 record | not_match |
| 任意 | 观察边界、采集覆盖、字段或比较条件不足以确定上述结果 | unresolved |

已定位 record 但业务字段不符合预期时，必须保留该 record 和不匹配字段；不能因它不是完整匹配就丢弃。

不得根据 claim 或实际值把 `exact` 临时放宽为 `empty` 等语义比较，也不得自行增加等价表示。声明冲突或无法执行时保留 unresolved；明确条件已被实际值否定时，保留字段不匹配。

## Return Comparison Facts

- expectation identity 与整体 `match | not_match | unresolved`。
- query refs、实际 campaign/scenario、观察范围是否成立及其查询证据。
- 全部 candidates、完整匹配 records、原始 `sequence` 与 record locators。
- 逐字段 expected/原始 actual/comparison 及判定依据；语义匹配时说明采用的声明条件和表示差异，同时保留限制和 unresolved 原因。

Journal 比较可以复用这些实际 records；不能仅凭 SR 的 match 状态推断某个唯一 record 或时间关系。

## Journal Order Exclusions

- `sequence` 只描述已经产生的 historical evidence 顺序；activation、执行计划或注册顺序不能推导 record 的产生顺序。
- BDD expectation 没有明确业务时序或因果要求时，不同采集机制产生的 records 之间的相对顺序不参与 `match | not_match` 判定。
- 被排除的相对顺序仍保留实际 `sequence` 和 locator 供追溯，但不能单独把字段与 presence 已匹配的 JR 判为 `not_match`。
- BDD expectation 明确要求时序或因果关系时，才使用可直接证明该关系的 records 比较 `sequence`；证据不足时为 `unresolved`。

## Boundaries

- 所有 Evidence kind 使用同一声明与比较过程；不按 kind、Node 或业务模块发明隐藏判断规则。
- 不读取 codebase，不从 code refs 重新解释或修改预期。
- 不使用 Runtime execution history、capture 配置或 command response 替代缺失的 historical evidence。
- 本技能不修改预期、不执行 trigger、不补采集，也不自行决定重跑。
