# Scout Session Handoff

本文档给后续 session 使用。当前基础设施已经可以支撑第一版业务层，不建议继续横向重构 infra；下一步应从 agent 业务职责、业务 schema、产物格式和纵向闭环开始。

## 当前状态

当前代码主线已经从旧 chat/session 流程切换到 Scout 自己的 runtime + agent 基础设施：

- `RunManager` 已接入 `prepareRuntimeRun()`；一个 run 会 materialize 多个 agent mount，并创建一个共享的 Codex app-server session/client 配置。
- `AssetStore` 负责按 agent profile materialize mount、生成 mount manifest、构建 Asset Commit，并暴露该 mount 的有效 trusted / writable roots。
- 每个 agent 有独立 mount：`coordinator`、`researcher`、`verifier`、`validator`。
- 每个 agent mount 会生成自己的 `mount/`、`artifacts/`、`logs/`；`prepareRuntimeRun()` 会把 mount preflight 和 Asset Commit 结果写入对应 agent 的 artifacts。
- `CodexAppServerClient` 已拆成 `startSession()`、`startThread()`、`startTurn()`、`awaitTurnCompletion()`、`runTurn()`，并实时消费 app-server JSONL。
- `AppServerEventStore` 是 app-server timeline/state 的归并层，维护 thread / turn / item / plan / goal / progress / request 状态。
- `AgentBackend` 负责 app-server dynamic tool backend、task state、notification、timeline 到 task/progress 的映射。
- `ScoutAgent` 代表一个 agent/thread 抽象，持有自身 task runtime、mount、thread record 和 turn 调用能力。
- `ScoutAgentOrchestrator` 是主业务循环，驱动 Coordinator 的 turn，消费全局 message queue，并把 worker notification / user input 投递回 Coordinator。
- CLI/interaction 现在只是 disclosure、input、notification 的交互端口，不承载业务逻辑。

## 如何启动当前基础设施

当前 `RunManager` 已经接上第一版启动链路，不要恢复旧 `chat-session` 流程。启动顺序是：

1. 为本次 run 生成 `runId` 和 run root。
2. 对 `coordinator`、`researcher`、`verifier`、`validator` 分别调用 `AssetStore.materializeMount()`。
3. 对每个 mount 调 `preflightCodexMount()` 做 Codex app-server mount preflight；preflight 结果写到该 agent 的 `artifacts/`。
4. 用 `AssetStore.buildCommit()` 生成该 agent 的 Asset Commit，并写到该 agent 的 `artifacts/`。
5. 汇总所有 agent 的 mount roots、`trustedRootsForMount()` 和 `writableRootsForMount()`。
6. 用汇总后的 roots 创建一个 `CodexAppServerClient` bundle；这一 run 只使用这个 app-server session/client，多个 agent 通过不同 thread 运行。
7. `RunManager.startRun()` 复用 prepared app-server client，创建 `AgentBackend`、Coordinator agent 和 `ScoutAgentOrchestrator`。
8. Coordinator 作为主 session loop 启动，researcher / verifier / validator 由 Coordinator 通过 tools 分配 task。

注意：当前还没有从自然语言直接生成 Scout Input 的完整业务链路。Understanding / Research 业务层下一步需要补。

## Agent 使用模型

当前角色枚举在 `src/agent/types.ts`：

- `coordinator`
- `researcher`
- `verifier`
- `validator`

每个 agent 都继承 `ScoutAgent`，不要再引入 registry 兼容层或旧 builder/executor 角色。

角色文件：

- `src/agent/roles/coordinator-agent.ts`
- `src/agent/roles/researcher-agent.ts`
- `src/agent/roles/verifier-agent.ts`
- `src/agent/roles/validator-agent.ts`

Agent instructions 从 mount 中读取：

- `assets/codex/agents/AGENTS.md`
- `assets/codex/agents/coordinator.AGENTS.md`
- `assets/codex/agents/researcher.AGENTS.md`
- `assets/codex/agents/verifier.AGENTS.md`
- `assets/codex/agents/validator.AGENTS.md`
- `assets/codex/agents/agent-profiles.json`

后续业务层优先改这些 AGENTS 文件和业务 schema，不要先重写 agent runtime。

