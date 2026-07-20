# Scout Session Handoff

更新时间：2026-07-04

本文是给下一个 session 的工程交接。当前目标不是复述旧设计文档，而是记录当前代码中已经落地的架构、边界、使用规范、设计原则、注意事项、风险点和下一阶段方向。`docs/scout-design.md` 与 `README.md` 可能滞后，下一阶段应以源码和本文为准。

## 0. 当前结论

Scout 现在已经从“跑不起来的设计草稿”进入“基础设施可用、可继续扩展业务层”的阶段。

当前底层实现的核心使命是：

1. 可审计：所有关键运行事实必须能落到状态、timeline、log 或后续审计模块中。
2. 可重放：底层 event、task step、app-server timeline、asset commit、thread snapshot 需要足够结构化，为后续 replay 做准备。
3. 可历史积累：知识库、codebase、validation artifact 和历史验证结果后续要能沉淀为长期可检索资产。

当前基础设施基本具备继续接 `domain/validation` 业务闭环的条件，但审计、replay、历史积累模块本身还没有完整实现。后续工作应优先做最小 vertical slice，而不是继续大规模翻基础设施。

## 1. 总体分层

当前 Scout 按从内到外的层次理解：

1. Codex app-server client：JSON-RPC transport、thread/start、turn/start、dynamic tool server request、turn completion wait。
2. AppServerEventStore：把 app-server notification reduce 成 thread/turn/item/plan/goal 状态，并产出 timeline entry。
3. AgentBackend：连接 app-server timeline、dynamic tool call、agent registry、task backend、tool backend、domain backend。
4. AgentTaskBackend：任务状态入口、app-server timeline 到 task state 的 reducer、task event 记录。
5. AgentToolBackend：LLM dynamic tool_use 到系统能力和 domain 能力的执行入口。
6. ScoutAgent / AgentBuilder / AgentRegistry：创建真实 app-server thread，绑定 agent/thread，统一 runner。
7. AgentRunner：CoordinatorRunner 与 WorkerRunner 的执行循环。
8. EventBus / EventMailbox：模块间通信与 runner/orchestrator 的事件邮箱。
9. AgentOrchestrator：agent-domain 编排观察者，负责系统级 agent 调度事件，不负责 UI。
10. InteractionGateway / InteractionPort / TUI：唯一用户 IO 边界。
11. RunManager：run 生命周期编排，从 client/env/agent preparation 到 backend/domain/orchestrator/gateway。
12. Domain：业务层扩展点，目前是 `validation`，下一阶段要做真实状态投影。

名称边界：

- `system`：仅保留 runtime/interaction IO 边界事件。
- `agent`：agent 调度、task、interrupt、coordinator、orchestration、agent tools、agent attachments。
- `domain`：业务领域状态、schema、tool、reducer，例如 `domain.validation`。

不要把 agent-domain 的概念再叫 `system`。中断属于 agent，因为它中断的是 agent 调度。编排也是 agent 编排。

## 2. Codex App Server Client

关键文件：

- `src/agent-server/codex/app-server-client.ts`
- `src/agent-server/codex/app-server-event-store.ts`
- `src/agent-server/codex/app-server-factory.ts`
- `src/agent-server/codex/app-server-preflight.ts`

### 2.1 Client 职责

`CodexAppServerClient` 负责：

- 启动 `codex app-server` 子进程。
- 发送 JSON-RPC request。
- 接收 notification / response / server request。
- `initialize` + `initialized` session bootstrap。
- `thread/start` 创建 thread。
- `turn/start` 启动 turn。
- 等待 `turn/completed`，合并 final response、progress items、plan、goal。
- 提供 `turn/interrupt`，当前只接入能力，不主动使用。
- 提供 `thread/goal/set`。
- 接收 app-server server request，并通过 dynamic tool handler 执行。

重要原则：

- `thread/start` 只信 `thread.id`，其它 response 原样保存在 snapshot 里，不再把 response 其他字段当成稳定 contract。
- `runTurn()` 是 `awaitTurnCompletion()` + `startTurn()` 的组合，等待的是当前 thread 的 turn 完成。
- worker 调用 `RequestHumanInput` 后当前 turn 自然完成；task 保持 `running`，当前不主动调用 `turn/interrupt`。
- app-server response / notification 是底层事实源，但 Scout 业务状态不能只存在于 app-server thread history 中。

### 2.2 AppServerEventStore

`AppServerEventStore` 的职责是把 app-server 原始消息转成两类事实：

- 当前快照：thread、turn、item、plan、goal、tokenUsage、pendingRequests。
- timeline entry：只描述发生了什么，供 backend 消费。

timeline stream 当前有：

- `lifecycle`：thread/turn started/completed/status/name。
- `state`：goal、token usage。
- `plan`：`turn/plan/updated`。
- `item`：item started/completed、agent message delta。
- `request`：server request / resolved。

重要边界：

- `AppServerTimelineEntry` 是事件流事实，适合推给 backend。
- `AppServerResolvedTimelineEntry` 是在需要 reduce 到状态时，用 entry + 当前 store snapshot 查询出的视图。它不应该默认到处传播。
- `AgentTaskBackend.handleAppServerTimelineEntry(agent, entry, resolver)` 会在对应 stream 分支里按需调用 resolver。
- `agent_message_delta` 不写 runtime log，避免日志被流式 token 刷屏。
- `JSON-RPC response` 是 transport acknowledgement，不再写 timeline，否则会制造空日志。

