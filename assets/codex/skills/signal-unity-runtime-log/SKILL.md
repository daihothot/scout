---
assetKind: scout.skill
name: signal-unity-runtime-log
description: 定义或解释 Unity runtime log 信号、日志记录结构、匹配语义及输出契约时使用。
id: signal-unity-runtime-log
version: 0.3.2
phase: [research, verify, research-reviewer, verify-reviewer]
family: [validation, single, unity, local, general]
tags: [signal, unity, runtime, log]
devices: [any]
summary: 定义 Unity runtime log 的统一文件格式、记录结构、匹配契约和解释限制。
---

# Unity Runtime Log Signal

当需要定义 Unity runtime log 的稳定结构、表达匹配要求、解释观察到的日志，或检查 Signal 输出一致性时使用本技能。

本技能只定义 Unity runtime log 这一信号本身。

## Skill Type

- type: signal
- structure_level: compact
- note: 本技能只拥有 Unity runtime log 的稳定知识与中立 Signal contract。

## Core Use

使用本技能处理：

- 解释 Unity runtime log 的统一文件格式、记录结构和可观察语义。
- 规定消费方如何描述需要匹配和排除的日志。
- 规定 Signal 输出如何保留原始记录字段和物理行范围。
- 解释日志存在、缺失、顺序、重复、关联和时间窗口能够支持什么结论。
- 为所有消费方提供同一份实现无关的信号语义。

不使用本技能处理：

- 定义一次性事件名称、消息文本、主体标识、目标对象或预期结果。
- 根据观察结果直接生成下游结论或消费方产物。

## Signal Model

Unity runtime log 是 Unity 运行过程中由项目、Guru SDK 模块和相关组件写入统一文本文件的日志记录流。它是对运行现象的观察，不是意图、代码实现或下游结论。

一条顶层记录使用以下格式：

```text
<timestamp>  [<project_name>] [ <level> ] [<module_domain>] [<thread>] <message_first_line>
<continuation_line>*
```

以符合顶层格式的行开始一条新记录；后续不符合顶层格式的物理行属于该记录的 `message` 续行，直到下一条顶层记录或文件结束。JSON、请求体和 stack trace 都可以作为多行 `message` 的一部分。

### Record Semantics

解析后的记录包含：

- `timestamp`：日志记录时间，格式为 `yyyy/MM/dd HH:mm:ss`，精度为秒。
- `project_name`：日志头中的项目名，例如 `HexaAway`；必须保留日志原值。
- `level`：日志头中的 `D`、`I`、`W` 或 `E`，不得自行映射为其它严重性体系。
- `module_domain`：日志所属模块域，例如 `GuruSqlite`；允许为空，也允许包含自身方括号。
- `thread`：日志头中的线程标识，按原始字符串保存；可以是数字 thread id，也可以是线程名称。
- `message`：首行正文与全部续行按原顺序组成的完整消息。
- `line_start` 和 `line_end`：该记录在原始日志中的物理行范围。

记录边界：

- `thread` 是同一槽位的原始值；数字和名称都是合法表示，不能强制转换为单一数值类型。
- `module_domain` 的解析必须以其后的 `thread` 槽位为边界，不能用遇到第一个 `]` 即结束的规则处理 `[[GA]]` 这类值。
- 消息中的结构化 payload 只有在格式来源明确且解析规则可定位时，才能作为匹配字段。
- 多行 message 必须保留换行和原始顺序；stack trace 不建模为独立顶层记录。
- 文件中没有独立 record id；`line_start` 和 `line_end` 表示记录在当前单份日志中的物理位置。

### Match Semantics

Signal matching requirement 使用以下语义：

- `match`：哪些记录可以作为目标信号命中，必须写明消息或事件条件以及需要满足的字段谓词。
- `non_match`：哪些相似、噪声、旧 session、错误来源或字段不一致的记录必须排除。
- `required_fields`：为解释本次命中必须保留的原始或结构化字段。
- `correlation`：记录如何连接到消费方指定的 action、session 或对象。
- `ordering`：目标记录之间或与其它已定义信号之间需要满足的相对顺序；不要求顺序时填写 none。
- `observation_window`：从何时开始观察、何时结束，以及什么边界内的记录才适用。

匹配规则：

- 优先使用来源、结构化字段、correlation 和明确消息条件的组合，不只依赖宽泛 substring。
- 一条记录只有同时满足 `match` 且不命中 `non_match` 时，才能成为候选命中。
- 命中日志只证明该记录在声明覆盖范围内被观察到；它是否支持下游结论由消费方结合其它已确认信息解释。
- Signal contract 本身不能证明所有相关日志都已被观察，因此没有匹配记录不能单独证明目标现象未发生。
- 同一原始日志内的记录顺序由 `line_start` 决定；`timestamp` 只有秒级精度，不能单独区分同一秒内多条记录的先后。
- 重复记录可能来自重试、多个 callback、转发或多个 producer；没有记录 identity 时不能自行推断它们是同一事件。

