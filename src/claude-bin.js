import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Resolve the real cli.js behind the `claude` shim so we can spawn
// `node cli.js ...` directly: exact argv, no shell quoting issues.
export function resolveClaudeCli() {
  if (process.env.SKYLLA_CLAUDE_CLI && existsSync(process.env.SKYLLA_CLAUDE_CLI)) {
    return process.env.SKYLLA_CLAUDE_CLI;
  }
  let candidates = [];
  try {
    const out = execSync('where.exe claude', { encoding: 'utf8' });
    candidates = out.split(/\r?\n/).filter(Boolean).map(dirname);
  } catch { /* fall through */ }
  for (const dir of candidates) {
    for (const rel of [
      'global/5/node_modules/@anthropic-ai/claude-code/cli.js', // pnpm layout
      'node_modules/@anthropic-ai/claude-code/cli.js',          // npm global layout
    ]) {
      const p = join(dir, ...rel.split('/'));
      if (existsSync(p)) return p;
    }
  }
  return null; // caller falls back to shell spawn
}
