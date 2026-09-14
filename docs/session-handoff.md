# Scout Session Handoff

更新时间：2026-09-14

本文是下一 thread 的当前工程交接。它记录已经落地的 Scout 执行层、RBT 真实交付链、当前运行证据、Guru SDK 工作区状态和下一步边界。README、旧设计文档和历史聊天只能作为线索；发生冲突时，以当前源码、当前配置和当前运行证据为准。

## 0. 当前结论

Scout 已经具备完整的 RBT execute/review 基础链路：

```text
用户意图
  -> Coordinator 定位唯一 BDD
  -> Executor 生成 execute-pack + execute-file
  -> RBT Domain 执行完整 campaign sequence
  -> Runtime 写入 history/<runtime-sequence>.json
  -> Reviewer 查询 campaign evidence
  -> review-result.json
  -> review-report.html
```

当前不是“基础工具链仍跑不通”的状态。26.7 基线已产生真实 Executor history 和 Reviewer HTML；但当前开发基线已经迁到 26.9，尚未完成一次 26.9 Unity 干净编译和新的端到端 RBT run。因此下一 thread 不应直接宣称 26.9 已验证通过。

当前最关键的三个事实：

1. Scout `master` 当前 HEAD 为 `7f24862`，本次 `npm run typecheck` 已通过。
2. 可写 Guru Framework 当前为 `pr/v26.9.0-runtime-behavior-hook-websocket@3e9f8c3c`，已经合并 `origin/sdk/v26.9.0-rc.2@0c384447`。
3. Jarvis managed codebase 仍报告 `v26.7.0-rc.2`，路径是 `~/.guru/codebase/gurusdk-unity`；在新的 26.9 RBT run 前必须先对齐这个版本。

## 1. 不可破坏的工作边界

- 禁止使用 Git worktree。
- 修改任何持久文件前，先列出具体计划并等待用户确认。
- 不清理、不覆盖、不恢复用户现有 dirty changes；需要隔离时使用明确命名且经确认的安全方式。
- 不删除既有 stash。Framework 最新 merge 前的安全副本仍保留，详见第 10 节。
- 不把 branch、commit、working tree 写入 Execution Pack；Pack 的代码基线只记录 SDK version。
- 不用 Unity Showcase、Scout 仓库或其它猜测目录代替 managed codebase 的业务源码。
- RBT 相关 Runtime/Behavioral 实现只用于理解工具链或诊断基础设施；BDD code evidence 必须来自当前版本的业务代码链。
- Agent artifact 的描述性内容统一使用中文；ID、路径、命令、版本、字段名和枚举保留原始技术值。
- Skill 和模板文案不写精确措辞测试；测试只覆盖 Runtime contract、结构、schema 和行为。
- 当前后续重点是 RBT；Validation Domain 除非用户重新提出，否则不进入本轮范围。

## 2. Scout 当前执行层

### 2.1 Run 生命周期

启动流程由 `StartRunStageAssembly` 注册：

```text
RunScope
-> RunJournalWriter
-> WorkflowJournal
-> InitializeRun
-> RunRuntime(start)
-> Interaction
-> AppServerRootConfig
-> AppServer
-> PrepareEnvironment
-> [Domain || AgentTelemetry]
-> [AgentBackend || Orchestrator]
-> Agents
```

恢复流程由 `ResumeRunStageAssembly` 注册：

```text
RunScope
-> RunJournalWriter
-> WorkflowJournal
-> ResumeClients
-> RestoreEnvironment
-> RecordResumeInterruptions
-> RunRuntime(resume)
-> Interaction
-> [Domain || AgentTelemetry]
-> RestoreDomain
-> [AgentBackend || Orchestrator]
-> RestoreAgents
-> RestoreTasks
-> InjectResumeContext
```

Stage 拥有自己的资源与启动/停止逻辑；Assembly 只声明顺序。不要重新把这些职责塞回一个大 RunManager。

### 2.2 Workflow 是执行边界

- RBT workflow 为 `execute -> review`。
- `execute.completed -> review`，`execute.error -> terminal`。
- `review.completed -> terminal`，`review.error -> execute`。
- Coordinator 通过 `SubmitPhaseOutcome` 推进 phase，不自行选择 Worker role。
- `execution_only: true` 时，Coordinator 消费 Executor handoff 后直接交付，不进入 review。
- 一个 workflow cycle 完成后没有需要继续恢复的业务执行；恢复只用于尚未闭合的通用 Agent/Task/Step/Human Input 状态。