## Signal Matching Contract

消费方选择此信号时使用固定字段：

```text
runtime_log
  signal_ref
  match
  non_match
  required_fields
  correlation
  ordering
  observation_window
```

字段所有权：

- `signal_ref` 固定为 `signal-unity-runtime-log`。
- `match`、`non_match` 和其它约束表达当前 matching requirement，内容必须来自已确认事实。
- matching requirement 只定义要观察什么以及如何识别。
- 只有 runtime log 对当前消费要求有辨识价值时才创建 requirement；未选择本 Signal 时不保留空 requirement。
- requirement 必须具体、可关联、能够排除误命中，并具有明确的 observation window。

## Signal Output Contract

Signal 输出是从单份 Unity runtime log 中解析出的记录视图：

```text
runtime_log_record
  signal_ref
  timestamp
  project_name
  level
  module_domain
  thread
  message
  line_start
  line_end
```

字段语义：

- `signal_ref` 固定为 `signal-unity-runtime-log`。
- 其余字段必须直接按本技能的 Record Semantics 从同一条原始记录解析。
- `line_start` 和 `line_end` 是该记录在当前单份日志中的物理行范围。
- `message` 必须保留首行正文、全部续行、换行和原始顺序。

输出规则：

- 任一解析记录必须保留 `line_start` 和 `line_end`，并由消费方在同一来源文件上下文中解释。
- 无法解析的物理行必须作为前一记录的续行保留；文件开头出现无法归属的物理行时必须作为格式限制披露，不能静默丢弃。
- 筛选结果、摘要、字段提取或脱敏内容不能替代原始记录。

### Contract Relationship Rules

- Signal contract：本技能拥有 Unity runtime log 的统一文件格式、记录语义、输出 contract、匹配语义和解释限制。
- Signal output：本技能定义从单份日志解析出的记录字段和物理行范围。
- Signal record：从原始日志解析出的记录提供可供 requirement 判断的内容。

## Signal Contract Rules (Enforcement)

- SR-001：matching requirement、Signal output、解析记录、observation result 和 downstream conclusion 是不同事实，不得互相替代。
- SR-002：基础 Signal 不定义一次性事件名称、字段值、主体身份或预期结论。
- SR-003：Signal output 必须保留 Record Semantics 定义的全部记录字段以及 `line_start` 和 `line_end`。

## Interpretation Rules (Enforcement)

- IR-001：Signal output 只说明指定物理行能够按本技能的格式解析为记录；它不证明来源文件覆盖完整。
- IR-002：候选命中只证明记录在声明覆盖范围内满足 matching requirement。
- IR-003：没有匹配日志不能仅凭 Signal contract 证明目标现象未发生。
- IR-004：从 `message` 解析出的字段必须具有明确格式来源和可定位解析规则。
- IR-005：同一日志内使用 `line_start` 判断记录顺序；不得只用秒级 `timestamp` 推断同一秒内的先后。
- IR-006：`level`、message 和 stack trace 不能脱离 `project_name`、`module_domain`、`thread` 和消费方声明的关联范围单独解释。

## Prohibited Rules (Enforcement)

- PR-001：禁止在基础 Signal 中写入一次性事件名称、消息文本、主体身份或预期字段值。
- PR-002：禁止把日志 substring、级别或单条 stack trace 直接写成 downstream conclusion。
- PR-003：禁止用“没有匹配日志”单独证明目标现象未发生。
- PR-004：禁止把 `thread` 强制解释为纯数字，或把未出现在日志中的 correlation 和全局顺序伪装成原生字段。
- PR-005：禁止根据实际日志内容反向改写消费方的 `match` 和 `non_match` 来制造命中。

## Example

条件：

```text
消费方选择 `signal-unity-runtime-log`，并提供完整 matching requirement 和一条待解释的 Unity runtime log 记录。
```

解释：

1. 按 `timestamp`、`project_name`、`level`、`module_domain`、`thread` 和多行 `message` 解析记录。
2. 对同一条记录同时应用 `match` 和 `non_match`，并核对 correlation、ordering 和 observation window。
3. 只说明该记录是否构成候选命中及其字段限制，不直接给出 downstream conclusion。

输出：

- runtime log matching requirement 的语义解释。
- 待解释记录是否构成候选命中。
- 原始日志格式未提供的上下文限制。
