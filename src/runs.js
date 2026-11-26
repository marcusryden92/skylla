// Runs in a folder, most recently ACTIVE first (not most recently created):
// resuming should land on the conversation you were last working in, not on
// whichever run happened to be started last.
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const clean = s => String(s).replace(/[*#>`_]/g, '').replace(/\s+/g, ' ').trim();
const firstLine = text => (String(text).split('\n').map(clean).find(l => l.length > 3) ?? '').slice(0, 140);

// messages skylla itself sends; never a useful title
const AUTOMATED = /^(No initial task given|\[system\]|\[w\d+ report\]|You are (resuming|taking over))/;

// The first thing the user actually asked, from the orchestrator's saved
// transcript (runs from before titles were recorded in the manifest).
function firstUserMessage(cwd, sessionId) {
  if (!cwd || !sessionId) return '';
  const file = join(homedir(), '.claude', 'projects', String(cwd).replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  if (!existsSync(file)) return '';
  // only the head is needed; transcripts can be many MB
  const buf = Buffer.alloc(256 * 1024);
  let n = 0;
  try { const fd = openSync(file, 'r'); n = readSync(fd, buf, 0, buf.length, 0); closeSync(fd); } catch { return ''; }
  for (const line of buf.toString('utf8', 0, n).split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; } // last line may be cut off
    const c = e.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join(' ') : '';
    if (text && !AUTOMATED.test(text.trim())) return firstLine(text);
  }
  return '';
}

export function listRuns(runsDir) {
  if (!existsSync(runsDir)) return [];
  const out = [];
  for (const id of readdirSync(runsDir)) {
    const mf = join(runsDir, id, 'manifest.json');
    if (!existsSync(mf)) continue;
    let m = {};
    try { m = JSON.parse(readFileSync(mf, 'utf8')); } catch { /* unreadable: still listable */ }
    let replies = [];
    try { replies = readFileSync(join(runsDir, id, 'orch.log'), 'utf8').split('\n---\n').filter(r => r.trim()); } catch { /* none yet */ }
    const title = m.title || firstUserMessage(m.cwd, m.orchestrator?.sessions?.[0]);
    out.push({
      id,
      title: title || firstLine(replies[0] ?? '') || '(no messages)',
      titleFromTask: !!title,
      last: replies.length > 1 ? firstLine(replies.at(-1)) : '', // where it left off
      replies: replies.length,
      lastActive: statSync(mf).mtimeMs, // the manifest is rewritten after every turn
      cost: m.totalCost ?? 0,
      orch: m.orchestrator?.model ?? '?',
      workers: (m.workers ?? []).filter(w => !w.retired).length,
    });
  }
  return out.sort((a, b) => b.lastActive - a.lastActive);
}