## Coordinator 如何调 worker

Coordinator 通过 dynamic tools 与 runtime 交互。工具定义在 `src/agent/tools.ts`，执行后端在 `src/agent/backend/agent-tool-backend.ts`。

Coordinator 可用：

- `AgentTool`：创建或复用 researcher / verifier / validator，并分配 task。
- `SendMessage`：给已有 agent 或 task 追加消息。
- `TaskStop`：停止已有 task。
- `SyntheticOutput`：报告 Coordinator 综合状态或最终结论。
- `RequestUserInput`：Coordinator 和 worker 共用，用于向用户请求补充信息或确认。

Worker 可用：

- `TaskResult`：提交正式 task 业务结论。
- `RequestUserInput`：请求人工输入，统一回到 Coordinator 再转发。
- 其它工具由 agent profile / mount 决定。

约束：

- Coordinator 不能直接使用 `TaskResult`。
- Worker 完成任务必须调用 `TaskResult`。
- 如果 worker turn 正常结束但没有 `TaskResult`，`ScoutAgentTaskRuntime` 会把 task 标为 failed。
- `TaskResult(status="complete")` 必须提供至少一个 `evidence_ref`。
- 非 complete 状态必须提供 `blocker` 或 `next_step`。

## Task 与消息队列

Task 状态定义在 `src/agent/task/types.ts`。

当前业务终态：

- `complete`
- `prompt_required`
- `confirmation_required`
- `blocked`
- `insufficient_evidence`
- `failed`
- `stopped`

主 session 消息队列在 `src/core/queue/message-queue.ts`：

- `user_input` 默认 `next`
- `system_event` 默认 `next`
- `task_notification` 默认 `later`
- priority 顺序：`now` > `next` > `later`

worker 完成后：

1. worker 调 `TaskResult`。
2. `AgentToolBackend` 记录 outcome。
3. `ScoutAgentTaskRuntime` 触发 terminal event。
4. `AgentTaskBackend` 渲染 `<task-notification>` 并 enqueue 到全局 message queue。
5. `ScoutAgentOrchestrator` drain queue，notify interaction port，并把 `<queued-commands>` 注入 Coordinator 下一轮 prompt。

worker 请求人工输入时：

1. worker 调 `RequestUserInput`。
2. task 进入 `waiting_for_input`。
3. runtime enqueue `<user-input-request-notification>`。
4. interaction port 向用户提问。
5. 用户回答被渲染成 `<user-input-response>`，注入 Coordinator 下一轮。
6. Coordinator 再用 `SendMessage` 把明确选择或补充信息发回 worker。

## App-server Timeline 与 Progress

`CodexAppServerClient` 接收到 JSONL message 后，顺序必须保持：

1. emit raw message handler
2. `eventStore.ingestMessage(message)`
3. `publishTimelineSince(beforeSeq)`
4. 再处理 response / notification / server request 的控制逻辑

`AppServerEventStore` 当前维护：

- thread meta / order
- turn state
- final response delta
- goal state
- plan state
- item state
- progress items
- pending server requests
- timeline entries

timeline stream 类型：

- `lifecycle`
- `state`
- `plan`
- `item`
- `request`

`AgentBackend` 直接订阅 `appServer.onTimeline(...)`，按 `threadId` 找 agent；没有 threadId 或找不到 agent 时走 unbound 日志分支。

`AgentTaskBackend.consumeAppServerTimelineEntry()` 当前行为：

- item started/completed + progress item -> `interactionPort.publishProgress(...)`
- plan timeline -> 更新 active task 的 `plan`，并 disclose
- goal timeline -> 更新 active task 的 `goal`，并 disclose
- token usage -> 只写日志，不改 task state

后续 UI / TUI / GUI 应消费 interaction port 的 progress/disclosure，不要让 backend 负责渲染。

## 日志与产物

日志系统在 `src/core/logging/logger.ts`。

当前规则：

- run 级全局日志：`run/<run-id>/logs/runtime.jsonl`
- agent 级日志：`run/<run-id>/agents/<agent-id>/logs/runtime.jsonl`
- 有 `agentId` 的日志会写 agent logs，同时也写全局 logs。
- system/global 日志不带 `agentId`。
- logger 支持 `serializer` / `redactor` / `summarizer`。

