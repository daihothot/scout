---
assetKind: scout.skill
name: signal-unity-local-storage
description: 定义或解释 Unity local storage 快照、SQLite store、记录定位、匹配语义及输出契约时使用。
id: signal-unity-local-storage
version: 0.1.2
phase: [research, verify, validate]
family: [validation, unity, single, local, general, local-storage]
tags: [signal, unity, local-storage, sqlite]
devices: [any]
summary: 定义 Unity local storage 的多 store 快照结构、记录语义、Signal 匹配契约、输出契约和解释限制。
---

# Unity Local Storage Signal

当需要定义 Unity local storage 的稳定结构、表达当前状态或前后状态匹配要求、解释 SQLite 记录，或检查 Signal 输出一致性时使用本技能。

本技能只定义 Unity local storage 这一信号本身。

## Skill Type

- type: signal
- structure_level: compact
- note: 本技能只拥有 Unity local storage 的稳定知识与中立 Signal contract。

## Core Use

使用本技能处理：

- 解释一次 local storage 快照、其中的独立 store、schema 和记录结构。
- 规定消费方如何描述要匹配或排除的 store、table、record 和字段状态。
- 规定 Signal 输出如何引用权威原始数据库，并通过 digest 和主键定位同一条记录。
- 解释当前状态、前后快照、记录时间、缺失记录和多个 store 的一致性边界。
- 限制敏感存储值在 observation view 和下游产物中的暴露范围。

不使用本技能处理：

- 规定如何取得、复制、传输、打开或查询数据库。
- 选择工具、命令、连接、权限、环境、平台或重试流程。
- 定义一次性业务键、账号、设备、商品、排行榜或其它预期字段值。
- 把当前存储状态直接解释为写入事件、业务流程或下游结论。

## Signal Model

Unity local storage 是一个观察边界内持久化状态的只读快照。快照可以包含多个逻辑独立的 store；每个 store 保留自己的原始内容、schema、版本和记录 identity。

Signal output 中的权威事实是指定 digest 的原始 store 快照。schema view 和 record view 都是对该原始内容的可定位解释，不能替代原始 store。

### Snapshot Semantics

一次快照包含：

- `snapshot_ref`：本次 Signal output 的稳定引用。
- `captured_at`：本次快照输出形成的时间，不等同于任一记录的更新时间。
- `consistency_scope`：固定为 `per_store` 或 `atomic_snapshot`。
- `stores`：本次快照实际包含的独立 store 列表。

一致性规则：

- `per_store` 只证明每个 store 各自是可读取的一致快照，不证明多个 store 来自同一个原子事务边界。
- `atomic_snapshot` 只有在输出来源能够证明所有 store 共享同一个原子快照边界时才允许使用。
- 未包含的 store 必须作为 coverage limitation 披露，不能生成空 store 伪装完整覆盖。
- `captured_at` 只表示输出观察时间；不能替代 store 内记录自己的时间字段。

### Store Semantics

每个 store 包含：

- `store_id`：实现 contract 中稳定的逻辑 store identity，不使用设备上的绝对路径作为 identity。
- `store_ref`：指向可独立读取的完整原始 SQLite 快照。
- `digest`：原始 `store_ref` 字节内容的 SHA-256。
- `format`：当前固定为 `sqlite3`。
- `schema_version`：SQLite `user_version` 的原始整数值。
- `schema_digest`：当前 store schema view 的 SHA-256。

schema view 由 `sqlite_schema` 中非临时对象按 `type`、`name`、`tbl_name` 排序后组成，并保留每个对象的原始 SQL。`schema_digest` 只用于识别该 schema view，不表示不同版本之间兼容。

文件名和绝对路径可以变化；同一 `store_id` 下的不同 `digest` 表示不同原始字节快照。不同文件 digest 不自动证明目标记录发生变化，因为数据库页布局、维护操作或无关记录也可能改变文件内容。

### Known Store Contracts

当前已确认的 Guru SDK local storage 包含两个独立 store。

#### `guru`

- 文件名：`guru.db`
- `schema_version`：`1`
- tables：`properties`、`inventory`、`transactions`

`properties` 使用 `k` 作为主键：

- `k`：完整属性键，格式为 `{group}@{name}`。
- `v`：原始字符串值；可以表示普通文本、数字文本、布尔文本或序列化 JSON，必须按 owning property 的格式解释。
- `g`：属性 group。
- `u`：property usage；`0` 为 General，`1` 为 Setting。
- `t`：属性 tag。
- `s`：property scope；`0` 为 Isolation，`1` 为 Device。
- `upt`：Unix 毫秒更新时间。

