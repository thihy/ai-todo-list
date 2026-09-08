// Clipboard monitor: "save clipboard as TODO" action from tray.

import { clipboard } from 'electron';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR_NAME, ATTACHMENTS_SUBDIR } from '../../shared/constants';
import { app } from 'electron';
import { logger } from '../logger';

export class ClipboardWatcher {
  private paused = false;
  private onText?: (text: string, sourceApp: string | null) => void;
  private onImage?: (filePath: string, sourceApp: string | null) => void;

  setHandlers(onText: typeof this.onText, onImage: typeof this.onImage): void {
    this.onText = onText;
    this.onImage = onImage;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    logger.info(`clipboard watcher ${paused ? 'paused' : 'resumed'}`);
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Triggered from tray menu. Captures current clipboard into a new TODO.
   *
   * Electron 36+ replaced the legacy synchronous `readImage`/`readBuffer` API
   * with the W3C `navigator.clipboard` shape: `read()` returns an array of
   * `ClipboardItem` objects keyed by MIME type, and each item's `getType(mime)`
   * yields a `Blob` you can read. `readText` also became async. We probe for
   * `image/png` first so the common case (image in clipboard) doesn't need to
   * pull the whole items array.
   */
  async captureNow(): Promise<void> {
    if (this.paused) return;
    if (await clipboard.has('image/png')) {
      const items = await clipboard.read();
      for (const item of items) {
        if (!item.types.includes('image/png')) continue;
        const blob = (await item.getType('image/png')) as Blob;
        const buf = Buffer.from(await blob.arrayBuffer());
        const dir = join(app.getPath('userData'), '..', ROOT_DIR_NAME, ATTACHMENTS_SUBDIR);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${Date.now()}.png`);
        writeFileSync(file, buf);
        this.onImage?.(file, null);
        return;
      }
    }
    const text = await clipboard.readText();
    if (text) {
      this.onText?.(text, null);
    }
  }
}