主要产物：

- `run/<run-id>/agents/<agent>/artifacts/mount-preflight.json`
- `run/<run-id>/agents/<agent>/artifacts/asset-commit.json`
- `run/<run-id>/agents/coordinator/artifacts/run-preparation-artifact.json`
- `run/<run-id>/agents/coordinator/artifacts/agent-ledger.json`

当前没有恢复/回滚系统，task state 主要在内存中，ledger 是调试和审计辅助。

## Asset / Mount 使用方式

AssetStore 文件：

- `src/asset-store/asset-store.ts`
- `src/asset-store/materialize.ts`
- `src/asset-store/preflight.ts`
- `src/asset-store/commit.ts`
- `src/asset-store/mount-helpers.ts`
- `src/asset-store/mount-macros.ts`
- `src/asset-store/asset-layout.ts`

资产来源：

- `assets/codex/agents/`
- `assets/codex/config/`
- `assets/codex/skills/`
- `assets/codex/tools/`
- `assets/codex/mcp/`

当前没有 `assets/codex/manifest.json`。`AssetStore` 直接读取固定 asset layout：

- `assets/codex/agents/agent-profiles.json`：每个 agent 的 profile。
- `assets/codex/tools/shell-tools.json`：shell tool registry。
- `assets/codex/mcp/servers.json`：MCP server registry。
- `assets/codex/skills/`：skill 源目录。
- `assets/codex/plugins/`：plugin 源目录。
- `assets/codex/config/`：Codex base config。

每个 agent 的可见能力只由 `agent-profiles.json` 决定。后续不要把所有 skills/tools/mcp 一股脑塞给所有 agent；必须通过 profile 控制每个 agent 的可见资产。

Profile 字段语义：

- `config`：相对 `assets/codex/` 的 base config 路径。
- `skills`：可挂载 skill 名称列表，对应 `assets/codex/skills/<name>/`。
- `shellTools`：可选；省略等于不挂载 shell tool。引用短 id，例如 `scoutAssets`、`rg`、`git`、`codegraph`，不要使用 `shellTools.*` 前缀。
- `mcpServers`：MCP server 名称列表，对应 `assets/codex/mcp/servers.json`。
- `plugins`：plugin 名称列表，对应 `assets/codex/plugins/`。
- `trustedRoots` / `writableRoots`：该 agent 的读写边界。

Root 配置支持：

- Runtime 宏：`${SCOUT_MOUNT_ROOT}`、`${SCOUT_ARTIFACT_ROOT}`、`${SCOUT_REPO_ROOT}`、`${SCOUT_RUN_ROOT}`、`${SCOUT_ASSET_COMMIT_ID}`、`${SCOUT_RUN_ID}`。
- `~/`：展开到当前用户 home。
- 绝对路径。
- 相对路径：按 repo root 解析。

当前 worker 类 agent 是 `researcher`、`verifier`、`validator`。它们的 profile 已把 `~/.guru/knowledge` 配为 readable trusted root，把 `~/.guru/codebase` 配为 writable root。已有测试覆盖这些路径的 profile 展开。

当前实现为每个 agent 独立 mount root：

- mount root：`run/<run-id>/agents/<agent>/mount`
- artifacts：`run/<run-id>/agents/<agent>/artifacts`
- logs：`run/<run-id>/agents/<agent>/logs`
- app-server thread cwd 应使用该 agent 的 `mountRoot`
- `mount-manifest.json` 写在该 agent 的 `mountRoot`
- manifest 内部路径应保持相对路径记录，运行时再 resolve 成绝对路径

Materialize 会生成：

- `AGENTS.md` 和 role AGENTS 到 mount。
- `.codex/config.toml`，其中 PATH 优先 `mountRoot/bin`。
- `.codex/hooks.json`。
- `.agents/skills/` 和 `.agents/plugins/`。
- `bin/<exposeAs>` shell wrappers。
- `mcp/<server>` wrappers。
- `mount-manifest.json`。

Shell tool 规则：

