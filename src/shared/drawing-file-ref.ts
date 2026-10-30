/** Opaque file locator, derived without a database row or persistent index. */
export function drawingFileId(todoId: string, fileName: string): string {
  return 'file:' + encodeURIComponent(todoId) + ':' + encodeURIComponent(fileName);
}