### 2.3 Plan / Goal

Plan mode 已移除，不再使用 `collaborationModeId: "plan"`。

现在保留并依赖的是 app-server 内置 `update_plan` tool 产生的 `turn/plan/updated`：

- app-server thread 下会维护一个 thread-level plan。
- `AppServerEventStore` 把 `turn/plan/updated` reduce 到 `thread.plan`。
- `AgentTaskBackend` 消费 plan timeline，写入 task：
  - `task.plan`：最新 plan。
  - `task.planRecords`：所有 plan 记录，消费方取最后一个即可。
- 每个 worker turn 都通过 attachment 提醒模型使用 `update_plan`。

Goal 也是 thread-level：

- task 首次启动时，WorkerRunner 调用 `setGoal({ objective: initialPrompt })`。
- `thread/goal/updated` 被 event store reduce 到 `thread.goal`。
- `AgentTaskBackend` 写入 `task.goal`，覆盖保存最新 goal。

## 3. Run Client / Env / Agent Preparation

关键文件：

- `src/run/run-client-preparation.ts`
- `src/run/run-env-preparation.ts`
- `src/run/run-agent-preparation.ts`
- `src/run/run-manager.ts`

### 3.1 startRun 顺序

`RunManager.startRun()` 当前顺序：

1. 生成 `runId`。
2. 创建 `Logger`，日志目录为 `run/<runId>/logs`。
3. `prepareRunClients()`：构建 isolated Codex home/config，启动 app-server session。
4. `prepareRunEnvironment()`：materialize 每个 agent mount，做 app-server mount preflight，写 `app-server-preflight.json` 和 `asset-commit.json`。
5. 创建 `InMemoryEventBus`。
6. 创建并启动 `InteractionGateway`。
7. 创建 `ValidationDomain`。
8. `prepareAgents()`：创建 registry、task store、builder，构建所有 agent，并 eager start 所有 thread。
9. 创建 `AgentBackend`，注册 dynamic tool handler 和 app-server timeline handler。
10. `domain.start()`。
11. 创建并启动 `AgentOrchestrator`。
12. 注册 cleanup，包括 app-server close、domain stop、orchestrator stop、runner stop、gateway stop。

### 3.2 preparation 职责

`run-client-preparation`：

- 构建 root access plan。
- 读取 agent profiles 和 MCP config。
- 生成 isolated `.codex/config.toml`。
- 创建 app-server client。
- 调用 `startSession()`。

`run-env-preparation`：

- 只负责底层环境和 mount/preflight/asset commit。
- 不创建 app-server client。
- 不 build agent。

`run-agent-preparation`：

- 创建 AgentRegistry、AgentTaskStore、AgentBuilder。
- build coordinator + researcher + verifier + validator。
- 所有 agent 一起 `start()`，不是 lazy create。

重要原则：

- Worker 不是 lazy create。当前四个角色都在 run preparation 阶段创建并 start thread。
- AgentBuilder 只负责单个角色的创建和注册，不负责编排 run preparation。
- RunManager 负责 run 生命周期编排，但具体阶段逻辑放在 preparation 模块里。
- 不要恢复 `prepareRun`、`startWithPreflight`、`agent-thread-lifecycle` 这类旧层次。

## 4. Asset / Mount / Preflight

关键文件：

- `assets/codex/agents/agent-profiles.json`
- `assets/codex/tools/shell-tools.json`
- `src/asset-store/*`

当前每个 agent profile 控制：

- config。
- skills。
- shell tools。
- MCP servers。
- plugins。
- trustedRoots。
- writableRoots。

当前重要 roots：

- `~/.guru/codebase`
- `~/.guru/knowledge`
- `~/.guru/guru-jarvis/scripts`

Jarvis 和 codegraph 已加入 shell tool assets：

- `jarvis`：`/Users/chengdai/.guru/guru-jarvis/scripts/jarvis`
- `codegraph`：`/Users/chengdai/.npm-global/bin/codegraph`

重要原则：

- profile-driven visibility only，不要把所有资产 mount 给所有 agent。
- shell tools 通过 mount wrapper 暴露到 `mount/bin/<exposeAs>`。
- app-server preflight 文件名是 `app-server-preflight.json`。
- preflight 需要真实检查 config、skills、plugin、shell smoke、MCP smoke。
- 如果 preflight 失败，run preparation status 应该失败，不要绕过。

## 5. Agent Core

关键文件：

- `src/agent/core/scout-agent.ts`
- `src/agent/core/agent-registry.ts`
- `src/agent/builder/agent-builder.ts`
- `src/agent/thread/types.ts`
- `src/agent/thread/thread-preflight.ts`

### 5.1 ScoutAgent

`ScoutAgent` 是 thread 级实体：

- 一个 ScoutAgent 对应一个 app-server thread。
- 当前一个 run 对应一组 agent thread。
- 当前一个 worker runner 只拥有一个 active task。
- 一个 task 跨多个 turn。
- 一个 turn 包含多个 app-server item。

`ScoutAgent.start()`：

- 调用 app-server `thread/start`。
- 保存 `AgentThreadSnapshot`，包含 `threadId`、`spec`、`response`。
- registry 绑定 agentId/threadId。
- 调用 `checkThread()` 进行 thread preflight。

注意：

