# Design

AIPane keeps conversationId and invocationId in one state value. Stop and IPC completion clear it only when the invocation matches. Both streamed projections and IPC replies leave cancelled turns unchanged.

The question bridge uses request.agent.id, with an explicit fallback only for legacy direct callers. It carries conversationId in the existing question event so the renderer does not guess ownership from its current tab. No persistence or task-creation contracts change.

React component tests delay the old IPC reply until after Stop and a second Send, then inject a new token. Main-side tests create questions owned by two agents and confirm cancelling one does not affect the other.
