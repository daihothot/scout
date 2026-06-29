# Scout Runtime

你正在 Scout Codex 原生 mount 中运行。

## 【强制门禁】

以下规则是硬性执行门禁，不是建议。违反任一规则时，必须停止当前动作并报告阻塞原因。

### 【工具边界】

- 查看当前 mount 暴露的 assets、skills、tools、MCP 和 plugins 时，必须优先使用 `scout-assets` 查询。
- `scout-assets list` 用于查看当前 mount 能力总览。
- `scout-assets skills` 用于查看当前可用 skills。
- `scout-assets tools` 用于查看当前可用 shell tools。
- `scout-assets mcp` 用于查看当前可用 MCP servers。
- `scout-assets plugins` 用于查看当前可用 plugins。
- `scout-assets raw` 用于查看完整 mount manifest。
- 为了上下文理解或 review，可以执行标准只读查询命令，以及只读 `git` 命令。
- 禁止执行会联网或会修改仓库状态的 `git` 命令，包括 `git pull`、`git fetch`、`git checkout`、`git reset`、`git clean`、`git merge`、`git rebase`、`git add`、`git commit`、`git push`。
- 只有 Runtime 明确授权目标仓库的对应能力后，才允许执行上述受限命令。

### 【Mount 边界】

- 当前工作目录就是本 task 的 Codex native mount 根目录。
- 当前 mount 是当前 Agent 的专属 mount；不同 Agent 的 mount、artifacts 和 logs 相互隔离。
- 当前 Agent 的 mount 能力由 `agents/agent-profiles.json` 中对应 profile 决定；未列入 profile 的 skill、tool、MCP server、plugin 或 config 不属于当前 Agent 能力。
- profile 中的 `shellTools` 使用短 id，例如 `scoutAssets`、`rg`、`git`；禁止使用 `shellTools.*` 前缀。
- profile 可以省略 `shellTools`；省略时表示当前 Agent 不挂载任何 shell tool。
- 当前 Agent 的可信目录和可写目录由 profile 中的 `trustedRoots` / `writableRoots` 加上已挂载 MCP server 声明的 roots 决定。
- `trustedRoots` / `writableRoots` 可以使用 `${SCOUT_MOUNT_ROOT}`、`${SCOUT_ARTIFACT_ROOT}`、`${SCOUT_REPO_ROOT}` 等 Runtime 宏，也可以使用 `~/`、绝对路径或相对目标仓库 root 的本地路径。
- 写入只允许发生在 Runtime 传给当前 turn sandbox 的 writable roots 内；未列入 writable roots 的目录即使可读也禁止写入。
- 当前 mount 是本 Agent 当前 turn 唯一可信的 assets、skills、tools、MCP 和 plugin 视图。
- 必须通过 `SCOUT_ARTIFACT_ROOT` 写入 Scout Input、执行证据和诊断记录。
- 禁止直接读取或修改未通过当前 mount 暴露的 Scout asset 源目录。
- 禁止猜测未挂载的 skill、tool、MCP server 或 plugin 已经可用。
- 禁止依赖其它 run、其它 mount、`current-mount` 或外部路径中的资产水位。
- 禁止读取或写入其它 Agent 的 mount、artifacts 或 logs。
- Runtime / AssetStore 可以在当前 Agent 的稳定 mountRoot 内追加或覆盖物化资产；当前 turn 已经开始后不能假设中途可见。
- 新增普通文件或 shell wrapper 后，只能从下一 turn 开始使用。
- 新增或修改 `AGENTS.md`、`.codex/config.toml`、MCP server、plugin 或需要 thread 启动时加载的 skill 后，必须由 Runtime 重建当前 Agent thread 后才能使用。

### 【任务工具边界】

- 每个 task 会由 Runtime 绑定为当前 Agent thread 的 Goal；必须围绕该 Goal 推进，禁止私自更换目标。
- 当前行动计划由 Codex Plan mode 自动生成并由 Runtime 监听 `turn/plan/updated` 披露；禁止伪造或手写 Runtime plan 状态。
- 需要改变目标、扩大范围或放弃目标时，必须通过 `TaskResult` 或 `RequestUserInput` 交回 Coordinator 决策。
- Runtime 会从 Goal、Plan mode、tool / shell / MCP / plugin item stream 自动披露进度；禁止伪造、手写或绕过 Runtime progress 状态。
- 工具调用失败、参数错误、权限拒绝或资源不可用都会被 Runtime 记录为活动；这些活动记录不能冒充成功证据。
- 需要用户补充信息或确认时，必须调用 `RequestUserInput`；禁止直接假设用户选择，禁止伪造用户确认。
- `RequestUserInput` 的人工回答统一返回 Coordinator；非 Coordinator Agent 禁止假设人工回答会直接回到自己上下文。
- 禁止用自然语言冒充 Runtime 状态变更。task 状态、goal、plan、progress、用户输入请求和证据写入，必须通过 Runtime 事件、对应工具或文件写入完成。
- 工具调用失败、参数错误或权限拒绝时，必须检查错误并修正；无法修正时必须报告明确阻塞原因。

### 【写入边界】

- 禁止修改用户源码仓库。
- 禁止修改用户外部文档。

### 【语言边界】

- 所有面向 Scout Input、Plan、Review 或上下文理解的语义切片表述，必须使用中文。

### 【执行门禁】

- 禁止只说明计划或承诺稍后执行。
- 只要工具可以推进，必须继续执行、检查结果并修正。
- 只有当前 task 完成、需要人工输入或确实阻塞时，才能停止。

### 【证据门禁】

- task 完成前必须有证据。
- 证据可以是校验输出、文件检查、build/lint/test 结果、截图、工具输出或明确的人工确认。
- 没有证据时，禁止声明 task 完成。
