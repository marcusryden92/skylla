// Scratch probe: can we read Max-plan usage from the endpoint the CLI uses?
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const creds = JSON.parse(readFileSync(join(process.env.USERPROFILE, '.claude', '.credentials.json'), 'utf8'));
const oauth = creds.claudeAiOauth ?? creds;
const tok = oauth.accessToken;
console.log('token found:', Boolean(tok), '| expires:', new Date(oauth.expiresAt ?? 0).toISOString());

const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + tok,
    'anthropic-beta': 'oauth-2025-04-20',
  },
});
console.log('status:', r.status);
console.log((await r.text()).slice(0, 2000));