- `shellTools` registry 路径是 `assets/codex/tools/shell-tools.json`。
- profile 只引用短 id。
- `bin/<exposeAs>` 统一生成 shell wrapper，不切成 symlink / wrapper 两套模型；即使是 `cat`、`sed`、`rg` 这类纯转发命令也保持 wrapper，方便后续加 env、审计和权限门禁。
- registry 里的 command 可以是可执行名，也可以是绝对路径；不带 `/` 的 command 会按当前 PATH 解析成真实可执行文件后写入 wrapper。
- `rg` 必须配置为 `"command": "rg"`，不要写死 VS Code / ChatGPT 扩展里的版本化绝对路径，否则扩展升级后 materialize 会失败。
- 找不到 command 时不 throw；写入 `mount.issues` 和 manifest `issues` 后继续。
- `required: true` 记为 `severity: "error"`；`required: false` 记为 `severity: "warning"`。
- 找不到的 shell tool 不会进入 `mount.shellTools`、manifest `shellTools` 或 `bin/`。

MCP server 规则：

- MCP registry 路径是 `assets/codex/mcp/servers.json`。
- registry 里可以保留 `codegraph` 配置；agent profile 默认不要配置 `codegraph` MCP。
- 当前 `codegraph` 以 shell tool 方式给 researcher/verifier 使用；如果后续要启用 CodeGraph MCP，需要提供 required binding，例如 repo `path`，并保证 wrapper 依赖可用。
- profile 未列出的 MCP server 不会进入 mount config，也不会增加 trusted / writable roots。

Asset Commit 使用方式：

```ts
const store = new AssetStore();
const mount = store.materializeMount({ repoRoot, runId, agentId });
const preflight = await preflightCodexMount(mount);
const assetCommit = store.buildCommit({
  mount,
  preflightStatus: preflight.status === "passed" ? "passed" : "failed",
  preflightPath,
});
```

`AssetStore.buildCommit()` 是构建 Asset Commit 的唯一入口；不要在 RunManager / AgentBackend 里手拼 commit。`prepareRuntimeRun()` 还会检查 `mount.issues`，只要存在 `severity: "error"`，即使 preflight mock 返回 passed，commit 也必须按 failed 处理。当前第一版可以直接覆盖旧 AssetCommit；正在执行的 task 下一个 turn 才能看到新 materialize 的内容。

权限根使用方式：

- `AssetStore.trustedRootsForMount(mount)` = profile trusted roots + materialized MCP trusted roots。
- `AssetStore.writableRootsForMount(mount)` = profile writable roots + materialized MCP writable roots。
- app-server 创建 session/thread 前，必须把所有 agent mount 的有效 roots 汇总给 Codex 可访问目录配置；当前 `prepareRuntimeRun()` 已做这一步。
- 不要把没有进 profile 的本地目录隐式加进 Codex sandbox。

Preflight 边界：

- `src/agent-server/codex/mount-preflight.ts` 负责 Codex app-server 侧 mount preflight，包括 config/read、skills/list、plugin/list、hooks/list 和 required shell tool smoke。
- `mount-preflight.json` 不保存完整 `configRead`；只保存 `configLayers`，用于证明 Codex 读到了 isolated CODEX_HOME user layer 和 agent mount `.codex` project layer。
- `configRead.config` 和逐 key `origins` 不落盘，避免 artifact 过大且混入 Codex 内部调试细节。
- `src/agent/backend/thread-preflight.ts` 负责 thread preflight。
- 不要把 thread preflight 结果写回 Asset Commit 的 mount preflight。

## 业务层下一步

建议下一步从这条纵向闭环开始：

1. 定义 `ResearchArtifact` schema。
2. 定义 `VerificationReport` schema。
3. 定义 `ValidationResult` schema。
4. 更新 researcher / verifier / validator AGENTS，让它们按 schema 写 artifact，并用 `TaskResult` 返回 artifact/evidence refs。
5. Coordinator 根据 Scout Input 分配 researcher task。
6. Researcher 输出清理后的资料和引用。
7. Verifier 基于 researcher artifact 做 BDD 验证，寻找能证明场景成立或不成立的证据。
8. Validator 只检查 artifact 格式、必需字段、证据引用完整性和状态一致性，不做业务推理。
9. Coordinator 汇总并用 `SyntheticOutput` 披露最终状态。