### 2.3 Journal 与恢复

- `events.jsonl` 只保存 Scout 通用恢复事实，例如 workflow、interaction、thread、message、turn、task、step、Scout 内部 tool call 和 human input。
- Domain 只有声明 `ScoutDomainJournalProjection` 时才把自己的事件写入 `<domain>-events.jsonl`，并自行投影恢复事实。
- RBT Domain 当前没有 journal projection，`RbtDomain.restore()` 为空。
- RBT campaign command/history 是执行审计资料，不是恢复 journal；它位于 Agent artifact 的 `history/`。
- 当前 RBT 无法从 campaign 中间继续恢复。一次执行要么已经形成完整 history，要么没有形成可复用的完整执行事实。

## 3. Agent 事实流与日志

App-server timeline 进入 `AgentBackend` 后，分别交给独立 backend；这些事实不能再混回 Activity。

| 事实 | Backend | Agent 日志 | 边界 |
| --- | --- | --- | --- |
| reasoning、file change、context compaction、turn | `AgentActivityBackend` | `activity.log` | 排除 command、dynamic/MCP tool 和 subagent。 |
| shell command | `AgentCommandExecutionBackend` | `command-execution.log` | 只记录 command/cwd/status/exitCode/duration，不记录 stdout、stderr 或 aggregatedOutput。 |
| Scout 内部 dynamic/MCP tool | `AgentToolCallBackend` | `tool-calls.log` | 只接受 `scout_agent_*` namespace/server；按一次 tool call 聚合终态。 |
| native subagent | `AgentSubagentBackend` | `subagent.log` | 独立记录协作 tool 和 subagent activity。 |
| thread | thread event backend | `thread.log` | 记录已脱敏 lifecycle 与挂载摘要，不嵌入指令正文。 |
| task/step/human input | 各自 store/backend | 对应 task、step、human-input 日志 | 作为通用恢复事实。 |
| Domain dynamic tool | `AgentDynamicToolBackend -> Domain` | RBT 为 `rbt-agent-tool-call.log` | Domain 自己记录输入和 Agent 可见输出。 |

重要约束：

- Dynamic Tool 和 MCP item 不属于 Activity。
- Domain dynamic tool 不进入通用 `AgentEvents.toolCall`；`AgentDynamicToolBackend` 发布 `DomainEvents.agentToolCall.observed`，由 Domain 自己消费。
- 通用 command log 故意不保存返回值。需要输入/输出证据的 Domain 应写自己的 telemetry 或 artifact。
- RBT history 保存真实宿主命令、stdout/stderr、Runtime request/result；它不能被通用 command log 替代。

## 4. Dynamic Tool 与宿主命令

### 4.1 通用边界

- `HostCommandExecutor` 只负责用 `execFile` 执行宿主命令，并规范化 status、exitCode、stdout、stderr、duration 和 error；它不解释领域结果。
- AgentBuilder 从 Worker profile 的 phases 调用 `domain.dynamicToolsForPhase(phase)`，再校验每个 Dynamic Tool 所需 guidance Skill 已挂载。
- `AgentDynamicToolBackend` 处理 `scout_agent_*` 内部工具；其它 namespace 交给当前 Domain，并携带 caller role、phase、threadId。
- RBT backend 按 phase 和 `namespace + tool` 找到已经创建的具体 tool 实例；没有注册即明确失败。

### 4.2 当前 RBT Dynamic Tools

| phase | namespace/tool | Agent 可见性 | 作用 |
| --- | --- | --- | --- |
| execute | `rbt_unity_pipeline/UnityPipeline` | 已注册 | 查询 Unity Pipeline 或控制 Editor Play Mode；当前 Executor 一般无需提前调用。 |
| execute | `rbt_behavior/JarvisBehavior` | 已注册 | 执行 execute-file，或做 execute phase 允许的只读预检。 |
| review | `rbt_behavior/JarvisBehavior` | 已注册 | 查询 campaign/evidence。 |
| internal | `rbt_websocket/JarvisWebSocket` | 已实现但未注册给 Agent | 被 Behavior Tool 用来建立、确认、复用和断开 WebSocket session。 |

