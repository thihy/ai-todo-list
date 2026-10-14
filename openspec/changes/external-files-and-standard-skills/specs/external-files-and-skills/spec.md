## ADDED Requirements

### Requirement: Permission-aware external files
The application SHALL allow external file reads under full access and SHALL offer per-call confirmation or explicit read-only directories under restricted modes.

#### Scenario: Auto reads an unlisted external path
- GIVEN per-call confirmation is enabled
- WHEN Auto attempts an external file read
- THEN the user receives an approval request naming the path.

#### Scenario: Directory link escapes an allowed root
- GIVEN a link inside an allowed root points outside it
- WHEN a read targets an existing or missing descendant of that link
- THEN the root alone does not authorize the read.

### Requirement: Standard shared skills
The application SHALL discover user ~/.agents/skills and project .agents/skills and SHALL support configured additional directories without granting scripts automatic execution permission.

#### Scenario: Existing user skill
- GIVEN a skill bundle containing valid SKILL.md under ~/.agents/skills
- WHEN the application starts and the agent requests that skill
- THEN its metadata is discovered and its body can be loaded on demand.
