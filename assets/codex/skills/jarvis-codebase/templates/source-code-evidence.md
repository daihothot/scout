---
evidence_id: E-CODE-001
evidence_type: source_code
status: candidate
---

# E-CODE-001

## Artifact State

- status:
- blocking_items:
- failed_commands:
- retry_log:

状态枚举：

- status: candidate | source_verified | blocked

## Claim

-

## Repository Provenance

- root_repo:
- root_version:
- root_branch:
- root_commit:
- root_worktree_state:
- root_codebase_path:
- source_repo:
- source_version:
- source_branch:
- source_commit:
- source_worktree_state:
- source_codebase_path:
- gitlink_path:
- gitlink_commit:
- gitlink_matches_source_commit:
- codegraph_status:

## Replay Locator

- source_relative_file:
- source_file_worktree_state:
- canonical_locator:

## Primary Symbol

- name:
- type:
- start_line:
- end_line:
- signature:

## Key Lines

| line | reason |
|---:|---|
|  |  |

## Collection

- method:
- commands:
  - ``

## Supports

- VP-001
- F-001

## Limitations

- 源码 evidence 证明当前版本包含该实现；它不能证明该行为已经在运行时触发。
- 每个 `E-CODE-*` 只允许一个 primary symbol；多个独立 symbol 必须拆成多个 evidence artifact。
- `source_verified` 要求目标源码文件对 `source_commit` 保持 clean，且 `canonical_locator` 可由 `source_commit + source_relative_file` 重放。