`JarvisWebSocket` 的拼写已经统一，当前 Scout HEAD 包含 rename 提交 `7f24862`。不要恢复旧的 `JarvisWebsockt` 目录、namespace 或类名。

### 4.3 Behavior Tool 当前运行规则

- Behavioral endpoint 固定为 `ws://127.0.0.1:8083`。
- schema 只从调用 Agent 的 readable roots 中找到 basename 为 `gurusdk-unity` 的 managed codebase，再拼接 `gurusdk-framework/contracts/schemas`。
- 禁止为了找 schema 扫描 Showcase、Scout 或任意工程目录。
- Runtime 自动生成 request `version`、`correlationId`、session ID、endpoint、timeout 和 shell 参数；Agent 不填写这些字段。
- WebSocket 流程为 status -> connect（必要时）-> status 确认 endpoint -> config schema（每 session 一次）-> schema call。
- transport 或解析失败时会丢弃 session。第一次失败只在只读查询或明确 session disconnected 时允许重试一次；mutation 不做无条件重放。
- Agent 只看到简化后的 query payload 或 execute summary；真实 request/result 和宿主 I/O 进入 history/telemetry。

Execute phase 只读查询：

- `behavior.registry.nodes`
- `behavior.node.variants`
- `behavior.evidence.sources`
- `behavior.trigger.commands`

Review phase 只读查询：

- `behavior.campaign.query`
- `behavior.evidence.query`

### 4.4 Unity Platform Gate

当前只验证并支持 `unity_editor`：

1. `status` 必须发现恰好一个实例。
2. 实例必须为 `ready`。
3. `editor_status` 必须返回稳定结构。
4. `compiling` 和 `domainReloadInProgress` 必须为 `false`。
5. 不在 Play Mode 时调用 `editor_play`，随后再次用 `editor_status` 确认 `playing`。
6. 运行过程中 Unity version 不能变化。

Editor/App 的启动可用性由人工准备；Runtime 可以让已连接 Editor 进入 Play Mode，但不会搜索 Unity 工程或创建新的 Editor 实例。没有 Editor、实例不唯一、正在编译或 domain reload 时必须退出当前 RBT 操作。当前执行结束后不自动 `editor_stop`，Editor 可继续保持 Play Mode。

## 5. RBT Execute Artifact

### 5.1 Canonical layout

Executor 私有 artifact root：

```text
<artifactRoot>/
  <bdd-id>/
    <version>/
      execute-file.json
      execute-pack/
        execution-pack.md
        bdd-evidence.md
        code-evidence.md
        evidence/
          E-CODE-*.md
        journal-expected.md
        signal-expected.md
        human-input-evidence.md
        evidence-registry.md
  history/
    001.json
    002.json
```

- `<bdd-id>/<version>` 是 Pack 与 execute-file 的复用键，不包含 Scout run ID。
- `execute-file.json` 与 `execute-pack/` 都由 Executor 写。
- `history/<runtimeSequence>.json` 由 Runtime 写；Agent 不修改。
- Agent artifact 和 Runtime history 分目录，避免 writer 冲突。

### 5.2 Execution Pack 边界

Execution Pack 只保存 Executor 自己确认的：

- 唯一 BDD 来源与 Given/When/Then 定位。
- 当前版本的业务代码证据。
- Behavioral identity 与 required Given Hook capability mapping。
- 预期 Campaign Journal 顺序 `JR-*`。
- 预期 Signal、投影字段、具体值、match/not_match 条件和 code refs `SR-*`。
- 已被 Runtime 接受的 Human Input request/response 定位 `HI-*`。
- Agent 计划、限制和 artifact refs。

Pack 不保存实际 command result、host I/O、campaign journal、live evidence、cleanup 正文、平台证据或 Reviewer 结论。Pack `ready + complete` 只表示 Executor 作业完整，不表示 BDD 通过。

`JR-*` 和 `SR-*` 分别保存在独立文件中：

- `journal-expected.md` 只登记预期 record、关键 identity 和相对顺序。
- `signal-expected.md` 只登记预期 Signal、具体值和明确的匹配规则。
- `EXP-*`、`WF-*` 和旧 `execution-record.md` 已删除，不应恢复。

### 5.3 Execute file

`execute-file.json` 只包含：

```json
{
  "commands": [
    { "command": "behavior.campaign.start", "payload": {} },
    { "command": "behavior.scenario.activate", "payload": {} },
    { "command": "behavior.trigger.invoke", "payload": {} },
    { "command": "behavior.scenario.deactivate", "payload": {} },
    { "command": "behavior.campaign.stop", "payload": {} }
  ]
}
```

