# Architecture Decision Records

Short, durable records of architecture decisions made in this
repository. Each ADR follows the pattern: context → decision →
impact → boundaries. ADRs describe *what was decided* and
*why*; they are not implementation logs.

| Number | Title | Status |
| --- | --- | --- |
| [ADR-001](001-sqlite-is-source-of-truth.md) | SQLite is the source of truth; files are projections | Accepted |
| [ADR-002](002-ai-creation-intent-must-be-explicit.md) | AI creation intent must be explicit | Accepted |
| [ADR-003](003-dsh-integration-layer.md) | DSH enters the application through a stable integration layer | Accepted |
| [ADR-004](004-core-and-ai-independent-startup.md) | Core and AI use independent startup state | Accepted |
| [ADR-005](005-tag-catalog-must-not-rewrite-history.md) | Tag catalog mutations must not rewrite historical-task tags | Accepted |
| [ADR-006](006-json-rpc-bridge-capability-token.md) | JSON-RPC bridge is off by default and gated by a capability token | Accepted |

## How to add a new ADR

1. Copy this template, with the next number:

   ```text
   # ADR-NNN: short title

   - **Status:** Proposed | Accepted | Superseded | Deprecated.
   - **Date:** YYYY-MM.

   ## Context
   ## Decision
   ## Impact
   ## Boundaries
   ```

2. Replace the row in the index table above.
3. Link the new ADR from any document that benefits from the
   reference (typically
   [`docs/architecture.md`](../architecture.md)).
4. If the decision supersedes an older ADR, mark the older one
   `Superseded by ADR-NNN` and link forward — never delete
   history.

## ADR ↔ roadmap / proposals

- The forward-looking work in
  [`docs/architecture-improvement-roadmap.md`](../architecture-improvement-roadmap.md)
  may propose new ADRs (or amendments) as it lands. Until an ADR is
  written, the proposal is **not** an accepted decision — the source
  of truth is still the implementation.
- The historical proposals in
  [`docs/proposals/`](../proposals/) are not ADRs. They document a
  design at a specific point in time and may be partially
  implemented, abandoned, or superseded. Do not promote a proposal
  to an ADR without re-evaluating it against the current source.