- `checkThread()` 当前在 start 后 await，名字是 thread preflight，不是旧 lifecycle。
- `AgentThreadSnapshot` 保存 response 和 spec。
- thread preflight 结果写入 `thread.threadPreflight`。

### 5.2 AgentRegistry

Registry 职责：

- 注册 agent。
- 绑定 threadId -> agentId。
- 根据 agentId 或 threadId 找 agent。
- dynamic tool call 进入时通过 threadId 找 caller。

Registry 不负责：

- 构建 agent。
- preflight。
- lifecycle。
- task 调度策略。

构建和注册由 `AgentBuilder` 完成，registry 只保存索引。

### 5.3 AgentBuilder

AgentBuilder 职责：

- 根据 role 组装 `ScoutAgentOptions`。
- 按 role 创建 CoordinatorAgent 或 Worker agent。
- 注入 agent tools + domain tools。
- 注册到 registry。

工具装配：

- Coordinator 可见 orchestration agent tools。
- domain tools 由 `domain.dynamicToolsForRole(role)` 提供。
- 一个 agent 只服务一个 domain。

不要把 prompt 或业务策略硬写进 builder。builder 是 construction layer，不是 policy layer。

## 6. AgentRunner / AgenticLoop

关键文件：

- `src/agent/core/agentic-loop.ts`
- `src/agent/runner/types.ts`
- `src/agent/runner/coordinator/coordinator-runner.ts`
- `src/agent/runner/worker/worker-runner.ts`

### 6.1 AgenticLoop

`AgenticLoop` 是底层循环工具，支持两种 loop：

- mailbox loop：`takeMailboxStep()` + `runMailboxStep()`。
- tick loop：`takeTick()` + `runTick()`，可返回 `continueAfterMs` 做连续推进。

使用规范：

- 基于 mailbox 的统一叫 `runMailboxStep`。
- 基于轮询/tick 的统一叫 `runXxxTick`。
- 不要在 runner 外手动绕过 loop 直接 run。

### 6.2 AgentRunner 抽象

当前抽象是：

- `AgentRunner`
  - `CoordinatorRunner`
  - `WorkerRunner`

外部不应该写 `hasTaskCapability` 之类的能力判断。

Coordinator 当前没有任务能力，默认 task 方法会抛错即可。外部使用统一 runner API，具体是否支持由 runner 实现决定。

### 6.3 CoordinatorRunner

CoordinatorRunner 是真实 agent runner，不是普通函数。

它订阅：

- `SystemEvents.interaction.userMessageSubmitted`
- `AgentEvents.orchestration.dispatchRequested`
- `AgentEvents.interrupt`

流程：

1. EventMailbox 收到事件。
2. `runMailboxStep()` 从事件 payload 读取 attachment。
3. attachment 进入 Coordinator pending message queue。
4. tick loop 检查 pending messages。
5. 有消息才启动 coordinator turn。
6. turn 完成后发布：
   - `AgentEvents.coordinator.turnCompleted`
   - 如果有 final text，发布 `AgentEvents.coordinator.messageProduced`

关键原则：

- Coordinator 的每条文本输出就是给用户的回复，由 InteractionGateway 渲染。
- Coordinator 收到的输入来自用户和 Orchestrator，都是 attachment。
- Coordinator 不应该绕过 event bus 直接和 UI 通信。
- Coordinator 不应持有业务状态，只通过 domain tool 或事件观察获取状态。

### 6.4 WorkerRunner

WorkerRunner 是 task executor。

当前约束：

- 一个 WorkerRunner 只拥有一个 active task。
- 不能给已有 active task 的 runner 再 assign 另一个 task。
- task 是上层 work 状态。
- turn 是 execution step。
- item 是 app-server 内部执行流。

WorkerRunner 任务流程：

1. `assignTask()` 创建 task，状态 `queued`，保存 `initialPrompt`。
2. 首次 tick 时：
   - 设置 app-server thread goal。
   - attach thread snapshot。
   - 发布 `task.threadAttached` 和可能的 `task.goalUpdated`。
3. 组装 turn prompt：
   - `agent.turn.use_update_tools()`
   - 初次使用 `initialPrompt`
   - 后续使用 `worker.turn.task_tick(...)`
   - pending messages
4. `appendTaskStep()` 创建当前 step。
5. 调用 `host.runTurn()`。
6. 根据结果更新 step、task、plan、goal、terminal 状态。
7. completed 且未 terminal 时通过 `continueAfterMs: 0` 继续下一轮 tick。

注意：

- WorkerRunner 当前依赖 `continueAfterMs: 0` 连续推进 running task；`takeTaskTick()` 本身不会直接因为 `running` 返回 task。下一阶段如果发现 task 观察事件不足，可优先检查这里。
- pending message 不等于 human response。只有 Runtime 通过专用回复入口包装的 `human-response` 才记录为 step 的 `humanInputResponse`。
- Agent 只传 Dynamic Tool 的纯语义字段，不负责猜测、拼接或补 Runtime tag。

## 7. Task Model

关键文件：

- `src/agent/task/types.ts`
- `src/agent/task/agent-task-store.ts`
- `src/agent/task/task-events.ts`

### 7.1 Task / Turn / Step 关系

当前语义：

- ScoutAgent：thread 级。
- thread：app-server 执行上下文。
- run：当前对应一组 thread。
- task：Coordinator 分派给 worker 的 work 状态。
- task step：一次 agent turn 的 task 侧记录。
- turn：app-server thread 上的一次模型执行。
- item：turn 内 app-server item。

