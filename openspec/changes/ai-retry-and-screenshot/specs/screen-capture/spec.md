## ADDED Requirements
### Requirement: Window and region capture
The AI composer SHALL expose screenshot capture. On Windows the overlay SHALL highlight the visible window under the pointer. Users SHALL also be able to drag a custom region and move the selected region before confirmation.

#### Scenario: Window capture
- **WHEN** a user hovers over a window and selects it
- **THEN** its visible frame is highlighted for confirmation

#### Scenario: Manual capture
- **WHEN** a user drags over a display
- **THEN** the selected rectangle is shown and can be confirmed

### Requirement: Confirmed capture as an attachment
Only a confirmed capture SHALL be written to the existing composer inbox and attached to the original conversation or draft. Capture SHALL NOT send an AI request automatically.

#### Scenario: Confirm a capture
- **WHEN** a user confirms a selection
- **THEN** its PNG is attached, the main window is restored, and the user may review before sending

#### Scenario: Cancel capture
- **WHEN** a user presses Escape or cancels
- **THEN** all overlays close, no attachment is created, and the main window is restored

#### Scenario: Fractional DPI
- **WHEN** a display uses fractional scaling
- **THEN** the crop matches the selected DIP region using the actual captured pixel dimensions