`properties` 按主键 Replace，表示每个键在当前快照中的最新持久化值，不保留同一键的历史版本。

`inventory` 使用 `itid` 作为主键：

- `sku`、`bal`、`cat`、`attr` 和 `det` 分别保存 SKU、余额、分类、属性整数和扩展信息。
- `bg`、`ed` 分别保存生效开始和结束时间；未设置时可以为 `-1`。
- `crt`、`upt` 分别保存 Unix 毫秒创建时间和更新时间。

`transactions` 使用 `oid` 作为主键：

- `sku`、`state`、`attr`、`category` 和 `method` 保存交易对象及其枚举状态。
- `errinfo`、`currency`、`cost` 保存错误信息、币种和金额。
- `ts` 保存 Unix 毫秒时间。
- `manifest` 保存可选的序列化 manifest。

#### `gameservicedb`

- 文件名：`gameservicedb.db`
- `schema_version`：`2`
- tables：`achievements`、`leaderboard`

`achievements` 使用 `key` 作为主键，格式为 `{normalized_player_id}:{achievement_id}`：

- `plid`、`uid`、`pvd`、`aid` 和 `pfm` 保存玩家、Guru 账号、provider、本地 achievement 和平台 binding identity。
- `ttl`、`des`、`typ`、`hid` 和 `pts` 保存展示与类型字段。
- `prog`、`tgt` 和 `ulk` 保存当前进度、目标和解锁状态。
- `syn` 保存同步状态：`0` 为 LocalOnly，`1` 为 Synced，`2` 为 Failed。
- `upd` 保存 Unix 毫秒更新时间。
- `meta` 保存 binding metadata 字符串。

`leaderboard` 使用 `key` 作为主键，格式为 `{normalized_player_id}:{leaderboard_id}`：

- `plid`、`uid`、`pvd`、`lid` 和 `pfm` 保存玩家、Guru 账号、provider、本地 leaderboard 和平台 binding identity。
- `scr` 保存当前本地分数。
- `syn` 保存同步状态：`0` 为 LocalOnly，`1` 为 Synced，`2` 为 Failed。
- `upd` 保存 Unix 毫秒更新时间。
- `meta` 保存 binding metadata 字符串。

`achievements` 和 `leaderboard` 都表示当前本地状态；同一主键被 Replace 后，单个快照不保留旧值。

### Record Semantics

从 store 解释出的 record view 使用以下结构：

```text
local_storage_record
  store_id
  store_digest
  table
  primary_key
  fields
```

记录规则：

- record identity 由 `store_id`、`table` 和完整 primary-key tuple 组成。
- record locator 由 `store_digest`、`table` 和完整 primary-key tuple 组成，只在该 digest 标识的原始 store 内定位记录。
- 不使用 SQLite `rowid`、查询结果位置、页面位置或文件偏移作为稳定 locator。
- `fields` 保留数据库中的原始 storage value；只有字段的 owning schema 明确声明序列化格式时才能进一步解析。
- SQLite 表没有默认业务顺序。查询返回顺序、主键排序和页面顺序都不能解释为写入顺序。
- record view 可以按 `store_id`、`table` 和 primary key 排序以获得确定性输出，但该顺序只属于输出序列化。
- 记录时间字段只约束该字段所属记录；没有额外证据时不能建立跨表、跨 store 的全局顺序。

### State Comparison Semantics

- 单个快照只证明目标记录在该观察边界的当前持久化状态。
- 证明状态变化必须引用 before 和 after 两个不同 snapshot，并分别保留 store digest 与 record locator。
- store digest 不同只证明原始 store 字节不同；目标记录变化还需要比较同一 record identity 的字段状态。
- 同一 record identity 在 after 快照中缺失，可以证明它在 after 覆盖范围内未找到；不能单独证明删除动作何时、为何或由谁执行。
- 记录存在不能单独证明对应业务动作成功，记录缺失也不能单独证明目标动作从未发生。

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

- `signal_ref` 固定为 `signal-unity-local-storage`。
- `match` 描述目标 store、table、record identity、字段谓词或 before/after 状态关系。
- `non_match` 排除错误 store、错误 table、错误 identity、旧快照、默认值、无关记录或不完整 coverage。
- `required_fields` 只列出解释本次观察所需的原始字段、schema 字段和 locator。
- `correlation` 描述存储记录如何关联到消费方已确认的 action、session、账号或对象；本技能不发明关联值。
- `ordering` 在只检查当前状态时填写 `none`；检查变化时必须明确 before 和 after 快照顺序。
- `observation_window` 描述哪些快照观察边界适用于当前 requirement。

匹配规则：