不要再用 `TaskTurnRecord`，当前叫 `AgentTaskStep`。

### 7.2 Task 状态

枚举：

- `queued`
- `running`
- `done`
- `failed`
- `stopped`

已删除/不应恢复：

- `waiting_for_coordinator`
- `waiting_for_human_input`
- `humanInputReceived`
- `RequestHumanInput` 伪造成 terminal outcome
- parent task

规则：

- `RequestHumanInput` 不改变 task 状态；当前 task 保持 `running`。
- request 写入发起调用的已完成 step，response 写入实际消费回复的后续 step。
- request 和 response 之间允许存在其它普通消息和 step；Runtime 不创建待处理请求对象，也不把 response 解释为 task 状态恢复。
- `SubmitTask` 只提交当前一轮正式 outcome；成功投递后 task 进入可恢复的 `done`。

### 7.3 Human Input Flow

目标体验：用户感觉不到 worker 存在，但系统状态里能审计 worker 为什么停下、Coordinator 怎么追问、如何恢复。

流程：

1. worker turn running。
2. worker 调用 `RequestHumanInput` dynamic tool。
3. AgentToolBackend 校验调用者是 Worker，并确认它拥有 `running` task。
4. AgentToolBackend 将纯文本 request 包装为内部 `wait-for-human-request`，投递给 Coordinator。
5. 当前 turn 完成后，WorkerRunner 从成功的 tool call 把 request 写入当前已完成 step 的 `humanInputRequest`；task 仍为 `running`。
6. Coordinator 收到 Runtime 内部请求信封，向用户提出最小问题。
7. 用户回复进入 InteractionGateway，Coordinator 判断是否与原请求、task 和目标匹配。
8. Coordinator 调用 `RespondHumanInput`，传入原 task id 和纯文本 response。
9. AgentToolBackend 校验调用者是 Coordinator，将 response 包装为内部 `human-response`，投递给目标 Worker task。
10. WorkerRunner 将消息加入原 task 队列并启动后续 turn。
11. 后续 step 实际消费该回复时，从 prompt 中记录 `humanInputResponse`，并继续正常工作。

关键原则：

- InteractionGateway 不解 human input。
- 用户回复不直接喂 worker。
- Coordinator 是策略层，负责确认回复与原请求和 task 匹配。
- `SendMessage` 只承载普通消息，不能携带或伪装 human response。
- 不是所有 pending message 都是 human response。
- `wait-for-human-request` 和 `human-response` 只作为 Runtime 内部投递信封，不暴露为 Dynamic Tool 参数。
- AgentToolBackend 不发布 human input task 事件，也不直接修改 task state。

## 8. Agent Backend

关键文件：

- `src/agent/backend/agent-backend.ts`
- `src/agent/backend/agent-task-backend.ts`
- `src/agent/backend/agent-tool-backend.ts`

### 8.1 AgentBackend

AgentBackend 是 glue：

- 持有 registry。
- 创建 task backend。
- 创建 tool backend。
- 注册 app-server dynamic tool call handler。
- 注册 app-server timeline handler。

它处理 app-server timeline 的路径：

1. app-server notification 进入 client。
2. event store 产生 timeline entry。
3. AgentBackend 根据 threadId 找 agent。
4. 写 app-server timeline log。
5. 调用 `task.handleAppServerTimelineEntry(agent, entry, resolver)`。

### 8.2 AgentTaskBackend

职责：

- stop/get task。
- 消费 app-server timeline entry 并 reduce 到 task state。
- 订阅 `AgentEvents.task`，统一写 task 日志。

它不应该：

- 处理 SendMessage tool。
- 渲染 UI。
- 直接调用 interactionPort。
- 持有 Coordinator 私有 inbox。

timeline reduce：

- item stream：解析 progress item，写 `agent.progress` log。
- plan stream：`plan_updated` -> `task.plan` + `task.planRecords` + `task.planUpdated` event。
- state stream：
  - `goal_updated` -> `task.goal` + `task.goalUpdated` event。
  - `token_usage_updated` -> log。

### 8.3 AgentToolBackend

职责：

- 处理所有 app-server dynamic tool call。
- 先按 namespace 判断 agent tool 还是 domain tool。
- agent tool 自己处理。
- 非 agent namespace 交给 domain。

当前 agent tools：

- `AssignTask`
- `SendMessage`
- `RequestHumanInput`
- `RespondHumanInput`
- `SubmitTask`
- `ArchiveTask`

已删除/不应恢复：

- worker terminal outcome 伪装工具
- `TaskStop`
- `SyntheticOutput`
- role-bound tool parser 分散实现

当前 namespaces：

- `scout_agent_assigntask`
- `scout_agent_sendmessage`
- `scout_agent_requesthumaninput`
- `scout_agent_respondhumaninput`
- `scout_agent_submittask`
- `scout_agent_archivetask`
- domain 当前是 `scout_domain_validation`

注意：

- 命名当前用 underscore，app-server 可接受，不再做复杂编码。
- domain tools 属于 domain，不写进 agent backend 内置系统工具。
- `handleDomainToolCall` 当前仍存在，用于把未知 agent namespace 转给 domain。

## 9. Attachments / Context

关键文件：

