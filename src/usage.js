// Real Max-plan usage, read from the same (undocumented) endpoint the Claude
// Code CLI uses, with the locally stored OAuth token. May break on CLI updates;
// callers must treat null as "unavailable" and fall back to the eq estimate.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export async function fetchPlanUsage() {
  try {
    const creds = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'));
    const tok = creds.claudeAiOauth?.accessToken;
    if (!tok) return null;
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { error: r.status }; // 429 = rate limited: caller backs off
    const d = await r.json();
    const limits = d.limits ?? [];
    return {
      session: limits.find(l => l.kind === 'session')?.percent ?? null,
      weekly: limits.find(l => l.kind === 'weekly_all')?.percent ?? null,
      scoped: limits.filter(l => l.kind === 'weekly_scoped').map(l => ({
        name: (l.scope?.model?.display_name ?? '?').toLowerCase(),
        percent: l.percent,
      })),
      fetchedAt: Date.now(),
    };
  } catch {
    return { error: 'network' }; // offline, or endpoint changed shape
  }
}
