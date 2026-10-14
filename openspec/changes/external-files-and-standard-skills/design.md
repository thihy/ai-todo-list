# Design

## Context
DSH's write sandbox does not confine file reads. The host guard currently denies every external read. The installed skill provider resolves an empty agentsHome to cwd.

## Goals / Non-Goals
Allow intentional external access and shared standard skills. Preserve write sandboxing and application configuration protection. Do not implement a new operating-system sandbox or treat skill scripts as automatically authorized.

## Decisions
Persist deny/ask external-read policy, read-only roots and additional skill roots. Full-access sessions bypass file and command approval gates except application workspace mutation protection. Other external file reads return per-call ask decisions. Canonicalize existing ancestors for missing paths. In ask mode, Auto shell invocations also request confirmation because arbitrary command reads cannot be inferred from path parameters.

Explicitly initialize agentsHome to the user's .agents directory, preserve native project discovery and legacy .dsh compatibility, and pass additional roots at startup. Skill catalog changes therefore need restart; read policy changes are live.

## Risks / Trade-offs
The file allowlist is not an OS-level shell boundary. Native DSH sandbox escalation remains the path for restricted external writes. Referenced symlink targets outside allowed roots need separate read authorization.
