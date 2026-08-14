---
scout:
  resource:
    requirement: required
    description: Agent mount 与运行边界快照模板。
artifact_type: BoundarySnapshot
artifact_version: 1
status: draft
---

# Boundary Snapshot

## Snapshot Identity

- created_for:
- created_at:
- created_by:
- source_commands:

## Snapshot State

- status:
- completion_state:
- blocking_items:
- failed_commands:
- retry_log:
- limitations:

状态枚举：

- status: draft | ready | blocked
- completion_state: complete | partial | blocked

## Mount

- cwd:
- runRoot:
- agentId:
- mountId:
- assetCommitId:
- generatedAt:
- resourceHash:

## Profile

- skills:
- shell tools:
- MCP servers:
- plugins:

## Files

- linked files:
- generated files:
- mount manifest:

## Roots

- readable roots:
- writable roots:
- artifact root:

## Shared Memory

- codexHome:
- exists:
- readable:
- files:

## Replay Fields

- assets:
- linkedFiles:
- generatedFiles:
- shellTools:
- mcpServers:
- skills:
- plugins:

## Field Sources

- cwd:
- runRoot:
- agentId:
- mountId:
- assetCommitId:
- generatedAt:
- resourceHash:
- skills:
- shell tools:
- MCP servers:
- plugins:
- linked files:
- generated files:
- readable roots:
- writable roots:
- artifact root:
- codexHome:
- memory files:

## Limitations

-
