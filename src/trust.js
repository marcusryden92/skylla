// Claude Code workspace trust. Until a folder is trusted, claude ignores the
// project's .claude/settings*.json permissions. Headless workers never see the
// trust dialog, so skylla asks instead and records the answer in ~/.claude.json.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const CONFIG = join(homedir(), '.claude.json');

// claude keys projects by cwd with forward slashes, compared case-sensitively,
// so "c:/x" and "C:/x" are different projects. Always use an uppercase drive.
export function normDir(dir) {
  const d = resolve(dir);
  return process.platform === 'win32' ? d.replace(/^[a-z]:/, m => m.toUpperCase()) : d;
}
const key = dir => normDir(dir).replace(/\\/g, '/');

function readConfig() {
  try { return JSON.parse(readFileSync(CONFIG, 'utf8')); } catch { return null; }
}

export function isTrusted(dir) {
  return readConfig()?.projects?.[key(dir)]?.hasTrustDialogAccepted === true;
}

export function trustDir(dir) {
  const cfg = readConfig();
  if (!cfg) return false; // never overwrite a config we couldn't parse
  const k = key(dir);
  cfg.projects ??= {};
  cfg.projects[k] = { ...(cfg.projects[k] ?? {}), hasTrustDialogAccepted: true };
  const tmp = `${CONFIG}.skylla-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, CONFIG);
  return isTrusted(dir);
}