- 必须从唯一 `campaign.start` 开始，以唯一 `campaign.stop` 结束。
- 必须有唯一 activate、trigger、deactivate，并满足 activate < trigger < deactivate。
- `behavior.evidence.capture` 为零个或多个，不是每个 BDD 都必须 capture。
- `scenario.activate.payload.evidenceCapture` 可以声明 Hook 前/后自动 capture；具体观察时机由 Hook declaration 表达。
- campaignId/scenarioId 必须全程一致，且不能包含 Scout run ID。
- Runtime 校验文件后执行完整序列；Agent 不逐条执行 mutation，也不补发 cleanup。

### 5.4 Runtime execution history

每次执行生成新的 `history/<runtimeSequence>.json`。文件至少保存：

- `runtimeSequence`
- `executeFileRef`
- `platform.type/version`
- started/ended/status
- 每条命令的 sequence、Agent input、扩展后的 Runtime request/result、status/error
- 实际宿主命令及 stdout/stderr

历史文件不重复保存 artifact type/version、BDD ID 或目标版本；通过 `executeFileRef` 回到唯一的 `<bdd-id>/<version>/execute-file.json`。

## 6. RBT Review Artifact

Reviewer artifact：

```text
<reviewerArtifactRoot>/<bdd-id>/<version>/review-pack/
  review-result.json
  review-report.html
```

- Reviewer 只读 Execution Pack 和 Runtime history，不修改 Executor artifact。
- 默认审查与当前 execute-file 对应的最后一个 runtimeSequence；不能按 mtime 猜测。
- Reviewer 用自己的 `JarvisBehavior` 查询 campaign/evidence，不复用 Executor session，不 activate、不 trigger、不 cleanup。
- 每个 `JR-*`、`SR-*` 必须对应 HTML timeline 上的一个点。
- `match`：绿色圆点和勾。
- `warning`：黄色圆点和感叹号。
- `not_match`：红色圆点和叉。
- 总结果由渲染工具计算：任一红色为 fail；无红但有黄为 attention；全部绿色为 pass。
- `review-result.json` 由 Reviewer 写；`review-report.html` 必须通过 `rbt-review-report` 生成，不能手工维护 HTML/CSS。
- `executorHistoryRef` 必须指向实际 Runtime history 文件，保证报告能够追溯到执行侧。

## 7. Role 边界

### Coordinator

- 使用 Guru Knowledge 定位并完整读取唯一 Behavior。
- 核对 identity、Given、When、Then，形成稳定 BDD source ref。
- 只负责当前 phase 的 task assignment、formal handoff 消费和 phase outcome。
- 不读取或修改 Pack，不执行 Behavioral 命令，不替 Worker 做判断。
- 避免宽泛搜索；已知 BDD ID 时先直接定位，不先拉取大目录或完整 tool inventory。

### Executor

- 目标是高质量交付 execute-file 和 Execution Pack，不是解释命令实现。
- 先确认 BDD、版本和业务代码证据，再选平台并做 Runtime capability 预检。
- `behavior.node.variants` 必须发生在 campaign mutation 前，用来确认每条 required Given 可由当前 Hook 完整表达。
- 一次 workflow 只提交一次 execute-file，文件中只有一个 Scenario 和一个 trigger。
- 不复用 active scenario，不在同一执行中激活多个 Scenario。
- 不用 Runtime/Hook/schema/Gateway 实现冒充业务 code evidence。
- 不自判 BDD pass/fail；不匹配事实留给 Reviewer。

### Reviewer

- 独立读取 BDD、Pack 和明确的 Runtime history。
- 按 Interface 解释 Signal 预期，按 Via 定位并判断 actual Signal。
- `behavior_trace`、`error`、`state_snapshot` 分别按自己的 Signal contract 比较。
- State Snapshot 必须核对 capture declaration、source/capture identity、字段投影和具体值。
- 明确 not_match 是有效审查结论，不要求自动重跑。
- 只有无需新 Runtime 事实即可修正的 Pack 笔误或引用错误，才属于 correction。

## 8. Canonical Skill 与源码检索

当前 RBT 应优先使用：