- `src/agent/context/attachments.ts`
- `src/agent/context/agent-attachments.ts`
- `src/agent/runner/coordinator/coordinator-attachments.ts`
- `src/agent/runner/worker/worker-attachments.ts`

### 9.1 Attachment 基础规则

统一格式是 tag block：

```xml
<tag-name>
body
</tag-name>
```

`attachments` 提供：

- `compose(logger, ...blocks)`
- `addTagBlock(tag, body)`
- `removeTagBlock(text, tag)`
- `replaceTagBlock(text, tag, body)`
- `readTagBlock(text, tag)`
- `haveTagBlock(text, tag)`

`compose()` 只组装已经带 tag 的 attachment blocks，并检查格式。不符合格式的 block 不组装，并通过 logger 记录。

### 9.2 责任边界

谁发送 message，谁负责 add attachment tag。

入口层负责打 tag：

- InteractionGateway：用户输入 -> `coordinator.user(...)`。
- Orchestrator：dispatch/interrupt observation -> `coordinator.observation(...)`。
- AgentToolBackend：
  - `AssignTask.prompt` -> `agent.turn.message(...)`
  - `SendMessage.message` -> `agent.turn.message(...)`
  - `RequestHumanInput.request` -> `agent.turn.wait_for_human_request(...)`
  - `RespondHumanInput.response` -> `agent.turn.human_response(...)`
- WorkerAgent：`SubmitTask.outcome` -> `agent.turn.task_outcome(...)`

中间层不猜、不补、不转换 tag。接收方只识别自己关心的 tag。不带 tag 被忽略是发送方问题。

### 9.3 当前 tag

Agent context tags：

- `use-update-tools`
- `message`
- `task-outcome`
- `wait-for-human-request`
- `human-response`

Coordinator tags：

- `coordinator-user`
- `coordinator-observation`

注意：

- `wait-for-human-request` 和 `human-response` 的事实记录都在 task step 中，不新增 task 级等待状态。
- AGENTS 和 Skill 不说明 tag；tag 只由 Runtime 入口或 Dynamic Tool handler 添加。

## 10. EventBus / EventMailbox

关键文件：

- `src/core/events/event-key.ts`
- `src/core/events/event-catalog.ts`
- `src/core/events/event-bus.ts`
- `src/core/events/event-mailbox.ts`
- `src/system/events/catalog.ts`
- `src/agent/events/catalog.ts`

### 10.1 Event Key

event key/type 是对象，不是裸字符串。

字段：

- `scope`
- `group`
- `name`
- `tag`
- `routeKey`

route key 由 `scope.group.name.tag` 生成。`scope` 不是额外路由维度，它体现在 event key/type 本身里。

合法 scope：

- `system`
- `agent`
- `domain.${string}`

### 10.2 Catalog

core 只提供定义能力：

- `createEventCatalog(scope)`
- `event()`

模块自己 add：

- `SystemEvents = createEventCatalog("system")`
- `AgentEvents = createEventCatalog("agent")`
- 各模块通过 `SystemEvents.add(...)` 或 `AgentEvents.add(...)` 注册自己的事件。

只保留一种使用方式，不再导出 `AgentTaskEvents.xxx` 这种并行 catalog。

订阅可以订阅 task leaf event 或完整 `AgentEvents.task` group。

### 10.3 EventBus

`InMemoryEventBus` 支持：

- `publish()`：异步 fire-and-forget handler。
- `publishAndWait()`：等待所有 handler。
- `subscribe()`。
- `subscribeOnce()`。

当前无 causationId/correlationId。不要重新加。

### 10.4 EventMailbox

EventMailbox 是 runner/orchestrator 可复用的并发事件队列：

- 可订阅 event/group。
- 可加 filter。
- 收到事件后 push 到内部 queue。
- `takeAll()` 供 AgenticLoop 一次取一批。
- `onEvent` 触发 loop schedule。

CoordinatorRunner 使用 EventMailbox 接用户输入、orchestration dispatch、interrupt。

## 11. Agent Events

关键文件：

- `src/agent/task/task-events.ts`
- `src/agent/orchestration/orchestrator-events.ts`
- `src/agent/runner/coordinator/coordinator-runner-events.ts`

### 11.1 Task Events

Owner：

- WorkerRunner 发布 task lifecycle events。
- AgentTaskBackend 发布 app-server plan/goal reduce 后的 task events。

当前 task group：

- `assigned`
- `notAssigned`
- `messageQueued`
- `done`
- `archived`
- `stopped`
- `pendingMessagesDrained`
- `stepStarted`
- `stepCompleted`
- `failed`
- `planUpdated`
- `terminal`

### 11.2 Interrupt Events

Owner：

- AgentOrchestrator 发布 `AgentEvents.interrupt.*`。

当前 interrupt group：

- `raised`
- `resolved`
- `cancelled`
- `failed`

含义：

- 系统只需要知道 agent 调度中断/恢复。
- 中断为什么发生、恢复为什么发生，是触发事件的上下文，不应该让 interrupt 事件本身绑定某个业务细节。
- 目前 task human input requested/responded 是 interrupt raised/resolved 的触发源。

### 11.3 Orchestration Events

Owner：

- AgentOrchestrator 发布。

当前：

- `AgentEvents.orchestration.dispatchRequested`

用于让 CoordinatorRunner 收到结构化 observation，然后启动策略 turn。

### 11.4 Coordinator Events

