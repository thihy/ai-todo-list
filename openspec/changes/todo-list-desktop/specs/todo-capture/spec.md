## Purpose

让用户以最低摩擦在桌面端随时随地采集 TODO，把瞬时想法、剪贴板片段、AI 解析的自然语言都汇入统一收件箱，避免遗漏。

## ADDED Requirements

### Requirement: Global quick capture
The system SHALL provide a global hotkey that opens a lightweight capture window within 200ms, even when the main app is hidden in the system tray.

#### Scenario: Capture via global hotkey
- **WHEN** the user presses the configured global hotkey while the main window is hidden
- **THEN** a capture input window appears at the cursor and accepts text submission
- **AND** submitting text creates a TODO in the `inbox` state and closes the capture window

#### Scenario: Capture while main window is focused
- **WHEN** the user presses the configured global hotkey while the main window is focused
- **THEN** focus moves to the inbox input and a new draft TODO is created

### Requirement: Clipboard-triggered capture
The system SHALL provide a "save selection as TODO" command (from the tray menu or global hotkey). When invoked, the system MUST capture the current clipboard contents (text or image) into a new inbox TODO.

#### Scenario: Save clipboard text as TODO
- **WHEN** the user triggers "save clipboard as TODO" and the clipboard contains text
- **THEN** a TODO is created in `inbox` with the clipboard text as title and a reference to the source application captured in metadata

#### Scenario: Save clipboard image as TODO
- **WHEN** the user triggers "save clipboard as TODO" and the clipboard contains an image
- **THEN** the image is saved into `~/.todo-list/inbox-attachments/` and attached to a new inbox TODO

### Requirement: AI parsed capture
The system SHALL support capturing TODOs via natural-language input parsed by the AI assistant (see `ai-assistant` capability), producing structured TODO metadata.

#### Scenario: Natural language input creates structured TODO
- **WHEN** the user types "明天上午 10 点和 Bob 评审登录页设计稿 #design !important @work" into capture
- **THEN** the AI parses it into a TODO with title, due date, tags, priority, and project pre-filled, and shows the parsed result before commit
- **AND** the user can accept or edit before saving

### Requirement: System tray actions
The system SHALL expose capture, view-inbox, and pause-clipboard-watcher actions in the system tray menu.

#### Scenario: Tray menu lists capture actions
- **WHEN** the user opens the tray menu
- **THEN** the menu shows "Quick capture", "Open inbox", "Pause clipboard watcher", and "Quit" items