- `domain-rbt-coordinator`
- `domain-rbt-executor`
- `domain-rbt-execution-pack`
- `domain-rbt-reviewer`
- `domain-rbt-review-pack`
- `tool-rbt-behavior`
- `tool-rbt-websocket`
- `tool-unity-pipeline`
- `signal-rbt-evidence`
- `signal-rbt-evidence-via-rbt-behavior`
- `signal-rbt-behavior-trace-by-rbt-evidence`
- `signal-rbt-error-by-rbt-evidence`
- `signal-rbt-state-snapshot-by-rbt-evidence`
- `signal-rbt-state-snapshot-via-rbt-behavior`
- `signal-account-state-by-rbt-state-snapshot`

旧 `tool-jarvis-behavior`、`tool-jarvis-websocket` 和 `tool-unity-pipeline-cli` 暂时保留用于对比，不是当前 RBT Agent 的主调用入口。

业务源码定位固定顺序：

1. `jarvis-codebase supported`
2. `jarvis-codebase <repo> path`
3. `jarvis-codebase <repo>` 读取 SDK version
4. 检查 CodeGraph index/status
5. 对已知文件或符号做窄查询
6. 回读实际源码
7. 只有窄查询失败才扩大范围

不要再做“先返回数百行候选，再寻找目标”的宽泛 CodeGraph 查询。

## 9. 已有真实运行证据

### 9.1 Account Restore，26.7

Run：`run/run-20260911T145912`

- BDD：`gurusdk.behavior.account-anon-restore-existing-account`
- Execution Pack：`agents/executor/artifacts/<bdd-id>/v26.7.0-rc.2/execute-pack/`
- Execute file：`agents/executor/artifacts/<bdd-id>/v26.7.0-rc.2/execute-file.json`
- Runtime history：`agents/executor/artifacts/history/001.json`
- History status：`completed`
- Platform：Unity Editor `6000.0.80f1`
- 完整执行了 campaign.start、scenario.activate、一次 trigger、capture、scenario.deactivate、campaign.stop。
- Reviewer 已生成 `review-result.json` 和 `review-report.html`。
- 审查结果为 attention：实际 trace 与 snapshot 值匹配，但单个恢复后快照不足以证明恢复前后 UID 连续性、具体 credential 对象复用，以及绝对没有创建新匿名账号。

已知缺陷：该 run 的 `review-result.json.executorHistoryRef` 指向不存在的旧 `runtime-execution.md`，而不是实际 `history/001.json`。因此这个 HTML 可以验证报告形态和审查内容，但执行历史追溯引用不合格；新 run 必须修正。

### 9.2 Firebase default fallback，26.7

Run：`run/run-20260912T041755`

- BDD：`gurusdk.behavior.firebase-remote-config-getter-default-fallback`
- Runtime history：`agents/executor/artifacts/history/001.json`
- History status：`completed`
- 未使用 capture。
- trigger 实际返回 `value: ""`，不是计划中的 `existing-default-value`。

这证明执行链闭合，不证明 BDD 匹配。该结果应由 Reviewer 作为实际不匹配或证据边界处理，不能因为 execute-file status completed 改写为通过。

### 9.3 版本边界

以上真实 artifact 都属于 `v26.7.0-rc.2`。当前 26.9 分支不能直接复用其结论；最多复用格式、执行思路和已确认的方法边界。

## 10. Guru SDK 与 Showcase 当前状态

### 10.1 gurusdk-unity

路径：`/Users/chengdai/Documents/UnityProjects/Castbox/Guru/gurusdk-unity`

- 分支：`sdk/v26.9.0-rc.2`
- HEAD：`73ed883`
- Framework 和 UniKit submodule 当前 dirty。
- `gurusdk-info` 有未跟踪 `.meta` 文件。
- 不要清理、reset 或覆盖这些内容。

### 10.2 gurusdk-framework

路径：`/Users/chengdai/Documents/UnityProjects/Castbox/Guru/gurusdk-unity/gurusdk-framework`

- 分支：`pr/v26.9.0-runtime-behavior-hook-websocket`
- HEAD/远端：`3e9f8c3c`
- 已合并上游：`origin/sdk/v26.9.0-rc.2@0c384447`
- `.specify/feature.json` 保留 `specs/20260909-004734-ad-impression-revenue-value`。
- 当前本地修改：
  - `Runtime/Account/AccountManager.Mock.cs`：测试入口调用 `RestoreAccountDirect`。
  - `Runtime/Assistant/.../AssistantPanel.asset`：既有用户改动。
  - `Runtime/Firebase/RemoteConfig/RemoteConfigManager.cs`：既有用户改动。
  - `Runtime/GuruSdk.cs`：既有用户改动。
  - `AppsflyerConversionDataTests.cs.meta`：未跟踪既有文件。