Owner：

- CoordinatorRunner 发布。

当前：

- `AgentEvents.coordinator.turnCompleted`
- `AgentEvents.coordinator.messageProduced`

InteractionGateway 监听 `messageProduced`，渲染到用户 IO。

## 12. AgentOrchestrator

关键文件：

- `src/agent/orchestration/agent-orchestrator.ts`
- `src/agent/orchestration/orchestrator-events.ts`

Orchestrator 是 agent-domain 编排中心，不是 UI，不是 prompt renderer。

职责：

- 观察 agent/task 事件。
- 把 task human input requested/responded 映射为 agent interrupt raised/resolved。
- 在 agent loop 错误或需要策略调度时发布 `orchestration.dispatchRequested`。
- 给 CoordinatorRunner 发 observation attachment。

不负责：

- 渲染用户消息。
- 直接调用 interactionPort。
- 处理 prompt。
- 订阅自己发布的事件。
- 替代 task backend 消费 task event。
- 聚合事件后换一个名字再发无意义事件。

设计原则：

- 一个底层事件可以被多个模块按不同语义消费。
- 不要为了“统一”把事实事件包成另一种同义事件。

## 13. Interaction Layer

关键文件：

- `src/interaction/port.ts`
- `src/interaction/gateway/interaction-gateway.ts`
- `src/interaction/tui/*`
- `src/interaction/cli/*`

### 13.1 InteractionGateway

InteractionGateway 是唯一用户 IO 边界。

它做：

- port -> event：
  - `sendAgentMessage(handler)` 注册人类输入回调。
  - 人类输入被发布为 `SystemEvents.interaction.userMessageSubmitted`。
  - 输入 attachment 是 `coordinator.user(...)`。
- event -> port：
  - `SystemEvents.interaction.disclosureRequested` -> `interactionPort.disclose`
  - `SystemEvents.interaction.progressRequested` -> `interactionPort.publishProgress`
  - `AgentEvents.task` -> `interactionPort.publishTaskEvent`
  - `AgentEvents.coordinator.messageProduced` -> `interactionPort.receiveAgentMessage`
- exit：
  - port exit -> `SystemEvents.interaction.exitRequested`

它不做：

- 解析 human input response。
- 调 AgentTaskBackend。
- 直接 resume worker。
- 渲染 protocol 以外的业务 prompt。

### 13.2 RuntimeInteractionPort

当前接口：

- `disclose(event)`
- `publishProgress(event)`
- `notify(event)`
- `receiveAgentMessage(message)`
- `sendAgentMessage?(handler)`
- `onExitRequested?(handler)`

命名注意：

- `AgentMessageSend` 是人类发送给 agent 的 message。
- `AgentMessageReply` 是 agent 回给人类的 message。
- 交互层只做 send/receive/disclose/notify，不解 task human input。

### 13.3 TUI

TUI 当前是简单 Ink UI：

- `TuiStore` 保存 logs/tasks/progress。
- `TuiInteractionAdapter` 实现 RuntimeInteractionPort。
- `ScoutTuiApp` 渲染 Tasks、Progress、Timeline、输入框。

使用原则：

- TUI 不能依赖 `ScoutRunSession` 或 runtime 内部对象。
- UI 和 runtime 只通过 port 交互。
- 输入 message id 统一为 `user-message-${Date.now()}`。
- TUI 只是交互 adapter，不拥有业务状态。

## 14. Dynamic Tools

关键文件：

- `src/agent/tools/agent-tools.ts`
- `src/agent/tools/tool-profiles.ts`
- `src/agent/backend/agent-tool-backend.ts`
- `src/domain/validation/tools/validation-domain-tools.ts`

### 14.1 Agent Tools

当前保留六类 agent tools：

1. `AssignTask`
   - namespace：`scout_agent_assigntask`
   - Coordinator 创建/复用 worker 并分配 task。
2. `SendMessage`
   - namespace：`scout_agent_sendmessage`
   - 给已有 agent/task 追加普通纯文本消息。
   - Runtime 负责包装内部 `message` 信封。
3. `RequestHumanInput`
   - namespace：`scout_agent_requesthumaninput`
   - 仅 worker task 执行中请求人工输入。
   - request 是纯文本；task 保持 `running`。
4. `RespondHumanInput`
   - namespace：`scout_agent_respondhumaninput`
   - 仅 Coordinator 向原 Worker task 投递匹配的人工回复。
   - response 是纯文本，目标使用准确 task id。
5. `SubmitTask`
   - namespace：`scout_agent_submittask`
   - 仅 worker 可见，用于提交当前一轮正式 Markdown outcome。
6. `ArchiveTask`
   - namespace：`scout_agent_archivetask`
   - 仅 Coordinator 可见，用于归档 task 并释放 Worker runner。

原则：

- 工具 namespace 只分 agent/domain，不再按 role 细分。
- 工具 call parser 合并在 `parseAgentDynamicToolCall()`。
- 工具 handler 放在 `AgentToolBackend` 内部。
- AgentToolBackend 负责校验和投递，不直接修改 task state 或发布 task 事件。
- `SendMessage` 不放在 AgentTaskBackend。
- domain tool 通过 domain backend 处理。

### 14.2 Domain Tools

当前 validation domain tool：

- namespace：`scout_domain_validation`
- tool：`GetValidationStateSnapshot`

