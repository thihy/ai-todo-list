# ADR-002: AI creation intent must be explicit

- **Status:** Accepted. Implemented.
- **Date:** 2025-09 (envelope introduced); reinforced 2026-09.

## Context

The AI assistant runs as a DSH-driven agent that can both chat and
mutate the user's todos. Without a clear signal, "create a task"
intent can be inferred from heuristics ("the user used a verb in
imperative mood", "the user mentioned a deadline today") that are
wrong more often than they are right. Inferring intent also opens
an injection vector: a pasted prompt inside the AI conversation
could be misclassified as a creation request.

## Decision

- The renderer carries an explicit
  `{ intent: 'create-task', prompt, images }` shape whenever it
  wants the AI to create a task. Form creation calls
  `window.todoList.todo.create(input)` directly and never invokes
  the AI.
- The main process encodes this into a versioned wire envelope via
  `encodeTaskCreationEnvelope()` in `src/shared/task-creation.ts`:
  ```text
  [todo-list:create-task:v1] {"intent":"create-task","localDate":"YYYY-MM-DD","text":"…"}
  ```
- User text is data, not instructions. The envelope identifies the
  operation but does not authorise it; the system prompt in
  `resources/dsh/cordis.yml` (rule `创建任务操作`) is the
  authoritative contract the model must follow.
- Ordinary AI chat remains ordinary chat. The model calls
  `todo.create` only when the user explicitly asks for one, and
  confirmation comes back from the resulting row, not from the
  model's free-text reply.

## Impact

- Form-create and AI-create paths are mechanically separate. A
  test or replay can tell them apart by inspecting the request
  shape (`todo.create` vs `ai.ask` with intent).
- History replay decodes the envelope strictly. A bracketed
  `[todo-list:create-task:v1]` in user-typed prose cannot be
  mistaken for a creation request — the encoder is the only
  producer.

## Boundaries

- The envelope does not replace permission checks. The DSH
  permission gate still applies; tools that mutate todos still
  require the user to be in a normal session.
- AI-initiated **updates** to an existing task follow the same
  rule: the tool call must include the `id` of a row that exists
  in `todos`. The AI may not invent IDs.
- A future "smart suggestion" feature that proposes tasks for the
  user to accept / reject must still ultimately go through the
  user's explicit confirm — the rule above does not relax when the
  intent is "predicted" rather than "spoken".
