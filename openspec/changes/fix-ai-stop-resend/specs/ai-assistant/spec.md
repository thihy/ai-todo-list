## ADDED Requirements

### Requirement: Late replies preserve newer invocations
The renderer SHALL clear active streaming identity only for the matching invocation and SHALL preserve cancelled turn state against late IPC replies and stream projections.

#### Scenario: Stop then immediately send again
- **WHEN** a stopped invocation returns after a new invocation starts in the same conversation
- **THEN** the new response continues streaming and the old turn remains cancelled

### Requirement: Questions follow the calling agent
The question bridge SHALL use the calling agent ID for pending ownership and renderer routing.

#### Scenario: Two conversations ask questions
- **WHEN** one conversation is cancelled while another has a pending question
- **THEN** only the cancelled conversation's question is drained and the other question remains answerable
