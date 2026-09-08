// MIME / filename helpers shared between the IPC inbox handler
// (main/index.ts) and the AI tool surface (dsh-runtime.ts). Kept out of
// main/index.ts so the AI tool module can import these without dragging
// in the whole Electron app entry point (which would crash in test envs
// that don't mock electron-updater / app paths).

/** Map a MIME type to a default file extension. Returns "bin" for unknown
 *  image types. Used when writing a pasted-image blob to disk. */
export function mimeExt(mime: string): string {
  const m = /image\/([a-z0-9.+-]+)/i.exec(mime);
  if (!m) return 'bin';
  if (m[1] === 'jpeg') return 'jpg';
  return m[1];
}

/** Sanitize a user-supplied filename for safe use on disk (and on every
 *  OS the user might be on). Strips anything outside [A-Za-z0-9._-] and
 *  caps the length at 40 chars so the full path fits in 255 even with
 *  the ULID prefix. */
export function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
}
