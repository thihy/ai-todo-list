// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect } from 'vitest';
import { AttachmentPreview, composerImageUrl } from '../../src/renderer/dsh/AttachmentPreview';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('composer attachment preview', () => {
  it('encodes only the basename for Windows and POSIX paths', () => {
    expect(composerImageUrl('C:\\inbox\\截图 #1.png')).toBe(`attachment://composer/${encodeURIComponent('截图 #1.png')}`);
    expect(composerImageUrl('/inbox/photo.png')).toBe('attachment://composer/photo.png');
  });

  it('renders an image thumbnail and falls back when the file is unavailable', async () => {
    const node = document.createElement('div');
    const root = createRoot(node);
    try {
      await act(async () => root.render(<AttachmentPreview path="C:/inbox/photo.png" mime="image/png" name="photo" />));
      const image = node.querySelector('img')!;
      expect(image.getAttribute('src')).toBe('attachment://composer/photo.png');
      expect(image.getAttribute('alt')).toBe('photo');
      await act(async () => image.dispatchEvent(new Event('error')));
      expect(node.querySelector('img')).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