- record 只有同时满足 `match`、不命中 `non_match`，并且 store、table、primary key 和 digest 都可定位时，才能成为候选命中。
- 需要证明变化时，before 和 after 必须分别满足 coverage 与 locator 要求，不能只比较文件时间或 digest。
- requirement 只定义要观察什么以及如何识别；实际 store、record view、观察结果和下游结论必须分别记录。
- 不得根据实际数据库内容反向改写 requirement 来制造命中。

## Signal Output Contract

Signal 输出使用以下结构：

```text
local_storage
  signal_ref
  snapshot_ref
  captured_at
  consistency_scope
  stores
    - store_id
      store_ref
      digest
      format
      schema_version
      schema_digest
```

字段语义：

- `signal_ref` 固定为 `signal-unity-local-storage`。
- `snapshot_ref` 唯一标识本次 local storage Signal output。
- `captured_at` 使用带时区的时间值，并保留输出来源提供的精度。
- `consistency_scope` 表达跨 store 一致性能力，不允许省略。
- `store_ref` 指向完整、可独立读取的原始 SQLite 快照，不指向查询结果、摘要或重新排版的记录文件。
- `digest` 使用 `sha256:<hex>` 表达原始 store 字节摘要。
- `format` 固定为 `sqlite3`。
- `schema_version` 保留数据库原始 `user_version`。
- `schema_digest` 使用 `sha256:<hex>` 表达本技能规定的 schema view 摘要。

输出规则：

- 原始 `store_ref` 是权威 Signal 输出；schema view、record view、过滤结果和脱敏结果都不能替代它。
- 任一 record view 必须能够通过 `store_id`、`store_digest`、`table` 和 primary key 回到同一原始 store。
- 输出只能列出实际包含且通过一致性检查的 store；部分输出必须披露 coverage limitation。
- 原始 store 可能包含账号凭据、token、设备标识或其它敏感值。下游 artifact 默认只记录 requirement 所需字段，不得无差别展开整库内容。
- 脱敏、摘要或 value digest 必须标明转换方式，并继续保留原始 `store_ref` 和 digest；不能把脱敏值伪装成数据库原值。

### Contract Relationship Rules

- Signal contract：本技能拥有 local storage 的快照、store、schema、record、locator、匹配语义和解释限制。
- Matching requirement：消费方拥有当前要匹配的 store、record identity、字段条件和 before/after 关系。
- Signal output：本技能定义原始 store 引用、digest、schema identity 和一致性范围。
- Record view：从权威 store 解释出的可定位当前状态。
- Observation result：消费方记录目标 record 是否满足 matching requirement。
- Downstream conclusion：消费方拥有 observation result 与其它已确认信息的解释和结论。

## Signal Contract Rules (Enforcement)

- SR-001：matching requirement、Signal output、record view、observation result 和 downstream conclusion 是不同事实，不得互相替代。
- SR-002：每个 record locator 必须包含准确的 store digest、table 和完整 primary key，不能脱离原始快照复用。
- SR-003：多个 store 默认只具有 `per_store` 一致性；没有明确证据时不得声明 `atomic_snapshot`。
- SR-004：当前状态与状态变化是不同观察；变化必须同时引用 before 和 after。

## Interpretation Rules (Enforcement)

- IR-001：单个 record view 只证明该记录在指定 store digest 中的当前持久化值。
- IR-002：记录更新时间不等同于业务完成时间，也不自动建立跨记录顺序。
- IR-003：记录缺失只适用于已声明的 store、table、snapshot 和 coverage。
- IR-004：store digest 改变不自动证明目标记录改变；必须核对同一 record identity。
- IR-005：序列化字符串只有在 owning schema 的格式明确时才能解释为结构化字段。
- IR-006：多个 store 的记录不能仅凭同一次输出自动解释为同一原子状态。

## Prohibited Rules (Enforcement)

- PR-001：禁止在基础 Signal 中写入一次性业务键、账号、设备、商品、排行榜、预期字段值或业务结论。
- PR-002：禁止包含具体工具、命令、连接、权限、环境矩阵、失败操作或重试流程。
- PR-003：禁止把查询结果顺序、`rowid`、页面位置或文件时间解释为业务写入顺序。
- PR-004：禁止从单个当前状态反推写入、删除、同步或业务流程已经执行。
- PR-005：禁止把多个 store 拍平成一个无 store identity 的键值集合。
- PR-006：禁止在 observation artifact 中无差别复制账号凭据、token、设备标识或整库原始值。
- PR-007：禁止根据实际数据库内容反向改写消费方的 `match` 和 `non_match` 来制造命中。