- `GuruAnalyticsBusinessTests` 的平台 guard 已由上游 `499b1519` 合入，不再是本地 dirty change。
- 未知改动不得擅自归类、提交或清理。

必须保留的 Framework stash：

- `scout-pre-merge-v26.9-latest-20260914`：最新 merge 前的本地修改安全副本；恢复时因同名 `.meta` 已存在而由 Git 保留。
- `scout-pre-v26.9-framework-generator-output-20260914`
- `scout-pre-v26.9-framework-20260914`

### 10.3 gurusdk-unikit

路径：`/Users/chengdai/Documents/UnityProjects/Castbox/Guru/gurusdk-unity/gurusdk-unikit`

- 分支：`sdk/v26.9.0-rc.2`
- 当前 HEAD：`ab96d80`，检查时落后远端 2 个提交。
- `GuruAnalyticsTests.cs` 有本地修复：测试 double 支持新的 first-open time API。
- FusionAds 有两个未跟踪 `.meta`。
- 必须保留 `scout-pre-v26.9-unikit-20260914` stash。

### 10.4 Showcase 与 package

路径：`/Users/chengdai/Documents/UnityProjects/Castbox/Guru/gurusdk-unity-showcasse/GurusdkShowcase`

- 外层仓库分支：`beta@0cf6fad`。
- 工作区存在大量与本轮无关的修改和未跟踪文件，禁止整体清理。
- `guru_visual` 已从 `Assets/Guru/guru_sdk.yaml` 移除。
- `manifest.json` 本来不负责记录本地软链接；不要因为软链接变化强制改写 manifest。
- 以下此前缺失的 UniKit package 链接已经存在：
  - `com.guru.unikit.shortcutitems`
  - `com.guru.unikit.native.channel`
  - `com.guru.unikit.native.contracts`
- 9 个 artifact package 已手动指向 `/Users/chengdai/Documents/UnityProjects/Castbox/Guru/guru-unity-artifact/<package>`：
  - `com.guru.artifact.gurusqlite`
  - `com.guru.artifact.analytics`
  - `com.apple.unityplugin.apple-gamecore`
  - `com.guru.artifact.fonts`
  - `com.guru.artifact.consent`
  - `com.guru.artifact.connectivity`
  - `com.google.play.games`
  - `com.guru.artifact.offlinelog`
  - `com.apple.unityplugin.apple-gamekit`
- `com.guru.artifact.fusionads` 当前不是选中 package，不应自行重新创建链接。
- `~/.guru/unity` 已按明确引用检查清理 60 个过期目录；当时确认剩余未引用目录为 0、broken cache links 为 0。

安装脚本最后一次完整执行完成了 package/link 阶段，但 GuruSDK lint 在 FusionAds 的 `MaxDisabledB2BAdUnitIds` 上失败。外层 `install.sh` 曾错误返回 0，因此后续必须检查正文结果，不能只看 shell exit code。

## 11. Unity 当前编译状态

最后一次检查时 Unity Editor 已关闭，`Temp/UnityLockfile` 是过期文件，Unity Pipeline `status` 返回没有实例。

此前编译错误及处理：

1. UniKit `RecordingAnalyticsAgent` 缺少新版 `Init(..., long)` 和 `GetFirstOpenTime()`：已在可写 UniKit 工作区本地修复。
2. Framework `AccountManager.MockApi.RestoreAccount` 调用已被重命名的 private 方法：已改为 `RestoreAccountDirect`，当前仍是本地修改。
3. Framework Analytics 测试在非 Android/iOS Editor 调用平台 API：上游提交 `499b1519` 已修复并合入当前分支。
4. Showcase `MaxGuruAds` 错误来自旧编译日志；当前 `DemoProtocal.cs` 已注释 `MaxGuruAds` 并使用 `GuruFusionAds`，但仍需新的 Unity 编译确认。

所以当前正确结论是“已修源码，尚未获得 26.9 Unity 干净编译证据”，不是“编译已通过”。

## 12. 权限与环境注意事项

