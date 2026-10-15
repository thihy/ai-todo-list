/** Persist document preferences, never an editor interaction or focus trap. */
const transient = new Set([
  'width', 'height', 'offsetLeft', 'offsetTop', 'collaborators',
  'openDialog', 'openSidebar', 'contextMenu', 'errorMessage', 'toast',
  'openMenu', 'openPopup', 'pasteDialog', 'activeEmbeddable', 'editingGroupId',
  'previousSelectedElementIds', 'hoveredElementIds', 'pendingImageElementId',
  'showHyperlinkPopup', 'editingFrame', 'isCropping', 'croppingElementId',
  'isLoading', 'editingElement', 'editingTextElement', 'editingLinearElement',
  'selectedElementIds', 'selectedGroupIds', 'selectedLinearElement',
  'draggingElement', 'resizingElement', 'selectionElement', 'newElement',
  'multiElement', 'isResizing', 'isRotating', 'isDragging', 'cursorButton',
]);

export function drawingDocumentState(state: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state).filter(([key]) => !transient.has(key)));
}
