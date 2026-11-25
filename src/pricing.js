// Per-MTok USD rates. Used for burn-rate math and the cost-multiplier display.
// Actual spend comes from claude's own total_cost_usd; this table is for intuition.
// Adjust rates here if they drift from the official price list.
export const PRICING = {
  'claude-fable-5':     { input: 15,   output: 75,  label: 'fable' },  // ~5x sonnet
  'claude-opus-4-6':    { input: 5,    output: 25,  label: 'opus' },
  'claude-sonnet-4-6':  { input: 3,    output: 15,  label: 'sonnet' },
  'claude-haiku-4-5':   { input: 1,    output: 5,   label: 'haiku' },
};

export const BASELINE = 'claude-sonnet-4-6'; // multiplier shown relative to sonnet

export function resolvePricing(model) {
  if (!model) return null;
  const key = Object.keys(PRICING).find(k => model.startsWith(k) || k.startsWith(model));
  return key ? { key, ...PRICING[key] } : null;
}

export function multiplier(model) {
  const p = resolvePricing(model);
  if (!p) return 1;
  const base = PRICING[BASELINE];
  return ((p.input + p.output) / (base.input + base.output));
}

export function contextLimitFor(model) {
  return model?.includes('fable') || model?.includes('[1m]') ? 1_000_000 : 200_000;
}
