// Shared Blob -> base64 `data:` URL encoder.
//
// All three paste-image surfaces (AI pane composer, centre Composer modal,
// task Markdown editor) hand the bytes to main over IPC as a data: URL
// string, because both call sites -- `app.importBlob` and
// `inbox.attachBlob` -- declare `dataUrl` in their channel contract.
// The conversion itself is a five-line FileReader dance, so it lives here
// once instead of being copy-pasted into every component that pastes.

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
