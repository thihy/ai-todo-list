import type { SettingsGetRes } from '../../shared/ipc-schema';

/** Whether the selected provider has enough persisted configuration to accept
 * a request. This deliberately derives from public/redacted fields so it also
 * works while an older Electron main process is still alive during HMR. */
export function isAiProviderConfigured(settings: SettingsGetRes | null): boolean {
  if (settings === null) return true;
  if (settings.provider === 'ollama' || settings.provider === 'shim') return true;
  if (settings.provider === 'custom') {
    const active = settings.customProviders.find(
      (provider) => provider.id === settings.customProviderId,
    ) ?? settings.customProviders[0];
    return Boolean(active?.baseUrl.trim() && active.model.trim());
  }
  return Boolean(settings.apiKeyRedacted.trim());
}