业务理解边界：

- Researcher/Understanding 负责清理外部资料，不负责最终验证。
- Verifier 负责 BDD 验证：根据清理资料查看对应内容，寻找证据，判断当前 BDD 场景是否成立。
- Validator 负责结构、格式、必需条件、引用完整性，不需要懂业务。
- Coordinator 负责和用户沟通、派发任务、转发人工输入、综合最终报告。

优先不要恢复硬性的 Plan + Step Executor。当前方向是 agent 自己规划、自己执行、自己更新 plan/goal；runtime 负责记录真实 app-server 状态流、task 状态、日志、progress 和基本门禁。

## 测试

默认测试：

```bash
npm test
```

完整门禁：

```bash
npm run check
```

真实 Codex app-server smoke：

```bash
npm run test:integration
```

当前已覆盖：

- message queue priority / FIFO / snapshot
- dynamic tool schema 和 parser
- interaction XML / CLI render
- logger redaction / summarizer / serializer
- app-server event store reducer / timeline
- app-server client timeline publish 顺序
- AssetStore per-agent trusted / writable roots、`~/` 展开、本地相对路径解析
- AssetStore omitted `shellTools` 空集合语义
- AssetStore unresolved shell tool issue 记录和 mount 输出排除
- real mount preflight run 已验证 `run-real-preflight-20260629T085333`：coordinator / researcher / verifier / validator 均 `preflight_passed`，`rg --version` smoke passed。
- ScoutAgentTaskRuntime `TaskResult` 终态门禁
- AgenticLoop idle/error/stopped 行为
- real Codex app-server start session/thread/turn smoke

注意：测试会写 `dist/`，当前环境中可能需要 elevated filesystem access。

## 已知问题与不要做的事

已知问题：

- `docs/scout-design.md` 还保留较多旧设计语义，当前实现已经向更轻的业务 agent 模型移动；除非用户要求，不要主动重写设计文档。
- `README.md` 有改动，但不是本 handoff 的主线。
- 真实 app-server integration 会受本机 Codex 配置、模型 provider、插件 warning、网络状态影响；默认不要放进 `npm test`。
- task 恢复、回滚、持久化重放还没有实现。
- policy / approval / elicitation 目前仍较薄，app-server client 里还有 auto-accept 过渡逻辑。
- Understanding 从外部自然语言生成 Scout Input 的完整业务链路还没接。
- 不要把 shell tool registry 重新改成机器特定版本路径；优先使用 PATH 可解析 command，wrapper 会在 materialize 时固化到实际可执行路径。

不要做：

- 不要恢复旧 chat-session 流程。
- 不要做向后兼容 shim。
- 不要恢复 builder / reviewer / executor 三角色长期模型。
- 不要把 backend 变成渲染层；backend 只抛结构化数据。
- 不要让 task todo 取代 app-server plan/goal stream。
- 不要把 thread history 当作 Scout durable state；app-server 可能压缩上下文，权威状态必须在 Scout runtime artifacts / store / logs 中。
- 不要让 Coordinator 直接干 worker 的活；Coordinator 主要通过 tools 调度和综合。
- 不要在没有 `TaskResult` 的情况下把 worker 文本回复当作任务完成。
- 不要把所有 assets 全塞进所有 agent mount；使用 agent profile 控制可见资产。

## 推荐切入点

下一轮最有效的第一步：

1. 新建业务 schema 目录，例如 `src/business/schema/` 或 `src/domain/validation/`。
2. 先写 `ResearchArtifact`、`VerificationReport`、`ValidationResult` 类型和最小 validator。
3. 为这三个 schema 写单元测试。
4. 修改 `assets/codex/agents/researcher.AGENTS.md`、`verifier.AGENTS.md`、`validator.AGENTS.md`，要求 agent 输出对应 artifact 并调用 `TaskResult`。
5. 在 `AgentTaskBackend` 或新业务 service 中接入 artifact refs 的基本存在性检查。

完成这条后，再考虑 UI/TUI、恢复、policy、tool request、增量 asset reload。
