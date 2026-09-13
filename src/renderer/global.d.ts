// Splash control surface — written by the inline `<script>` block in
// src/renderer/index.html. Type declarations so main.tsx + the App bundle
// can call `window.__splash.{setPhase, showError, remove}` with full type
// safety.

import type { StartupPhase } from './ipc-schema';

export interface SplashApi {
  setPhase(phase: StartupPhase): void;
  showError(message: string, canReload?: boolean): void;
  remove(): void;
}

declare global {
  interface Window {
    __splash: SplashApi;
  }
}

export {};