- `rbt-execution` 和 `rbt-review` 当前都设置了 `network: true`。这意味着相应 Agent permission profile 具备网络能力；是否能进一步收窄是已知优化项。
- Executor readable roots 包含 `~/.guru/knowledge` 和 `~/.guru/codebase/gurusdk-unity`。
- CodeGraph/Jarvis 的必要缓存目录可写；Execution Pack 只能写自己的 Agent artifact root。
- `TMPDIR` 来自宿主 Codex/Scout 进程环境；`SCOUT_TEMP_ROOT` 是每个 Agent 的 run-scoped writable temp。
- Domain Dynamic Tool 通过 `HostCommandExecutor` 使用宿主 `process.env`，不会依赖 Agent mount 中物化的 Unity/Jarvis shell wrapper。
- 裸命令名由宿主 PATH 解析；配置为绝对路径的 shell tool 不走 PATH 自适应。

## 13. 下一 thread 推荐顺序

1. 读取本文并检查 Scout、gurusdk-unity、Framework、UniKit、Showcase 的 `git status`。
2. 不处理 README、`docs/scout-design.md` 和 `.DS_Store`，除非用户明确要求。
3. 对齐 UniKit 最新上游时先检查本地 `GuruAnalyticsTests.cs` 是否已被远端等价修复；不要直接覆盖。
4. 启动人工准备的唯一 Showcase Unity Editor，等待 compile/domain reload 稳定。
5. 用 Unity Pipeline 检查 `status` 和 `editor_status`，取得 26.9 的真实编译证据。
6. 处理仍存在的编译错误；每一组修改都先列计划并确认。
7. 将 Jarvis managed codebase 从当前 `v26.7.0-rc.2` 明确切换/同步到用户要求的 `v26.9.0-rc.2`，并确认 path/version/schema。
8. 新建 Scout run，优先跑 `gurusdk.behavior.account-anon-restore-existing-account` 的完整 execute/review 链。
9. 检查 Executor 是否先形成 BDD/业务 code evidence/JR/SR，再只提交一次 execute-file。
10. 检查 Runtime history 是否为新的 sequence，且 platform version、全部 request/result、cleanup 完整。
11. 检查 Reviewer 是否引用实际 `history/<sequence>.json`，而不是旧 `runtime-execution.md`。
12. 检查最终 HTML timeline 的每个 JR/SR 点和总结果，不把黄色 attention 改写为 pass。

发现问题时按边界定位：

- BDD 找不到或重复宽泛搜索：检查 `tool-guru-knowledge` / Coordinator Skill。
- 业务源码满目录乱搜：检查 `tool-jarvis-codebase` / CodeGraph 窄查询规则和 managed codebase version。
- Unity 未发现、编译中或 Play Mode 失败：检查 Unity Pipeline 与 platform gate。
- WebSocket/session/schema 失败：检查 `JarvisWebSocketTool` 与 `JarvisBehaviorCommandRunner`，不要让 Agent 手工拼 shell。
- execute-file 校验或 cleanup 失败：检查 reader/runner/history，不让 Agent 逐条补命令。
- Pack 内容缺失：检查 Execution Pack templates 和 Executor Skill，不把职责塞进 Runtime。
- Review 预期判断错误：检查 Signal Interface/Via 和 Reviewer Skill，不修改 Executor 预期。
- HTML 或 history ref 错误：检查 Review Pack/renderer 和正式 handoff，不重新执行 RBT。

## 14. 当前验证命令

Scout：

```bash
npm run typecheck
npm run check
```

本次更新 handoff 前已经运行并通过 `npm run typecheck`；没有在本轮重新运行完整 `npm run check`。

真实 RBT 验证不能被 TypeScript 单测替代。最终必须同时具备：

- Unity 实际编译/运行状态；
- Executor canonical artifacts；
- Runtime `history/<sequence>.json`；
- Reviewer `review-result.json`；
- 可打开的 `review-report.html`；
- 与实际 history 对齐的 `executorHistoryRef`。

## 15. 一句话心智模型

Scout 负责约束 Agent workflow、事实流、权限和 artifact 边界；Executor 编排可复用的 RBT 计划，Runtime 承担 Unity/WebSocket/Behavioral 执行复杂度并保存真实 history，Reviewer 再以 Execution Pack 的预期和 Runtime history 的实际证据生成可追溯的人类报告。
