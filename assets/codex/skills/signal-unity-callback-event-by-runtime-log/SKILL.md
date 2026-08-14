---
assetKind: scout.skill
name: signal-unity-callback-event-by-runtime-log
description: 定义或解释从 Unity runtime log 单一 Source Signal 派生 callback/event observation 的记录结构、匹配语义和输出契约时使用。
id: signal-unity-callback-event-by-runtime-log
version: 0.3.2
phase: [research, verify, validate]
family: [validation, unity, single, local, general, callback-event]
tags: [signal, unity, callback, event, runtime, log]
devices: [any]
dependencies:
  skills:
    required: [signal-unity-runtime-log]
summary: 定义由 Unity runtime log 派生 callback/event observation 的统一 Signal contract。
---

# Unity Callback Event By Runtime Log Signal

当需要从 Unity runtime log 中识别 callback 或 event observation，并明确该观察点能够支持和不能支持的解释时使用本技能。

本技能只定义由一个 Source Signal 派生 callback/event observation 的稳定知识和中立 contract。

## Skill Type

- type: signal
- structure_level: compact
- note: 本技能定义从唯一 Source Signal record 派生 callback/event observation 的稳定 contract。

## Core Use

使用本技能处理：

- 把满足明确来源语义的 Unity runtime log record 派生为 callback/event observation。
- 区分事件发布、处理器进入、处理器返回、callback 进入、callback 返回和失败观察点。
- 规定消费方如何描述目标 callback/event、排除误命中并关联当前 action 或 session。
- 规定派生输出如何回到唯一 Source Signal record 的物理行范围。
- 限制 callback/event observation 能够支持的最小事实。

不使用本技能处理：

- 定义一次性 callback/event 名称、业务字段值、主体身份或预期结论。
- 从多个 Signal 合成 callback/event observation。
- 根据任意日志 substring 推断 callback 已执行。

## Source Signal

- source_signal: signal-unity-runtime-log

本技能只允许上述一个直接 Source Signal。Source Signal 的原始输出、记录边界、顺序和 locator 语义均由 `signal-unity-runtime-log` 定义，本技能不得覆盖。

## Signal Model

Callback/event observation 是从一个可定位 runtime log record 派生的中立记录，不是新的原始运行文件。

派生记录使用以下结构：

```text
callback_event
  kind
  name
  observation_point
  producer
  consumer_or_handler
  correlation
  source_record
    line_start
    line_end
```

字段语义：

- `kind`：固定为 `callback` 或 `event`。
- `name`：消费方已确认并需要观察的 callback/event 名称；本技能不预置具体名称。
- `observation_point`：日志在 callback/event 生命周期中能够直接代表的观察点。
- `producer`：能够从 Source Signal record 或已确认 producer 语义中定位的发布方；不可定位时保留为 unknown。
- `consumer_or_handler`：能够定位的 callback target、subscriber 或 handler；不可定位时保留为 unknown。
- `correlation`：消费方 requirement 声明并能从 Source Signal record 核对的 action、session、request 或对象关联。
- `source_record`：唯一 Source Signal record 在当前单份来源日志中的物理行范围。

`observation_point` 只允许：

- `event_published`
- `event_handler_entered`
- `event_handler_returned`
- `event_handler_failed`
- `callback_entered`
- `callback_returned`
- `callback_failed`

派生规则：

- Source Signal record 必须先按 `signal-unity-runtime-log` 的 Record Semantics 解析。
- Requirement 必须同时指定 `kind`、`name`、`observation_point` 和能够定位 Source Signal record 的消息或字段条件。
- `observation_point` 必须由日志 producer 的明确格式语义或可定位实现位置支持；只凭自然语言相似性不能确定观察点。
- 一条 Source Signal record 最多派生一条 callback/event observation；同一 record 无法唯一映射时不得派生。
- 派生记录顺序沿用 Source Signal record 的 `line_start`；不得创建比源记录更精确的时间或全局顺序。
- 派生失败、字段缺失或语义不唯一时保留 Source Signal record 和 limitation，不生成伪造的 callback/event observation。

