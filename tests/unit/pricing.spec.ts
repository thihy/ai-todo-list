// Unit tests for the pricing table. We do NOT validate the exact USD numbers
// (those can drift with DeepSeek's published pricing) — we validate that
// the shape is right: known models return non-zero cost, unknown models
// return zero, missing token fields don't blow up, and the relationship
// between input/output weights is preserved.

import { describe, it, expect } from 'vitest';
import { pricingFor, costForUsage } from '../../src/main/dsh/pricing';

describe('pricingFor', () => {
  it('returns rates for the two first-party models', () => {
    expect(pricingFor('deepseek-chat')).not.toBeNull();
    expect(pricingFor('deepseek-reasoner')).not.toBeNull();
  });

  it('returns null for unknown models', () => {
    expect(pricingFor('gpt-5')).toBeNull();
    expect(pricingFor('llama-3.1')).toBeNull();
    expect(pricingFor('')).toBeNull();
  });
});

describe('costForUsage', () => {
  it('zero for unknown models regardless of usage', () => {
    expect(costForUsage('gpt-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(0);
  });

  it('positive cost for a real turn', () => {
    const c = costForUsage('deepseek-chat', { inputTokens: 10_000, outputTokens: 1_000 });
    expect(c).toBeGreaterThan(0);
  });

  it('output tokens cost more than input tokens at the same volume', () => {
    const inOnly  = costForUsage('deepseek-chat', { inputTokens: 1_000_000, outputTokens: 0 });
    const outOnly = costForUsage('deepseek-chat', { inputTokens: 0, outputTokens: 1_000_000 });
    expect(outOnly).toBeGreaterThan(inOnly);
  });

  it('missing token fields default to zero (no NaN)', () => {
    const c = costForUsage('deepseek-chat', { inputTokens: 1000 });
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeGreaterThan(0);
  });

  it('matches the published rate exactly for chat (sanity check)', () => {
    // 1M input + 1M output at $0.27/$1.10 = $1.37.
    const c = costForUsage('deepseek-chat', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(c).toBeCloseTo(1.37, 5);
  });
});