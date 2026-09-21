// decideMutatingToolGate — pins the auto-preset approval delegation.
//
// The `tools/pre-execute` listener in dsh-runtime.ts force-asks for
// write / edit / bash / pwsh. The auto-mode plugin (mounted from
// resources/dsh/cordis.yml) registers its own listener FIRST, so it may
// already have returned `allow` — and returning `{ kind: 'ask' }` from our
// listener then terminates the waterfall and discards the plugin's verdict.
// Delegating on the `auto` preset is what makes the integration do anything
// at all, so this branch is the load-bearing part of the whole feature.
//
// The listener itself only exists inside `bootDsh()` and needs a real Cordis
// dependency tree to run (see warmup-dsh-runtime.spec.ts). The branch
// decision is therefore extracted as a pure function and pinned here.

import { describe, expect, it } from 'vitest';
import { decideMutatingToolGate } from '../../src/main/dsh/dsh-runtime';

describe('decideMutatingToolGate', () => {
  it('delegates to the auto-mode plugin on the auto preset', () => {
    expect(decideMutatingToolGate('auto')).toBe('auto-passthrough');
  });

  it('force-asks on every other preset', () => {
    // The four presets cordis.yml declares, minus `auto`.
    expect(decideMutatingToolGate('read-only')).toBe('force-ask');
    expect(decideMutatingToolGate('workspace-write')).toBe('force-ask');
    expect(decideMutatingToolGate('danger-full-access')).toBe('force-ask');
    // Derived not-a-preset state from PermissionPresetService.
    expect(decideMutatingToolGate('custom')).toBe('force-ask');
  });

  it('force-asks when the preset cannot be resolved', () => {
    // permissionPresets service absent, or the session is not initialized
    // yet. Fail closed: the mandatory-approval contract still holds.
    expect(decideMutatingToolGate(undefined)).toBe('force-ask');
    expect(decideMutatingToolGate('')).toBe('force-ask');
  });

  it('does not treat a lookalike preset name as auto', () => {
    expect(decideMutatingToolGate('Auto')).toBe('force-ask');
    expect(decideMutatingToolGate('auto ')).toBe('force-ask');
    expect(decideMutatingToolGate('auto-mode')).toBe('force-ask');
  });
});