## Signal Matching Contract

消费方选择此信号时使用固定字段：

```text
signal_requirement
  signal_ref
  match
  non_match
  required_fields
  correlation
  ordering
  observation_window
```

字段所有权：

- `signal_ref` 固定为 `signal-unity-callback-event-by-runtime-log`。
- `match` 必须包含目标 `kind`、`name`、`observation_point`，以及 Source Signal record 需要满足的消息或字段条件。
- `non_match` 必须排除名称相似但观察点不同、来源不同、旧 session、转发记录或无法唯一映射的 record。
- `required_fields` 必须包含解释派生结果所需的 Source Signal 原始字段、source locator 和 callback/event 字段。
- `correlation`、`ordering` 和 `observation_window` 由消费方已确认事实提供，不由本技能发明。

匹配规则：

- Source Signal record 只有同时满足 `match`、不命中 `non_match`，且能够唯一确定 `observation_point` 时，才能成为派生候选。
- Requirement 只描述要识别什么；实际 source record、派生结果和下游结论必须分别记录。
- Requirement 不得根据实际日志内容反向修改，以制造 callback/event 命中。

## Signal Output Contract

派生输出使用以下结构：

```text
callback_event
  signal_ref
  source_signal_ref
  source_record
    line_start
    line_end
  kind
  name
  observation_point
  producer
  consumer_or_handler
  correlation
```

字段语义：

- `signal_ref` 固定为 `signal-unity-callback-event-by-runtime-log`。
- `source_signal_ref` 固定为 `signal-unity-runtime-log`。
- `source_record.line_start` 和 `source_record.line_end` 必须等于 Source Signal record 的原始物理行范围。
- 其余字段必须来自当前 requirement 与被引用 source record 的可定位映射。

输出规则：

- 派生输出不创建或替代 Source Signal record。
- 每条派生输出必须通过 `source_signal_ref` 和原始物理行范围回到同一 Source Signal record。
- 多条派生输出共享同一来源日志时，每条都必须保留自己的 source record 行范围。

## Signal Contract Rules (Enforcement)

- SR-001：Source Signal output、派生 requirement、派生 observation 和 downstream conclusion 是不同事实，不得互相替代。
- SR-002：本技能只能声明一个直接 `source_signal`，不得合并多个 Signal output。
- SR-003：派生输出必须保留 source signal ref 和原始物理行范围，不得伪装成独立原始证据。
- SR-004：上层 contract 可以收紧解释范围，但不得覆盖 Source Signal 的记录边界、顺序、时间精度或缺失语义。

## Interpretation Rules (Enforcement)

- IR-001：`event_published` 只证明目标事件在声明边界被发布，不证明任一 handler 已收到或执行。
- IR-002：`event_handler_entered` 或 `callback_entered` 只证明目标执行边界已进入，不证明正常返回或业务成功。
- IR-003：`event_handler_returned` 或 `callback_returned` 只证明声明边界正常返回，不证明其业务结果正确。
- IR-004：`event_handler_failed` 或 `callback_failed` 只证明声明边界观察到失败，不自动确定失败原因或最终业务状态。
- IR-005：没有派生 observation 不能单独证明 callback/event 未发生；Source Signal 的覆盖范围和缺失限制继续适用。

## Prohibited Rules (Enforcement)

- PR-001：禁止声明多个 `source_signal`，或在本技能中执行跨 Signal correlation。
- PR-002：禁止把任意 substring、日志级别或 stack trace 直接解释为 callback/event observation。
- PR-003：禁止在没有明确 producer 语义或可定位实现位置时推断 `observation_point`。
- PR-004：禁止把事件发布解释为 handler 执行，或把 callback 进入解释为 callback 成功返回。