Coordinator 可以主动调用，用来观察 validation state。

当前 snapshot 仍是静态 reducer 输出，没有真实事件投影接入。下一阶段要补的是 live projection/state store。

## 15. Logging

关键文件：

- `src/core/logging/logger.ts`

当前日志文件：

- 全局：`run/<runId>/logs/runtime.log`
- 每个 agent mount logsRoot 也有 agent 侧 `runtime.log`

格式是文本 `.log`，不是 JSONL。

格式：

```text
2026/07/04 00:52:12.123 [Scout] [pid:<pid>/thread:<worker_thread_id>] [ I ] [module] [agentId/runtime] event=<event> task=<taskId> run=<runId>
```

规则：

- `[pid/thread]` 是 Node 进程/worker_threads thread id，不是 app-server thread id。
- app-server threadId 放在 body 数据里。
- 每条日志前空三行，便于读。
- JSON / XML / YAML 字符串会格式化多行输出。
- secret/token/password/api key/authorization 会 redacted。
- 长字符串和大数组会 summarizer 截断。
- `agent_message_delta` 不打印。

## 16. Domain / Validation

关键文件：

- `src/domain/types.ts`
- `src/domain/validation/domain.ts`
- `src/domain/validation/agent/backend/validation-domain-agent-backend.ts`
- `src/domain/validation/model/state-reducer.ts`
- `src/domain/validation/schema/*`
- `src/domain/validation/tools/*`

### 16.1 Domain 抽象

`ScoutDomain` 接口：

- `domainId`
- `name`
- `dynamicToolsForRole(role)`
- `handleDynamicToolCall(call)`
- `start()`
- `stop()`

Domain 是系统层和业务层的胶水抽象：

- RunManager 可以启动 domain。
- AgentBuilder 可以向 agent 注入 domain tools。
- AgentToolBackend 可以把 domain namespace 的 tool call 交给 domain。
- 一个 agent 当前只服务一个 domain。

### 16.2 Validation 当前状态

当前 validation 已有：

- schema generated files。
- state reducer。
- `GetValidationStateSnapshot` tool。
- `ValidationDomainAgentBackend`。

但还缺：

- 真实 validation state store。
- event/timeline/task outcome 到 validation observation 的 projection。
- BDD 输入接入。
- ResearchArtifact / VerificationReport / ValidationResult 的真实产物写入。
- Coordinator 基于 snapshot 的最小策略闭环。

下一阶段不要再先写大而全 schema。应该从一个最小 BDD validation vertical slice 开始。

## 17. 知识库 / Jarvis / Codebase 使用方向

可信根已在 agent profile 中配置：

- `~/.guru/knowledge`
- `~/.guru/codebase`

Jarvis codebase 命令可通过 mount shell tool 使用：

```bash
jarvis codebase supported
```

后续 validation 目标是：

1. 用户输入一个 BDD。
2. Coordinator 观察 validation state，确认缺少什么。
3. Researcher 使用知识库、Jarvis codebase、codegraph、rg 等检索所有有助于验证的证据。
4. Verifier 验证证据和代码片段。
5. Validator 给出 gate。
6. Coordinator 输出可审计验证报告。

报告必须可追溯：

- BDD 输入来源。
- 检索 query。
- 命中的知识库路径。
- 命中的代码片段路径和行号。
- codegraph/Jarvis 输出。
- worker artifact。
- task step / turn / item 证据。

## 18. 使用规范与硬约束

### 18.1 不要兼容旧逻辑

用户明确要求：

- 旧的不合适的东西直接删。
- 不要兼容层。
- 不要 transitional wrapper。
- 不要为了“以后可能用”保留绕路代码。

已删除/不要恢复的方向：

- `ScoutAgentOrchestrator` 旧命名。
- `runtime` 目录旧命名。
- `system-tools` / `system-attachments` 旧命名。
- `CoordinatorEvent` / `coordinatorThread` 这类角色绑定事件。
- `eventsForPrompt` 这类 Orchestrator prompt 处理。
- plan mode。
- worker terminal outcome 伪装工具。
- 独立 worker human input 直接接 UI。
- UI 直接依赖 runtime session。

### 18.2 编辑前先说明

下一个 session 继续改代码时，必须先明确说将要做什么，再改。尤其是架构性调整，先讨论边界，不要直接动。

### 18.3 只相信运行证据

架构判断要尽量通过：

- `npm run typecheck`
- 单元测试
- 集成测试
- 真实 run
- app-server timeline/log
- preflight artifact

不要只靠静态推理说“应该可以”。

### 18.4 Sender owns attachment

谁发消息谁打 tag。

不要在中间层：

- 猜消息类型。
- 自动补 tag。
- 根据 task 状态偷换成 human response。
- 解析业务语义并改写 message。

### 18.5 Render protocol belongs to interaction

渲染协议只能 interaction 层使用。

Orchestrator、backend、runner 不渲染 UI 文案，不调用 interactionPort。

### 18.6 EventBus 不替代底层执行流

底层 app-server item/turn/timeline 是执行事实。

EventBus 是中上层模块通信：

- task state events。
- interrupt events。
- orchestration events。
- interaction events。
- future domain events。

事件流会聚合到 state/timeline，然后由 backend/orchestrator/coordinator 产生更上层事件。EventBus 不替代 app-server timeline，也不替代 state store。

## 19. 当前可用验证命令

建议下个 session 开始先跑：

