---
scout:
  resource:
    requirement: optional
    description: 仅排查 macOS Pipeline listener prefix 兼容问题时读取。
---

# Pipeline Prefix Patch

本 reference 只处理 macOS Unity Editor 中，`com.unity.pipeline` 使用 `HttpListener` wildcard prefix 时出现的已知连接兼容问题。连接失败本身不是使用本 reference 的充分条件。

## Entry Gate

依次完成以下只读判断，全部成立后才能进入修复：

1. Target Contract 为 `editor`，操作系统为 macOS。
2. 当前 project path 已唯一确认，目标 Editor 正在运行。
3. `com.unity.pipeline` 已安装，当前唯一支持版本为 `0.4.0-exp.1`。
4. `unity status` 或 `unity list` 失败，且已经排除：
   - project path 错误或目标不唯一；
   - Editor 未运行或正在 domain reload；
   - Pipeline package 未安装或尚未完成编译；
   - instance descriptor、认证 token 或端口失效；
   - CLI 自身不可用、版本检查失败或普通瞬时连接故障。
5. Editor 日志能够把失败定位到 Pipeline server 启动时的 `HttpListener` prefix bind/listen，而不是其它连接阶段。
6. 当前 package cache 的 `Runtime/Common/BasePipelineServer.cs` 同时满足 Source Gate 和 Security Gate。

任一条件缺失时停止。不得用部署 patch 试探故障原因。

## Source Gate

从目标 project 的 `Packages/packages-lock.json` 确认 package 版本，再定位：

```text
<project>/Library/PackageCache/com.unity.pipeline@*/package.json
<project>/Library/PackageCache/com.unity.pipeline@*/Runtime/Common/BasePipelineServer.cs
```

要求：

- `package.json` 的 `name` 必须为 `com.unity.pipeline`。
- `package.json` 的 `version` 必须为 `0.4.0-exp.1`。
- `BasePipelineServer.cs` 必须只包含待修复签名：

```csharp
listener.Prefixes.Add($"http://+:{port}/");
```

- 如果已经包含以下签名，说明 patch 已应用，不得重复部署或重写：

```csharp
listener.Prefixes.Add($"http://*:{port}/");
```

- 两种签名同时存在、两种签名都不存在、存在多个匹配文件或 package version 不匹配时停止。

## Security Gate

`*` wildcard 会在 socket 层接受非 loopback interface，因此修改前必须确认同一个 `BasePipelineServer.cs` 仍具有全部保护：

```text
IPAddress.IsLoopback(remoteAddress)
request.Headers["Origin"]
IsAuthorized(request)
"Bearer "
```

这些事实分别证明：

- 非 loopback remote address 在路由前被拒绝；
- browser Origin request 被拒绝；
- 每个 request 进入路由前执行授权；
- bearer token 仍是认证协议的一部分。

任一保护缺失、位置无法确认或语义已经变化时停止。不得修改 source 来补造安全门禁。

## Approved Asset

批准的 runtime asset 位于本 Skill：

```text
assets/runtime/Assets/Skills/pipeline-prefix-patch.meta
assets/runtime/Assets/Skills/pipeline-prefix-patch/Editor.meta
assets/runtime/Assets/Skills/pipeline-prefix-patch/Editor/PipelinePrefixPatch.cs
assets/runtime/Assets/Skills/pipeline-prefix-patch/Editor/PipelinePrefixPatch.cs.meta
```

目标位置固定为：

```text
<project>/Assets/Skills/pipeline-prefix-patch.meta
<project>/Assets/Skills/pipeline-prefix-patch/Editor.meta
<project>/Assets/Skills/pipeline-prefix-patch/Editor/PipelinePrefixPatch.cs
<project>/Assets/Skills/pipeline-prefix-patch/Editor/PipelinePrefixPatch.cs.meta
```

部署会修改 Unity project，并在 Editor 导入后修改 `Library/PackageCache`、请求 domain reload。执行前必须获得明确授权。

部署规则：

1. 目标文件均不存在时，原样复制批准 asset 和 `.meta` 文件。
2. 目标文件已存在且逐字节相同时，不执行写入，继续验证。
3. 任一目标文件已存在但内容不同时停止；不得覆盖、合并或生成新的 GUID。
4. 不得把 asset 写入 `Packages`、`ProjectSettings` 或其它目录。
5. 不得直接编辑 `BasePipelineServer.cs`；只能由批准的 Editor asset 在代码内重复验证门禁后执行替换。

## Runtime Behavior

Unity 导入 asset 后，`PipelinePrefixPatch` 在 Editor load 的 delayed callback 中：

1. 读取 package cache 中的 package metadata。
2. 只接受 `com.unity.pipeline@0.4.0-exp.1`。
3. 再次验证唯一 source signature 和全部 Security Gate。
4. 只把 `http://+:{port}/` 替换为 `http://*:{port}/`。
5. 只在实际写入后请求一次 script reload。
6. package 已经处于批准结果时不写入、不 reload。
7. package version、source signature 或安全保护不匹配时拒绝修改并记录错误。

UPM resolve 可能恢复 package cache。只要批准 asset 仍在 project 中，它会在下一次 Editor load 重新执行相同门禁；不得因此放宽版本或安全检查。

## Verification

等待 Unity 完成导入和 domain reload 后，按顺序验证：

1. Editor Console 没有 `PipelinePrefixPatch` 拒绝、编译或 reload 错误。
2. `BasePipelineServer.cs` 包含批准后的唯一 `*` signature，且全部 Security Gate 仍存在。
3. 使用同一 project path 执行：

```text
unity --json --non-interactive status --project-path <absolute-project-path>
unity --json --non-interactive list --project-path <absolute-project-path>
```

4. `status` 必须唯一匹配原目标，`list` 必须返回该目标真实注册的 commands。

只有上述验证全部成功，才能把 prefix 兼容问题记为已修复。不得把 listener 能启动解释为任何具体 command 或业务结果成功。

## Failure And Retry

- asset 编译失败、门禁拒绝、domain reload 失败或重新连接失败时，保留 Editor 日志和实际 source 状态并停止。
- 不得反复复制 asset、反复请求 reload 或切换 project/Editor 来制造成功。
- source 已经修改但 response 丢失时，先检查文件和 Editor 状态，不得再次执行替换。
- 如果 `status` 或 `list` 仍失败，返回 `tool-unity-pipeline-cli` 的普通失败分类；不得继续扩大 patch 范围。

## Rollback

回退需要明确授权，并使用 Unity/UPM 的正常流程：

1. 移除已部署的 project asset 及对应 `.meta`。
2. 通过 Package Manager resolve/reinstall 恢复 package cache，不手工反向编辑缓存文件。
3. 等待编译和 domain reload 完成。
4. 确认 package source、Editor Console 和 Pipeline 连接状态。

不得在没有授权时自动删除 asset，也不得把回退动作作为连接失败后的自动重试。
