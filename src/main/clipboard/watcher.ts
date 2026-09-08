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

  /** Triggered from tray menu. Captures current clipboard into a new TODO. */
  captureNow(): void {
    if (this.paused) return;
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
      const dir = join(app.getPath('userData'), '..', ROOT_DIR_NAME, ATTACHMENTS_SUBDIR);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${Date.now()}.png`);
      writeFileSync(file, image.toPNG());
      this.onImage?.(file, null);
      return;
    }
    const text = clipboard.readText();
    if (text) {
      this.onText?.(text, null);
    }
  }
}