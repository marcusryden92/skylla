#!/usr/bin/env node
// Demo mode: the real dashboard driven by fake sessions. No claude processes,
// no spend. Workers stream scripted-but-shuffled activity, finish, and get
// replaced by fresh ones. You can type to the orchestrator and /allow | /deny
// the fake permission prompts.   Run: node src/demo.js
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';
import { MODEL_ALIASES } from './orchestrator.js';
import { COLORS } from './worker.js';

const pick = a => a[Math.floor(Math.random() * a.length)];
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const hex = n => [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

// --- fake session: just enough surface for server.js serializeWorker() ---
class FakeWorker {
  constructor({ name, model, color, task }) {
    Object.assign(this, { name, model, color, task });
    this.status = 'running';
    this.cost = 0;
    this.contextTokens = rand(8, 20) * 1000;
    this.generation = 1;
    this.sessionIds = [crypto.randomUUID()];
    this.lines = [`--- gen 1 · session ${this.sessionIds[0].slice(0, 8)} ---`];
    this.permRequests = [];
    this.permissionMode = this.effectiveMode = state.permMode;
    this.startedAt = Date.now();
  }
  get contextPct() { return Math.min(100, Math.round(this.contextTokens / 2000)); }
  get burnPerMin() { const m = (Date.now() - this.startedAt) / 60000; return m > 0.05 ? this.cost / m : 0; }
  pushLine(l) { this.lines.push(l); if (this.lines.length > 200) this.lines.shift(); }
  respondPermission(allow) {
    const r = this.permRequests.shift();
    if (!r) return;
    this.pushLine(`[skylla] ${allow ? 'allowed' : 'denied'}: [${r.tool}]`);
    if (allow) shell(this, r.input.command, r.out);
    else this.pushLine('⇠ Denied by the user in skylla.');
  }
  setPermissionMode(m) {
    this.permissionMode = this.effectiveMode = m;
    if (m === 'bypassPermissions') while (this.permRequests.length) this.respondPermission(true);
  }
  interrupt() { this.pushLine('[skylla] interrupt sent'); }
}

// --- the fictional project and what workers "do" in it ---
const PROJECT = 'C:\\projects\\aurora-weather';
const TASKS = [
  { task: 'Add hourly forecast chart', files: ['src/components/HourlyChart.tsx', 'src/hooks/useForecast.ts', 'src/api/forecast.ts'] },
  { task: 'Fix timezone bug in sunrise times', files: ['src/lib/astro.ts', 'src/lib/tz.ts', 'test/astro.test.ts'] },
  { task: 'Cache API responses for 10 minutes', files: ['src/api/client.ts', 'src/api/cache.ts', 'test/cache.test.ts'] },
  { task: 'Dark mode for the settings page', files: ['src/pages/Settings.tsx', 'src/theme/tokens.css', 'src/theme/useTheme.ts'] },
  { task: 'Write tests for the alerts parser', files: ['src/alerts/parse.ts', 'test/alerts.test.ts', 'test/fixtures/nws-alert.json'] },
  { task: 'Migrate geocoding to the new API', files: ['src/api/geocode.ts', 'src/components/CitySearch.tsx', '.env.example'] },
  { task: 'Speed up initial page load', files: ['vite.config.ts', 'src/main.tsx', 'src/components/Map.tsx'] },
  { task: 'Add wind direction compass', files: ['src/components/Compass.tsx', 'src/lib/units.ts', 'src/pages/Today.tsx'] },
  { task: 'Accessibility pass on the radar view', files: ['src/components/Radar.tsx', 'src/components/Legend.tsx', 'src/i18n/en.json'] },
];
const THOUGHTS = [
  'Looking at how this is wired up first.', 'The existing helper already covers half of this — reusing it.',
  'Found it: the offset is applied twice when DST changes.', 'Tests pass locally. Checking the edge cases next.',
  'This component re-renders on every tick; memoizing the series.', 'Keeping the public API the same so nothing else breaks.',
  'Adding a regression test for the case that was failing.', 'Small refactor so the cache key includes the units setting.',
  'Typecheck is clean. One lint warning to fix.', 'That fixture was out of date; regenerating it.',
];
const SHELL = [
  ['npm test -- --run', '✓ 48 passed (1.9s)'], ['npx tsc --noEmit', '(no output)'], ['npm run lint', '✓ no problems'],
  ['git diff --stat', ' 3 files changed, 87 insertions(+), 21 deletions(-)'], ['npm run build', 'built in 3.42s · dist/ 412 kB'],
  ['git status --short', ' M src/api/client.ts\n?? src/api/cache.ts'], ['npx vitest run test/astro.test.ts', '✓ 12 passed'],
  ['curl -s localhost:5173/api/health', '{"ok":true}'],
];
const MODELS = ['haiku', 'sonnet', 'sonnet', 'opus', 'fable'];

const state = {
  cwd: PROJECT, runDir: null, permMode: 'auto',
  orchestrator: null, workers: [], retired: [],
  budget: 25, maxWorkers: 18, done: false, weekUsd: 41.7,
  layout: null, shellLog: [], pendingPlan: null, planApproved: true,
  planUsage: { session: 23, weekly: 38 },
};

function shell(w, cmd, out) {
  w.pushLine(`[Bash] ${cmd}`);
  w.pushLine(`⇠ ${out.split('\n').slice(0, 2).join(' · ')}`);
  state.shellLog.push({ w: w.name, color: w.color, ts: Date.now(), cmd, out });
  if (state.shellLog.length > 200) state.shellLog.shift();
}

// one random step of activity
function step(w) {
  if (w.status !== 'running' || w.permRequests.length) return;
  const f = pick(w.files);
  const r = Math.random();
  if (r < 0.25) w.pushLine(`[Read] ${f}`);
  else if (r < 0.40) w.pushLine(`[Grep] ${pick(['useForecast', 'tzOffset', 'fetchJson', 'TODO', 'cacheKey', 'aria-label'])}`);
  else if (r < 0.58) w.pushLine(`[Edit] ${f}`);
  else if (r < 0.78) {
    const [cmd, out] = pick(SHELL);
    if (state.permMode === 'manual' || (state.permMode === 'acceptEdits' && Math.random() < 0.5)) {
      w.permRequests.push({ id: hex(8), tool: 'Bash', input: { command: cmd }, out });
      w.pushLine(`[skylla] PERMISSION NEEDED: [Bash] ${cmd}`);
    } else shell(w, cmd, out);
  } else for (const l of pick(THOUGHTS).split('\n')) w.pushLine(l);
  const mult = { haiku: 0.3, sonnet: 1, opus: 1.7, fable: 2.2 }[w.alias] ?? 1;
  w.cost += rand(0.004, 0.03) * mult;
  w.contextTokens += rand(800, 4000);
  if (Math.random() < 0.012) { // occasional recycle at high context
    w.generation += 1; w.contextTokens = rand(9, 15) * 1000;
    w.sessionIds.push(crypto.randomUUID());
    w.pushLine(`--- gen ${w.generation} · session ${w.sessionIds.at(-1).slice(0, 8)} ---`);
  }
  if (Date.now() - w.startedAt > w.lifetime) finish(w);
}

let n = 1;
function spawnWorker() {
  const t = pick(TASKS.filter(t => !state.workers.some(w => w.task === t.task && w.status === 'running')));
  const alias = pick(MODELS);
  const w = new FakeWorker({ name: `w${n}`, model: MODEL_ALIASES[alias], color: COLORS[(n - 1) % COLORS.length], task: t.task });
  n++;
  Object.assign(w, { alias, files: t.files, lifetime: rand(60, 180) * 1000 });
  w.pushLine(`> ${t.task}`);
  state.workers.push(w);
  orchSay(`@@SPAWN ${w.name} (${alias}): ${t.task}`);
}

function finish(w) {
  w.status = 'done';
  w.pushLine(`Done: ${w.task}. All checks green.`);
  orchSay(`${w.name} finished "${w.task}". Reviewing the diff.`);
  setTimeout(() => { // retire and replace
    state.workers = state.workers.filter(x => x !== w);
    state.retired.push({ name: w.name, cost: w.cost, retired: true });
    if (state.workers.length < 6) spawnWorker();
  }, rand(6, 15) * 1000);
}

function orchSay(text) {
  const o = state.orchestrator;
  for (const l of text.split('\n')) o.pushLine(l);
  o.cost += rand(0.01, 0.04);
  o.contextTokens += rand(500, 1500);
}

// --- boot ---
state.orchestrator = new FakeWorker({ name: 'orch', model: MODEL_ALIASES.opus, color: 'white', task: 'orchestrate' });
state.orchestrator.alias = 'opus';
state.orchestrator.status = 'idle';
orchSay('> Ship the v2.3 milestone: forecast chart, sunrise bug, caching, dark settings.');
orchSay('Plan: 5 parallel workers, sized per task. Haiku for tests, opus for the timezone bug.');
for (let i = 0; i < 5; i++) spawnWorker();

function handleInput(text) {
  text = text.trim();
  let target = state.orchestrator;
  const m = text.match(/^@(\S+)\s+([\s\S]+)/);
  if (m) { target = state.workers.find(w => w.name === m[1].toLowerCase()) ?? target; text = m[2]; }
  const pm = text.match(/^\/mode\s+(\S+)/);
  if (pm) {
    const mode = { ask: 'acceptEdits', acceptedits: 'acceptEdits', auto: 'auto', bypass: 'bypassPermissions', bypasspermissions: 'bypassPermissions', manual: 'manual' }[pm[1].toLowerCase()];
    if (mode) { state.permMode = mode; for (const w of [state.orchestrator, ...state.workers]) w.setPermissionMode(mode); orchSay(`[skylla] permission mode: ${mode}`); }
    return;
  }
  const perm = text.match(/^\/(allow|deny)\s*$/);
  if (perm) {
    const w = target.permRequests.length ? target : state.workers.find(x => x.permRequests.length);
    return w?.respondPermission(perm[1] === 'allow');
  }
  if (/^\/model\s+(\S+)/.test(text)) return target.pushLine('[skylla] (demo) model swap simulated');
  target.pushLine(`> ${text}`);
  if (target === state.orchestrator) {
    setTimeout(() => {
      orchSay(pick(['On it — assigning this to a new worker.', 'Good idea. Spinning up a worker for that.', 'Noted. I\'ll fold that into the next spawn.']));
      if (state.workers.filter(w => w.status === 'running').length < 8) spawnWorker();
    }, 1200);
  } else setTimeout(() => target.pushLine(pick(THOUGHTS)), 1500);
}

const { broadcast, url } = await startServer({
  state, onInput: handleInput, isTrusted: () => true, onTrust: () => ({ trusted: true }),
  onListRuns: () => [], onRemote: () => ({ ok: false, text: 'remote is disabled in demo mode' }),
});

setInterval(() => {
  for (const w of state.workers) if (Math.random() < 0.45) step(w);
  if (Math.random() < 0.08) {
    const active = state.workers.filter(w => w.status === 'running');
    orchSay(pick(['Checking in on progress.', `${pick(active)?.name ?? 'w1'} is on track; no blockers.`,
      `Budget is fine, ${active.length} workers active.`, 'Merging the finished branch after review.']));
  }
  state.weekUsd += 0.002;
  broadcast();
}, 700);

const srcDir = dirname(fileURLToPath(import.meta.url));
try {
  const electronBin = (await import('electron')).default;
  const app = spawn(electronBin, [join(srcDir, 'electron-main.cjs'), url], { stdio: 'ignore' });
  app.on('exit', () => process.exit(0)); // closing the window ends the demo
} catch {
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
console.log(`skylla demo: ${url}  (close the window to stop)`);
