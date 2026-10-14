# Design

## Context
The host serializes runTurn per session and tracks one streaming invocation in the UI. DSH exposes followup and steer separately.

## Goals / Non-Goals
Allow further input during generation with explicit queue/steer actions and preserve authorization gates. Durable unsent queues across application restarts are outside this change.

## Decisions
Queue attachment/text snapshots in renderer state with synchronous ref admission/dispatch locks. A single dispatcher drains ordered eligible messages using their captured conversation IDs. Stop/error pauses that conversation; archived messages wait and deleted conversations remove pending messages. Keep the lazy pane mounted after its first opening so collapse does not destroy queues.

Expose ai.steer through all typed IPC layers. Validate conversation and active invocation, running state and cancellation/failure admission flags. Native steer injects a user message into the next-step inbox and leaves the existing stream owner attached. Return accepted=false for stale requests, enabling renderer queue fallback.

Persist aiEnterAction as queue/steer; Ctrl/Cmd reverses the choice. Protect IME composition and Shift+Enter. Filter only source.kind=skill-catalog from history, preserving literal user text.

## Risks / Trade-offs
Steering takes effect at the next step boundary. In-memory pending queues are lost on application exit or page reload; delivered steering is persisted in native session history.