```bash
npm run typecheck
```

核心单测可按模式跑：

```bash
npm test -- --test-name-pattern "TuiStore|Logger|event bus|AgentBuilder|AgentOrchestrator maps task human input|agent dynamic tool specs|agent tool parsers|WorkerRunner|interaction gateway"
```

如果要真实启动 TUI：

```bash
npm run scout:tui
```

或检查 `package.json` 当前 scripts，避免命令名变更。

真实 run 后重点看：

- `run/<runId>/logs/runtime.log`
- 每个 agent artifact 下的 `app-server-preflight.json`
- 每个 agent artifact 下的 `asset-commit.json`
- app-server timeline log 中是否有 tool namespace、turn completed、plan updated、goal updated。

## 20. 下一阶段建议：Validation Vertical Slice

不要继续先写 AGENTS 和 Skill。下一步更应该先打通业务状态。

建议顺序：

1. 定义最小 validation input：
   - BDD 输入 observation。
   - 输入来源。
   - run/task/thread 归属。
2. 建立 ValidationStateStore：
   - 从 interaction user message 或 Coordinator 决策记录 BDD。
   - 从 task terminal/outcome/plan/goal 事件投影 worker observation。
   - 生成 `ValidationStateSnapshot`。
3. 改 `GetValidationStateSnapshot`：
   - 返回 live state，而不是静态空 reducer。
4. Coordinator 最小闭环：
   - 如果 `missing_bdd`，只问用户要 BDD。
   - 有 BDD 后调度 Researcher。
   - 不聊无关内容。
5. Researcher 最小任务：
   - 使用 Jarvis/codegraph/knowledge/rg 检索证据。
   - 输出 ResearchArtifact。
6. Verifier 最小任务：
   - 验证证据是否支持 BDD。
   - 输出 VerificationReport。
7. Validator 最小任务：
   - gate accepted / insufficient_evidence / blocked / failed。
   - 输出 ValidationResult。
8. Coordinator synthesis：
   - 输出可审计验证报告。

不要一次性生成完整复杂 schema。一个一个收敛。

## 21. 未来模块方向

### 21.1 Audit

当前日志和 task step 只是基础，不是最终 audit 模块。

未来 audit 应单独模块化：

- 订阅事件。
- 读取 app-server timeline。
- 读取 task store/domain state。
- 生成 append-only audit record。
- 建立 artifact ref/evidence ref。

不要在 runner/backend 里继续塞 `record*` 语义。当前代码已尽量改为 append/update/handle。

### 21.2 Replay

Replay 需要：

- run env snapshot。
- asset commit。
- app-server timeline。
- event stream。
- task state transitions。
- domain state transitions。
- interaction input messages。

当前结构已经为 replay 留了位置，但 replay runner 还没做。

### 21.3 Historical Accumulation

历史积累应沉淀到：

- `~/.guru/knowledge`
- `~/.guru/codebase`
- validation artifact index
- accepted verification report
- lessons learned / capability docs

不要把历史知识只留在 app-server thread history。

## 22. 已知风险和下次检查点

1. Worker running tick 行为

   - 当前 completed turn 后靠 `continueAfterMs: 0` 继续。
   - 如果要“running 每帧观察”，检查 `WorkerRunner.takeTaskTick()` 是否需要调整。
2. InteractionPort 命名

   - `sendAgentMessage` 是人类发送消息到 agent 的 callback 注册，名字仍可能让人误解。
   - 当前不要大改，除非继续梳理 port 命名。
3. Domain snapshot 仍是静态

   - `GetValidationStateSnapshot` 还没有真实 state store。
   - 这是下一阶段最核心缺口。
4. TUI 只是基础 UI

   - 输入框和 timeline 已可用，但仍需真实 run 继续观察光标/布局。
   - 不要让 TUI 拿 runtime 内部对象。
5. App-server tool namespace smoke

   - agent tools namespace 已改成 underscore。
   - 真实 run 时要观察 dynamicToolCall namespace 是否完全符合预期。
6. Docs 仍可能滞后

   - `README.md`、`scout-design.md` 不要作为当前实现依据。
   - 本文和源码优先。
7. Handoff 本身不是 proof

   - 下一 session 若要确认“已经可用”，必须跑 typecheck/test/run/log。

## 23. 下一个 Session 推荐开场动作

建议按这个顺序：

1. `git status --short` 看工作区。
2. 读本文。
3. 跑 `npm run typecheck`。
4. 跑核心单测。
5. 如果要接业务，先读：
   - `src/domain/types.ts`
   - `src/domain/validation/domain.ts`
   - `src/domain/validation/model/state-reducer.ts`
   - `src/agent/backend/agent-task-backend.ts`
   - `src/agent/runner/coordinator/coordinator-runner.ts`
   - `src/agent/runner/worker/worker-runner.ts`
6. 先实现 live ValidationStateStore/projection，而不是继续重构底层。

## 24. 当前心智模型一句话

Scout 不是聊天机器人壳子，而是一个以状态空间为核心的可审计 agent validation runtime：app-server 提供执行流，event store 固化底层事实，agent backend 把事实归并为 task 状态，event bus 驱动中上层模块通信，Coordinator 作为策略 agent 观察状态并调度 worker，worker 只执行 task，InteractionGateway 是唯一用户 IO 边界，domain/validation 才是下一步要补齐的业务状态空间。
