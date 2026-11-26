import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

// How to start the claude CLI WITHOUT a shell: { cmd, pre } -> spawn(cmd, [...pre, ...args]).
// Never go through cmd.exe when avoidable: it ends a command at the first newline,
// which silently cut multi-line args (system prompts) down to their first line
// and dropped every arg after them (e.g. --settings).
//   - native installer: claude.exe, spawned directly
//   - npm/pnpm installs: node cli.js
// null -> caller must fall back to a shell spawn with file-based args only.
export function resolveClaudeCommand() {
  const env = process.env.SKYLLA_CLAUDE_CLI;
  if (env && existsSync(env)) return env.endsWith('.js') ? { cmd: process.execPath, pre: [env] } : { cmd: env, pre: [] };
  let hits = [];
  try {
    hits = execSync('where.exe claude', { encoding: 'utf8' }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch { /* not on PATH */ }
  for (const hit of hits) {
    if (/\.exe$/i.test(hit) && existsSync(hit)) return { cmd: hit, pre: [] };
    const dir = dirname(hit);
    for (const rel of [
      'global/5/node_modules/@anthropic-ai/claude-code/cli.js', // pnpm layout
      'node_modules/@anthropic-ai/claude-code/cli.js',          // npm global layout
    ]) {
      const p = join(dir, ...rel.split('/'));
      if (existsSync(p)) return { cmd: process.execPath, pre: [p] };
    }
  }
  return null;
}
