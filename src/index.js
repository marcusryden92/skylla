#!/usr/bin/env node
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker, COLORS } from './worker.js';
import { App } from './ui.js';
import { ORCHESTRATOR_PROMPT, WORKER_PROMPT, MODEL_ALIASES, parseDirectives } from './orchestrator.js';
import { fetchPlanUsage } from './usage.js';
import { normDir, isTrusted, trustDir } from './trust.js';

// --- args ---
const argv = process.argv.slice(2);
let cwd = normDir(process.cwd());
let task = null;
let budget = 10.0;
let orchModel = 'auto';   // auto = escalation ladder; or pin with --orch-model
const ORCH_LADDER = ['sonnet', 'opus', 'fable'];
let orchRung = 0;
let recycleAt = 50;
let resumeMode = false;
let resumeRunId = null;
let useTui = false;
let host = '127.0.0.1'; // --host 0.0.0.0 (or a LAN/tailscale IP) enables remote + token auth
let autoApprove = false; // --auto-approve skips the spend gate
let remote = false; // --remote: internet via cloudflared tunnel if installed, else LAN IP
// permission mode for every session: ask (edits auto, shell asks) | auto | bypass | manual
const PERM_MODES = { ask: 'acceptEdits', acceptedits: 'acceptEdits', auto: 'auto', bypass: 'bypassPermissions', bypasspermissions: 'bypassPermissions', yolo: 'bypassPermissions', manual: 'manual', default: 'manual' };
let permMode = 'acceptEdits';
let permModeFromArgs = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-C') cwd = normDir(argv[++i]);
  else if (argv[i] === '--budget') budget = parseFloat(argv[++i]);
  else if (argv[i] === '--orch-model') orchModel = argv[++i];
  else if (argv[i] === '--recycle-at') recycleAt = parseInt(argv[++i], 10);
  else if (argv[i] === '--tui') useTui = true;
  else if (argv[i] === '--host') host = argv[++i];
  else if (argv[i] === '--remote') remote = true;
  else if (argv[i] === '--auto-approve') autoApprove = true;
  else if (argv[i] === '--mode') { permMode = PERM_MODES[String(argv[++i]).toLowerCase()] ?? permMode; permModeFromArgs = true; }
  else if (argv[i] === 'resume' && !resumeMode && !task) resumeMode = true;
  else if (resumeMode && !resumeRunId) resumeRunId = argv[i];
  else if (!task) task = argv[i];
}

// --- run dir + manifest ---
// `skylla runs`: list resumable runs (one line per run; workers are restored implicitly)
if (task === 'runs') {
  const runsDir = join(cwd, '.skylla', 'runs');
  const list = existsSync(runsDir)
    ? readdirSync(runsDir).filter(d => existsSync(join(runsDir, d, 'manifest.json'))).sort()
    : [];
  if (!list.length) { console.log(`no runs in ${runsDir}`); process.exit(0); }
  for (const id of list) {
    try {
      const m = JSON.parse(readFileSync(join(runsDir, id, 'manifest.json'), 'utf8'));
      const live = (m.workers ?? []).filter(w => !w.retired).length;
      const orchModelShort = (m.orchestrator?.model ?? '?').replace('claude-', '').replace(/-[0-9].*$/, '');
      console.log(`${id}  ${(m.totalCost ?? 0).toFixed(2)}eq  orch:${orchModelShort}  workers:${live}${id === list.at(-1) ? '  <- latest (default for resume)' : ''}`);
    } catch { console.log(`${id}  (unreadable manifest)`); }
  }
  process.exit(0);
}

let runId, runDir, loadedManifest = null;
// no task and no "resume": show the start screen instead of spending on a fresh orchestrator
// (the terminal UI has no start screen, so --tui keeps the old behaviour)
const startIdle = !resumeMode && !task && !useTui;
if (resumeMode) {
  const runsDir = join(cwd, '.skylla', 'runs');
  const runs = existsSync(runsDir)
    ? readdirSync(runsDir).filter(d => existsSync(join(runsDir, d, 'manifest.json'))).sort()
    : [];
  runId = resumeRunId ?? runs.at(-1);
  if (!runId || !existsSync(join(runsDir, runId, 'manifest.json'))) {
    console.error(resumeRunId ? `skylla: run "${resumeRunId}" not found in ${runsDir}` : `skylla: no runs to resume in ${runsDir}`);
    process.exit(1);
  }
  runDir = join(runsDir, runId);
  loadedManifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
  budget = loadedManifest.budget ?? budget;
} else {
  runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  runDir = join(cwd, '.skylla', 'runs', runId);
}
if (!startIdle) mkdirSync(join(runDir, 'handoffs'), { recursive: true });

// mechanical guards for workers: destructive git ops are denied in code, not prompts
let guardsFile;
function writeGuards() {
  guardsFile = join(runDir, 'guards.json');
  writeFileSync(guardsFile, JSON.stringify({
    permissions: {
      deny: [
        'Bash(git push --force*)', 'Bash(git push -f*)',
        'Bash(git reset --hard*)', 'Bash(git clean -f*)',
        'Bash(git branch -D*)', 'Bash(git checkout -- .*)',
      ],
    },
  }));
}
if (!startIdle) writeGuards();

const state = {
  cwd, runDir,
  permMode,
  launcher: startIdle, // true = start screen shown, no sessions running
  orchestrator: null,
  workers: [],
  retired: [],   // killed workers: panel removed, cost + manifest record kept
  budget,
  maxWorkers: 18,
  perWorkerBudget: budget / 2,
  recycleAtPct: recycleAt,
  done: false,
  weekUsd: 0,
  layout: null,
  shellLog: [],        // chronological Bash commands + output across all sessions
  pendingPlan: null,   // last @@PLAN from the orchestrator, awaiting user approval
  planApproved: false, // spend gate: spawns are code-blocked until true
  startedAt: Date.now(),
};
const layoutFile = () => join(cwd, '.skylla', 'layout.json');
try { state.layout = JSON.parse(readFileSync(layoutFile(), 'utf8')); } catch { /* none yet */ }

// --- weekly usage tally (API-equivalent $, persisted across runs, ISO-week reset) ---
const usageFile = join(homedir(), '.skylla-usage.json');
const isoWeek = () => {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  return `${d.getFullYear()}-W${Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7)}`;
};
let lastTotalForWeekly = 0;
function bumpWeekly(total) {
  let data = { week: isoWeek(), usd: 0 };
  try { const f = JSON.parse(readFileSync(usageFile, 'utf8')); if (f.week === data.week) data = f; } catch { /* fresh week */ }
  data.usd += total - lastTotalForWeekly;
  lastTotalForWeekly = total;
  writeFileSync(usageFile, JSON.stringify(data));
  state.weekUsd = data.usd;
}

const totalCost = () =>
  state.workers.reduce((s, w) => s + w.cost, 0) +
  state.retired.reduce((s, r) => s + (r.cost ?? 0), 0) +
  (state.orchestrator?.cost ?? 0);

function saveManifest() {
  if (state.launcher) return; // nothing started yet: don't create an empty "run"
  bumpWeekly(totalCost());
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({
    runId, cwd, budget: state.budget, permMode, totalCost: totalCost(),
    orchestrator: state.orchestrator && {
      sessions: state.orchestrator.sessionIds, model: state.orchestrator.model, cost: state.orchestrator.cost, effort: state.orchestrator.effort,
    },
    workers: [
      ...state.workers.map(w => ({
        name: w.name, model: w.model, color: w.color, status: w.status, effort: w.effort,
        cost: w.cost, sessions: w.sessionIds, generation: w.generation, cwd: w.cwd,
      })),
      ...state.retired,
    ],
  }, null, 2));
}

// --- UI: Electron window (default) or terminal via --tui ---
let rerender = () => {};
let requestRemote = () => ({ ok: false, text: 'remote is only available in the dashboard (web) mode' });
if (useTui) {
  const React = (await import('react')).default;
  const { render } = await import('ink');
  const { App } = await import('./ui.js');
  const app = render(React.createElement(App, { state, onSubmit: handleUserInput }));
  rerender = () => app.rerender(React.createElement(App, { state, onSubmit: handleUserInput }));
} else {
  const { startServer } = await import('./server.js');
  const { randomUUID } = await import('node:crypto');
  let port = 0;
  const hasCloudflared = () => spawnSync('where', ['cloudflared'], { windowsHide: true }).status === 0;
  const useTunnel = remote && hasCloudflared();
  if (remote && !useTunnel) { // no cloudflared -> LAN fallback (same Wi-Fi only)
    const { networkInterfaces } = await import('node:os');
    host = Object.values(networkInterfaces()).flat()
      .find(i => i && !i.internal && i.family === 'IPv4')?.address ?? '127.0.0.1';
    port = 7777;
    console.log('cloudflared not found - remote limited to your Wi-Fi. For internet access: winget install Cloudflare.cloudflared');
  }
  // token always exists; the server only enforces it for non-local clients
  const token = randomUUID().replaceAll('-', '').slice(0, 8);
  const { broadcast, url } = await startServer({
    state,
    host,
    port,
    token,
    onInput: handleUserInput,
    onStart: opts => startFromLauncher(opts),
    // "open folder": new window = fresh skylla instance; current = repoint this one
    onOpenFolder: ({ dir, model, mode, runId }) => {
      if (mode === 'current') return startFromLauncher({ dir, model, action: 'new' });
      if (mode === 'resume' && existsSync(join(resolve(dir), '.skylla', 'runs'))) {
        // resume a run (specific or latest) in a new window via the CLI resume path
        const args = [fileURLToPath(import.meta.url), '-C', dir, '--mode', permMode, 'resume'];
        if (runId) args.push(runId);
        spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref();
        return;
      }
      spawn(process.execPath, [fileURLToPath(import.meta.url), '-C', dir, '--mode', permMode, '--orch-model', model ?? orchModel],
        { detached: true, stdio: 'ignore' }).unref();
    },
    onRemote: () => startTunnel(),
    onTrust: dir => ({ trusted: trustDir(dir || cwd) }),
    isTrusted: dir => isTrusted(dir || cwd),
    onListRuns: dir => {
      const runsDir = join(resolve(dir || cwd), '.skylla', 'runs');
      if (!existsSync(runsDir)) return [];
      return readdirSync(runsDir)
        .filter(x => existsSync(join(runsDir, x, 'manifest.json'))).sort().reverse()
        .map(id => {
          try {
            const m = JSON.parse(readFileSync(join(runsDir, id, 'manifest.json'), 'utf8'));
            return { id, cost: m.totalCost ?? 0, orch: m.orchestrator?.model ?? '?', workers: (m.workers ?? []).filter(w => !w.retired).length };
          } catch { return { id, cost: 0, orch: '?', workers: 0 }; }
        });
    },
    // --- diff review: worktree workers only ---
    onDiff: name => {
      const w = state.workers.find(x => x.name === name);
      if (!w || w.cwd === cwd) return { ok: false, text: 'no worktree branch for this worker (spawned without "worktree":true)' };
      try {
        const base = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
        return { ok: true, text: git(['diff', `${base}...skylla/${name}`]) || '(no changes on branch)' };
      } catch (e) { return { ok: false, text: String(e.stderr ?? e.message) }; }
    },
    onMerge: name => {
      try {
        const out = git(['merge', '--no-edit', `skylla/${name}`]);
        sysToOrch(`User merged skylla/${name} into the main working tree via the dashboard.`);
        return { ok: true, text: out || 'merged' };
      } catch (e) {
        try { git(['merge', '--abort']); } catch { /* nothing to abort */ }
        sysToOrch(`User tried to merge skylla/${name} but it CONFLICTED and was aborted. Resolve it or assign a worker to.`);
        return { ok: false, text: 'merge conflicted - aborted:\n' + String(e.stdout ?? '') + String(e.stderr ?? e.message) };
      }
    },
    onDiscard: name => {
      try {
        git(['worktree', 'remove', '--force', join(cwd, '.skylla', 'trees', name)]);
        git(['branch', '-D', `skylla/${name}`]);
        sysToOrch(`User discarded branch skylla/${name} via the dashboard.`);
        return { ok: true, text: 'worktree and branch discarded' };
      } catch (e) { return { ok: false, text: String(e.stderr ?? e.message) }; }
    },
    // --- full transcript from the session jsonl on disk ---
    onTranscript: name => {
      const w = name === 'orch' ? state.orchestrator : state.workers.find(x => x.name === name);
      if (!w) return { ok: false, text: 'unknown session' };
      const dir = join(homedir(), '.claude', 'projects', String(w.cwd).replace(/[^a-zA-Z0-9]/g, '-'));
      for (const id of [...w.sessionIds].reverse()) {
        const f = join(dir, `${id}.jsonl`);
        if (existsSync(f)) {
          const lines = readFileSync(f, 'utf8').trim().split('\n');
          return { ok: true, text: lines.slice(-3000).join('\n') };
        }
      }
      return { ok: false, text: 'transcript file not found' };
    },
    onLayout: tree => {
      state.layout = tree;
      try { writeFileSync(layoutFile(), JSON.stringify(tree)); } catch { /* disk hiccup, layout stays in memory */ }
    },
    onUpload: (target, name, buf) => {
      const dir = join(runDir, 'uploads');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${Date.now()}-${name}`);
      writeFileSync(file, buf);
      const t = [state.orchestrator, ...state.workers].find(w => w?.name === target) ?? state.orchestrator;
      t?.send(`The user uploaded a file for you: "${file}". Read it and use it as context for the current task.`);
    },
  });
  rerender = broadcast;
  if (host !== '127.0.0.1') state.remoteUrl = url; // LAN mode: QR immediately
  console.log(`skylla dashboard: ${url}`);

  // internet tunnel: also startable mid-run from the dashboard's Remote button
  let cfProc = null;
  function startTunnel() {
    if (cfProc) return { ok: true, text: state.remoteUrl ?? 'tunnel already starting - QR appears when ready' };
    if (!hasCloudflared()) return { ok: false, text: 'cloudflared is not installed.\nRun once: winget install Cloudflare.cloudflared' };
    cfProc = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${new URL(url).port}`],
      { windowsHide: true });
    const sniff = d => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !state.remoteUrl?.startsWith(m[0])) {
        state.remoteUrl = `${m[0]}/?t=${token}`;
        console.log(`skylla remote (internet): ${state.remoteUrl}`);
        rerender();
      }
    };
    cfProc.stdout.on('data', sniff);
    cfProc.stderr.on('data', sniff);
    cfProc.on('exit', () => { cfProc = null; });
    process.on('exit', () => cfProc?.kill());
    return { ok: true, text: 'starting tunnel - the QR button appears when ready' };
  }
  requestRemote = startTunnel;
  if (useTunnel) startTunnel();
  const srcDir = dirname(fileURLToPath(import.meta.url));
  try {
    const electronBin = (await import('electron')).default; // path to electron.exe
    // NOTE: no windowsHide here - it makes the Electron window start invisible
    spawn(electronBin, [join(srcDir, 'electron-main.cjs'), url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // electron not installed -> plain browser tab
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
}
setInterval(rerender, 1000).unref();

// real Max-plan usage (session/weekly %); null = fall back to eq estimate
async function refreshPlanUsage() {
  const u = await fetchPlanUsage();
  if (u) { state.planUsage = u; rerender(); }
}
refreshPlanUsage();
setInterval(refreshPlanUsage, 120_000).unref();

const git = args => execFileSync('git', args, { cwd, stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 }).toString();

// One mode for the whole run: live sessions switch now, later launches inherit it.
function setPermMode(mode) {
  permMode = state.permMode = mode;
  for (const w of [state.orchestrator, ...state.workers]) w?.setPermissionMode(mode);
  state.orchestrator?.pushLine(`[skylla] permission mode: ${mode}`);
  saveManifest();
}

function sysToOrch(text) {
  // feed enforcement feedback back to the orchestrator
  state.orchestrator?.send(`[system] ${text}`);
}

// "@w1 msg" or "@<session-id prefix> msg" routes to that worker; default orchestrator.
// "/model <alias>" (routable with @) swaps that session's model via handoff-recycle.
function handleUserInput(text) {
  text = text.trim();
  if (!text) return;
  if (state.launcher) {
    const pm = text.match(/^\/mode\s+(\S+)\s*$/); // mode can be picked before starting
    if (pm && PERM_MODES[pm[1].toLowerCase()]) { permMode = state.permMode = PERM_MODES[pm[1].toLowerCase()]; return rerender(); }
    return;
  }
  let target = state.orchestrator;
  const m = text.match(/^@(\S+)\s+([\s\S]+)/);
  if (m) {
    const tok = m[1].toLowerCase();
    target = [state.orchestrator, ...state.workers].find(w =>
      w && (w.name.toLowerCase() === tok || w.sessionIds.some(id => id.toLowerCase().startsWith(tok))));
    if (!target) {
      state.orchestrator?.pushLine(`[skylla] no worker matching @${m[1]} - sent nowhere`);
      return rerender();
    }
    text = m[2];
  }
  const mm = text.match(/^\/model\s+(\S+)\s*$/);
  if (mm) return swapModel(target, mm[1].toLowerCase());
  if (/^\/approve\s*$/.test(text)) {
    if (!state.pendingPlan) state.orchestrator?.pushLine('[skylla] no plan pending approval');
    else {
      state.planApproved = true;
      state.orchestrator?.pushLine('[skylla] plan APPROVED');
      sysToOrch('Plan APPROVED by the user. Proceed with the approved spawns.');
    }
    return rerender();
  }
  const rj = text.match(/^\/reject(?:\s+([\s\S]+))?$/);
  if (rj) {
    if (!state.pendingPlan) state.orchestrator?.pushLine('[skylla] no plan pending approval');
    else {
      state.pendingPlan = null;
      state.planApproved = false;
      state.orchestrator?.pushLine('[skylla] plan REJECTED');
      sysToOrch(`Plan REJECTED by the user${rj[1] ? `: ${rj[1]}` : ''}. Revise and emit a new @@PLAN.`);
    }
    return rerender();
  }
  const perm = text.match(/^\/(allow|deny)\s*$/);
  if (perm) {
    if (!target.permRequests?.length) target.pushLine('[skylla] no permission request pending');
    else target.respondPermission(perm[1] === 'allow');
    return rerender();
  }
  const ef = text.match(/^\/effort(?:\s+(\S+))?\s*$/);
  if (ef) {
    const level = ef[1]?.toLowerCase();
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(level)) {
      target.pushLine(`[skylla] effort is ${target.effort ?? 'default'}. Use /effort low | medium | high | xhigh | max`);
    } else if (level === target.effort) {
      target.pushLine(`[skylla] already at effort ${level}`);
    } else {
      target.pushLine(`[skylla] setting effort to ${level}`);
      target.setEffort(level);
      saveManifest();
    }
    return rerender();
  }
  const pm = text.match(/^\/mode(?:\s+(\S+))?\s*$/);
  if (pm) {
    const mode = pm[1] && PERM_MODES[pm[1].toLowerCase()];
    if (!mode) state.orchestrator?.pushLine(`[skylla] mode is ${permMode}. Use /mode ask | auto | bypass | manual`);
    else setPermMode(mode);
    return rerender();
  }
  if (/^\/remote\s*$/.test(text)) {
    const r = requestRemote();
    state.orchestrator?.pushLine(`[skylla] ${r.text}`);
    return rerender();
  }
  if (/^\/(stop|esc)\s*$/.test(text)) {
    target?.interrupt();
    if (target?.escalating || target?.handoffFile) cancelHandoff(target, 'interrupted by the user');
    return;
  }
  if (/^\/status\s*$/.test(text)) {
    target.pushLine(`[skylla] ${target.name}: ${target.model} · gen ${target.generation} · ctx ${target.contextPct}% · $${target.cost.toFixed(2)} · ${target.status} · session ${target.sessionIds.at(-1)?.slice(0, 8) ?? '-'}`);
    return rerender();
  }
  // controlled compaction: handoff -> fresh context, optionally on another model.
  // /handoff is the canonical name; /recycle and /pipe are aliases.
  const rc = text.match(/^\/(?:handoff|recycle|pipe)(?:\s+(\S+))?\s*$/);
  if (rc) {
    // /recycle fable == /model fable; same-model /recycle falls through to a plain refresh
    if (rc[1] && resolvePricingLabel(target.model) !== rc[1].toLowerCase())
      return swapModel(target, rc[1].toLowerCase(), { fresh: true });
    if (target === state.orchestrator) escalateOrch('user requested recycle', currentOrchModel());
    else if (target.proc) { target.pushLine('[skylla] manual recycle via handoff'); requestHandoff(target); }
    else { target.pushLine('[skylla] not running - nothing to recycle'); rerender(); }
    return;
  }
  if (/^\/clear\s*$/.test(text)) { // hard reset: fresh context, NO handoff
    if (target === state.orchestrator) {
      target.pushLine('[skylla] refusing to /clear the orchestrator - use /recycle (handoff keeps the run coherent)');
      return rerender();
    }
    const fresh = () => { target.contextTokens = 0; target.start('Your context was cleared by the user. Await instructions.'); };
    if (target.proc) { target.once('exit', fresh); target.kill(); } else fresh();
    return;
  }
  if (/^\/kill\s*$/.test(text)) {
    if (target === state.orchestrator) {
      target.pushLine('[skylla] cannot /kill the orchestrator (use the model dropdown or just close skylla)');
      return rerender();
    }
    if (target.proc) { target.once('exit', () => retireWorker(target)); target.kill(); }
    else retireWorker(target);
    return;
  }
  // Plain-language handoff ("hand off to a fresh agent", "replace yourself"):
  // do it in code. Models (haiku especially) otherwise reach for their built-in
  // subagent, which stays inside the same session and never shows on the dashboard.
  if (target?.proc && looksLikeHandoff(text)) {
    target.pushLine(`> ${text}`);
    target.pushLine('[skylla] handoff request detected - fresh session will take over this panel');
    const named = text.toLowerCase().match(/\b(haiku|sonnet|opus|fable)\b/)?.[1];
    if (target === state.orchestrator) escalateOrch(`user asked for a handoff: "${text.slice(0, 300)}"`, named ?? currentOrchModel());
    else { if (named) target.swapTo = named; requestHandoff(target, text); }
    return rerender();
  }
  target?.send(text);
}

function looksLikeHandoff(text) {
  const t = text.toLowerCase();
  if (/\breplace (you|yourself)\b/.test(t)) return true;
  if (/\b(fresh|new) (agent|session|context)\b/.test(t) && /\b(take over|takes over|replace|replaces|continue|hand)/.test(t)) return true;
  return /\bhand ?(off|over)\b/.test(t) && /\b(you|yourself|fresh|new|another|next|agent|session)\b/.test(t)
    && !/\bhand ?off (file|doc|note)s?\b/.test(t);
}

// /model X: switch the live session, conversation kept.
// fresh (/handoff X): handoff to a new session on X - cheaper on a big context.
function swapModel(target, alias, { fresh = false } = {}) {
  if (!target) return;
  if (!MODEL_ALIASES[alias]) {
    target.pushLine(`[skylla] unknown model "${alias}" - use haiku | sonnet | opus | fable`);
    return rerender();
  }
  const gov = governedModel(alias);
  if (gov !== alias) // user commands are warned, not overridden - the human outranks the governor
    target.pushLine(`[skylla] heads-up: plan usage is high (governor would pick ${gov}); proceeding with ${alias}`);
  if (resolvePricingLabel(target.model) === alias && !fresh) {
    target.pushLine(`[skylla] already on ${alias}`);
    return rerender();
  }
  if (target === state.orchestrator) {
    if (fresh) return escalateOrch(`user requested ${alias}`, alias);
    if (orchModel === 'auto') { const r = ORCH_LADDER.indexOf(alias); if (r >= 0) orchRung = r; } else orchModel = alias;
    target.systemPrompt = orchSysPrompt(MODEL_ALIASES[alias]); // truthful "running as" on the next launch
  }
  if (!fresh) {
    target.pushLine(`[skylla] switching to ${alias}, keeping the conversation`);
    target.setModel(MODEL_ALIASES[alias]);
    saveManifest();
    return rerender();
  }
  if (!target.proc) { // session not live: just retarget the next generation
    target.model = MODEL_ALIASES[alias];
    target.pushLine(`[skylla] model set to ${alias} for next start`);
    return rerender();
  }
  target.swapTo = alias;
  target.pushLine(`[skylla] swapping to ${alias} via handoff`);
  requestHandoff(target);
}

const resolvePricingLabel = model =>
  Object.entries(MODEL_ALIASES).find(([, id]) => model?.startsWith(id))?.[0];

// stall watchdog: a "running" session with no stream events for a while needs eyes on it
const STALL_MS = 4 * 60_000;
setInterval(() => {
  for (const w of [state.orchestrator, ...state.workers]) {
    if (!w?.proc || w.status !== 'running' || !w.lastActivity) continue;
    const idle = Date.now() - w.lastActivity;
    if (idle >= STALL_MS && !w.stallFlagged) {
      w.stallFlagged = true;
      w.pushLine(`[skylla] STALLED? no activity for ${Math.round(idle / 60_000)}m`);
      if (w !== state.orchestrator)
        sysToOrch(`${w.name} has produced no output for ${Math.round(idle / 60_000)} minutes while running. It may be hung or waiting on something. @@SEND a nudge or @@KILL it.`);
      rerender();
    } else if (idle < STALL_MS) {
      w.stallFlagged = false;
    }
  }
}, 30_000).unref();

// run report card: receipts for what each worker cost vs delivered
function writeReport(summary) {
  const mins = ((Date.now() - state.startedAt) / 60_000).toFixed(1);
  const all = [...state.workers.map(w => ({ ...w, gens: w.generation })), ...state.retired.map(r => ({ ...r, gens: r.generation }))];
  const rows = all.map(w => `| ${w.name} | ${w.model} | ${w.gens ?? '-'} | $${(w.cost ?? 0).toFixed(2)} | ${w.status} |`);
  const md = [
    `# skylla run report`, ``,
    `- run: ${runId}`,
    `- duration: ${mins} min`,
    `- total: ${totalCost().toFixed(2)}eq (budget ${state.budget}eq)`,
    `- orchestrator: ${state.orchestrator?.model ?? '?'} · $${(state.orchestrator?.cost ?? 0).toFixed(2)} · ${state.orchestrator?.generation ?? 1} gen(s)`,
    ``,
    ...(summary ? [`## Summary`, summary, ``] : []),
    `## Workers`, `| name | model | gens | cost | status |`, `|---|---|---|---|---|`,
    ...rows, ``,
  ].join('\n');
  const file = join(runDir, 'report.md');
  writeFileSync(file, md);
  state.orchestrator?.pushLine(`[skylla] report written: ${file}`);
}

function retireWorker(w) {
  state.retired.push({
    name: w.name, model: w.model, color: w.color, status: 'killed',
    cost: w.cost, sessions: w.sessionIds, generation: w.generation, retired: true,
  });
  state.workers = state.workers.filter(x => x !== w);
  saveManifest();
  rerender();
}

// governor: respect the real Max-plan meters when picking models
const TIERS = ['haiku', 'sonnet', 'opus', 'fable'];
function governedModel(alias) {
  const pu = state.planUsage;
  if (!pu || !TIERS.includes(alias)) return alias;
  let a = alias;
  if ((pu.session ?? 0) >= 85 && TIERS.indexOf(a) > 0) a = TIERS[TIERS.indexOf(a) - 1];
  const fablePct = pu.scoped?.find(s => s.name.includes('fable'))?.percent ?? 0;
  if (a === 'fable' && fablePct >= 90) a = 'opus';
  return a;
}

// --- worker lifecycle ---
function spawnWorker({ name, model, prompt, worktree }) {
  if (!state.planApproved)
    return sysToOrch(`SPAWN rejected: no user-approved plan. Emit @@PLAN and wait for approval.`);
  if (state.workers.some(w => w.name === name)) return sysToOrch(`SPAWN rejected: ${name} already exists. Use @@SEND.`);
  if (state.workers.filter(w => w.proc).length >= state.maxWorkers)
    return sysToOrch(`SPAWN rejected: worker cap (${state.maxWorkers}) reached.`);
  if (totalCost() >= state.budget)
    return sysToOrch(`SPAWN rejected: global budget $${state.budget} exhausted.`);

  const governed = governedModel(model);
  if (governed !== model) {
    sysToOrch(`governor: plan usage is high, ${name} downgraded ${model} -> ${governed}.`);
    model = governed;
  }

  let workCwd = cwd;
  if (worktree) {
    const tree = join(cwd, '.skylla', 'trees', name);
    try {
      execFileSync('git', ['worktree', 'add', tree, '-b', `skylla/${name}`], { cwd, stdio: 'pipe' });
      workCwd = tree;
    } catch (e) {
      return sysToOrch(`SPAWN rejected: worktree failed: ${String(e.stderr ?? e.message).trim().slice(0, 300)}`);
    }
  }

  const w = new Worker({
    name,
    model: MODEL_ALIASES[model] ?? model,
    cwd: workCwd,
    color: COLORS[state.workers.length % COLORS.length],
    systemPrompt: WORKER_PROMPT,
    settingsFile: guardsFile,
    permissionMode: permMode,
  });
  wireWorker(w);
  state.workers.push(w);
  w.start(prompt);
  saveManifest();
}

function recordShell(w) {
  w.on('shell', e => {
    state.shellLog.push({
      w: w.name, color: w.color, ts: Date.now(),
      cmd: String(e.cmd ?? '').slice(0, 200),
      out: String(e.out ?? '').split('\n').slice(0, 12).join('\n').slice(0, 1200),
    });
    if (state.shellLog.length > 200) state.shellLog.splice(0, state.shellLog.length - 200);
  });
}

function wireWorker(w) {
  w.on('update', rerender);
  recordShell(w);
  w.on('text', text => {
    if (text.includes('===HANDOFF_DONE===')) return recycleNow(w);
    if (text.includes('===HANDOFF_REQUEST===') && !w.handoffFile) {
      w.pushLine('[skylla] handoff requested by the session');
      return requestHandoff(w);
    }
    if (text.includes('===TASK_DONE===')) {
      if (w.recyclePending) return requestHandoff(w);
      w.lastReport = text.replace('===TASK_DONE===', '').trim().slice(-1500);
      state.orchestrator?.send(`[${w.name} report] done (cost $${w.cost.toFixed(2)}):\n${w.lastReport}`);
    }
  });
  w.on('result', () => {
    saveManifest();
    // budget + context guardrails, checked at turn boundaries
    if (w.cost >= state.perWorkerBudget) {
      sysToOrch(`${w.name} exceeded per-worker budget ($${w.cost.toFixed(2)}). It was paused; decide: @@SEND to continue deliberately, or @@KILL.`);
    }
    if (w.contextPct >= state.recycleAtPct && !w.recyclePending) {
      w.recyclePending = true; // recycled at next ===TASK_DONE===, not mid-flight
      w.pushLine(`[skylla] ctx ${w.contextPct}% - recycle pending at next task boundary`);
    }
    if (totalCost() >= state.budget) {
      sysToOrch(`GLOBAL BUDGET $${state.budget} REACHED. No new spawns possible. Wrap up with @@DONE.`);
    }
  });
  w.on('exit', () => { rerender(); saveManifest(); });
}

function requestHandoff(w, userNote) {
  const file = join(runDir, 'handoffs', `${w.name}-gen${w.generation}.md`);
  w.handoffFile = file;
  const note = userNote ? `The user asked for this handoff: "${userNote.slice(0, 500)}". Include anything in that request the next session must act on. ` : '';
  w.send(`${note}Before your context is recycled, write a handoff file to "${file}" containing: the goal, decisions made so far, current state, and concrete next steps. Then reply with exactly ===HANDOFF_DONE===`);
}

function recycleNow(w) {
  w.pushLine(`[skylla] recycling (gen ${w.generation} -> ${w.generation + 1})`);
  w.recyclePending = false;
  const handoff = w.handoffFile;
  w.handoffFile = null;
  w.kill();
  w.once('exit', () => {
    w.contextTokens = 0;
    if (w.swapTo) { w.model = MODEL_ALIASES[w.swapTo]; w.swapTo = null; }
    w.start(`You are resuming a task from a previous session. Read your handoff file at "${handoff}" and continue the work from there.`);
  });
}

// --- orchestrator ---
const currentOrchModel = () => orchModel === 'auto' ? ORCH_LADDER[orchRung] : orchModel;

// targetAlias: explicit model to swap to (user request); otherwise climb the auto ladder.
function escalateOrch(reason, targetAlias, { assess = false } = {}) {
  const o = state.orchestrator;
  if (!o) return;
  if (o.escalating) { // already pending (e.g. an earlier one was interrupted): re-issue with the new target
    o.escalating = false;
    o.pushLine('[skylla] re-issuing pending handoff');
  }
  let next = null;
  if (targetAlias) {
    next = targetAlias;
    if (orchModel === 'auto') {
      const r = ORCH_LADDER.indexOf(targetAlias);
      if (r >= 0) orchRung = r;
    } else {
      orchModel = targetAlias; // pinned: stay pinned to the new choice
    }
  } else {
    const canClimb = orchModel === 'auto' && orchRung < ORCH_LADDER.length - 1;
    if (canClimb) { orchRung += 1; next = ORCH_LADDER[orchRung]; }
    // else: same model, fresh context (plain recycle)
  }
  o.escalating = true;
  o.pendingModel = next;
  o.assessModel = assess;
  const file = join(runDir, 'handoffs', `orch-gen${o.generation}.md`);
  o.handoffFile = file;
  const sameModel = next && next === currentModelAlias(o);
  o.pushLine(`[skylla] ${sameModel ? `handing off to a fresh ${next} session` : next ? `switching to ${next}` : 'recycling'}: ${reason}`);
  const who = sameModel ? `a fresh ${next} session (same model, clean context)` : next ? `another model (${next})` : 'a fresh session';
  const assessNote = assess
    ? ` Also assess the remaining work: only if it genuinely needs a stronger model than ${next}, add a line "NEXT_MODEL: opus" or "NEXT_MODEL: fable" before the marker; otherwise the same model continues.`
    : '';
  o.send(`[system] Skylla is replacing you with ${who}: ${reason}. This is a real handoff: a new session takes over this dashboard panel and reads your file. Write a complete orchestrator handoff to "${file}": the user's task, overall plan and progress, every worker (name, model, assignment, status), budget spent, and concrete next steps.${assessNote} Then reply with exactly ===HANDOFF_DONE===`);
}

// alias of the model a session is running, e.g. 'claude-opus-4-6' -> 'opus'
function currentModelAlias(w) {
  return Object.entries(MODEL_ALIASES).find(([, id]) => String(w.model ?? '').startsWith(id))?.[0] ?? null;
}

// User stopped a session mid-handoff: drop the pending handoff instead of leaving it stuck.
function cancelHandoff(w, why) {
  if (w === state.orchestrator) {
    w.escalating = false;
    w.pendingModel = null;
    w.assessModel = false;
    w.snoozeUntilPct = w.contextPct + 10; // don't re-trigger on the very next turn
  }
  w.handoffFile = null;
  w.swapTo = null;
  w.recyclePending = false;
  w.pushLine(`[skylla] handoff cancelled (${why}). Ask again or use /handoff when ready.`);
}

const orchSysPrompt = model => ORCHESTRATOR_PROMPT
  + `\nHard caps: max ${state.maxWorkers} workers, global budget $${state.budget}, per-worker budget $${state.perWorkerBudget}.`
  + `\nYou are currently running as: ${model}. Tier judgments above refer to this.`;

function buildOrchestrator(model) {
  const o = new Worker({
    name: 'orch',
    model,
    cwd,
    color: 'white',
    systemPrompt: orchSysPrompt(model),
    permissionMode: permMode,
  });
  o.on('update', rerender);
  recordShell(o);
  o.on('text', text => {
    appendFileSync(join(runDir, 'orch.log'), text + '\n---\n');
    if (text.includes('===HANDOFF_DONE===') && o.escalating) {
      const handoff = o.handoffFile;
      o.kill();
      o.once('exit', () => {
        o.escalating = false;
        o.contextTokens = 0;
        let target = o.pendingModel ?? currentOrchModel();
        const rec = o.assessModel && text.match(/NEXT_MODEL:\s*(haiku|sonnet|opus|fable)\b/i)?.[1]?.toLowerCase();
        if (rec && rec !== target) {
          target = rec;
          if (orchModel === 'auto') { const r = ORCH_LADDER.indexOf(rec); if (r >= 0) orchRung = r; } else orchModel = rec;
          o.pushLine(`[skylla] handoff assessment: continuing on ${rec}`);
        }
        o.pendingModel = null;
        o.assessModel = false;
        o.snoozeUntilPct = 0;
        o.model = MODEL_ALIASES[target] ?? target;
        o.systemPrompt = orchSysPrompt(o.model); // keep the "running as" line truthful
        o.start(`You are taking over as SKYLLA orchestrator mid-run. Read your predecessor's handoff at "${handoff}" and continue managing the run from there.`);
        saveManifest();
      });
      return;
    }
    for (const d of parseDirectives(text)) {
      if (d.kind === 'SPAWN') spawnWorker(d);
      else if (d.kind === 'SEND') {
        const w = state.workers.find(x => x.name === d.name);
        w ? w.send(d.prompt) : sysToOrch(`SEND rejected: no worker named ${d.name}.`);
      } else if (d.kind === 'KILL') {
        const w = state.workers.find(x => x.name === d.name);
        if (w) {
          if (w.proc) { w.once('exit', () => retireWorker(w)); w.kill(); }
          else retireWorker(w);
        }
      } else if (d.kind === 'PLAN') {
        state.pendingPlan = { summary: d.summary, workers: d.workers ?? [], estimate_eq: d.estimate_eq };
        if (autoApprove) {
          state.planApproved = true;
          sysToOrch('Plan auto-approved (--auto-approve). Proceed.');
        } else {
          state.planApproved = false; // a new/changed plan always re-gates
          sysToOrch('Plan received. The user must approve it - do NOT spawn until you get confirmation.');
        }
        rerender();
      } else if (d.kind === 'DONE') {
        state.done = true;
        writeReport(d.summary);
        saveManifest();
      } else if (d.kind === 'HANDOFF') {
        const model = d.model && MODEL_ALIASES[String(d.model).toLowerCase()] ? String(d.model).toLowerCase() : currentOrchModel();
        escalateOrch(`handoff: ${d.reason ?? 'requested'}`, model);
      } else if (d.kind === 'ESCALATE') {
        escalateOrch(`self-reported: ${d.reason ?? 'unspecified'}`);
      } else {
        sysToOrch(`Could not parse directive: ${d.raw}`);
      }
    }
  });
  o.on('result', () => {
    saveManifest();
    // code-side escalation trigger: context pressure the model can't be trusted to notice
    if (o.contextPct >= Math.max(state.recycleAtPct, o.snoozeUntilPct ?? 0) && !o.escalating)
      escalateOrch(`context at ${o.contextPct}%`, currentModelAlias(o) ?? currentOrchModel(), { assess: true });
  });
  state.orchestrator = o;
  return o;
}

// Start screen / Open Folder "this window": tear down whatever runs here, then
// either start a new run (model of choice) or resume one, in any folder.
//   action 'new'    -> fresh run, orchestrator on `model` (haiku|sonnet|opus|fable|auto), optional first task
//   action 'resume' -> run `runId` in that folder, or its latest when omitted
function startFromLauncher({ dir, model, effort, action = 'new', runId: pickRun, task: firstTask } = {}) {
  const nextCwd = normDir(dir || cwd);
  let manifest = null, resumeId = null;
  if (action === 'resume') {
    const runsDir = join(nextCwd, '.skylla', 'runs');
    const runs = existsSync(runsDir) ? readdirSync(runsDir).filter(d => existsSync(join(runsDir, d, 'manifest.json'))).sort() : [];
    resumeId = pickRun && runs.includes(pickRun) ? pickRun : runs.at(-1);
    if (!resumeId) return { ok: false, text: 'no runs to resume in this folder' };
    try { manifest = JSON.parse(readFileSync(join(runsDir, resumeId, 'manifest.json'), 'utf8')); }
    catch { return { ok: false, text: `run ${resumeId} has an unreadable manifest` }; }
  }

  for (const w of [state.orchestrator, ...state.workers]) w?.kill();
  state.workers = [];
  state.retired = [];
  state.orchestrator = null;
  state.done = false;
  state.pendingPlan = null;
  state.planApproved = false;
  state.shellLog = [];
  cwd = nextCwd;
  state.cwd = cwd;
  state.layout = null;
  try { state.layout = JSON.parse(readFileSync(layoutFile(), 'utf8')); } catch { /* none yet */ }

  if (manifest) {
    runId = resumeId;
    runDir = join(cwd, '.skylla', 'runs', runId);
    state.budget = manifest.budget ?? state.budget;
  } else {
    if (model) { orchModel = model; orchRung = 0; }
    runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    runDir = join(cwd, '.skylla', 'runs', runId);
  }
  state.runDir = runDir;
  mkdirSync(join(runDir, 'handoffs'), { recursive: true });
  writeGuards();
  state.launcher = false;
  if (manifest) {
    resumeRun(manifest);
  } else {
    lastTotalForWeekly = 0; // new run starts from zero spend
    task = firstTask?.trim() || null;
    startOrchestrator(effort);
  }
  rerender();
  return { ok: true };
}

function startOrchestrator(effort) {
  const o = buildOrchestrator(MODEL_ALIASES[currentOrchModel()] ?? currentOrchModel());
  if (effort) o.effort = effort;
  o.start(task ?? 'No initial task given. Greet the user briefly and wait for instructions.');
}

function resumeRun(m) {
  if (!permModeFromArgs && m.permMode) permMode = state.permMode = m.permMode;
  // restore the auto-ladder rung from the model the orchestrator had reached
  if (orchModel === 'auto' && m.orchestrator?.model) {
    const alias = Object.entries(MODEL_ALIASES).find(([, id]) => m.orchestrator.model.startsWith(id))?.[0];
    const rung = ORCH_LADDER.indexOf(alias);
    if (rung >= 0) orchRung = rung;
  }
  // reattach workers idle: their sessions remember everything, but the
  // orchestrator decides who actually continues (no uncontrolled restart burst)
  for (const mw of m.workers ?? []) {
    if (mw.retired) { state.retired.push(mw); continue; } // keep cost, no panel
    const w = new Worker({ name: mw.name, model: mw.model, cwd: mw.cwd ?? cwd, color: mw.color, systemPrompt: WORKER_PROMPT, settingsFile: guardsFile, permissionMode: permMode });
    w.effort = mw.effort;
    w.cost = mw.cost ?? 0;
    w.generation = mw.generation ?? 1;
    w.sessionIds = mw.sessions ?? [];
    wireWorker(w);
    state.workers.push(w);
    try { w.resume(); }
    catch (e) { w.status = 'error'; w.pushLine(`[skylla] resume failed: ${e.message}`); }
  }
  const o = buildOrchestrator(m.orchestrator?.model ?? (MODEL_ALIASES[currentOrchModel()] ?? currentOrchModel()));
  o.cost = m.orchestrator?.cost ?? 0;
  o.sessionIds = m.orchestrator?.sessions ?? [];
  o.effort = m.orchestrator?.effort;
  o.generation = o.sessionIds.length;
  state.planApproved = true; // a resumed run was already mid-flight; don't re-gate existing work
  lastTotalForWeekly = totalCost(); // rehydrated spend is already in the weekly tally
  if (o.sessionIds.length) {
    o.resume('[system] skylla was restarted and this run resumed. Workers are reattached but idle; any that died mid-task did not finish. Re-sync: review state, @@SEND continuation prompts to workers that should proceed, respawn from handoffs if a session is broken, or wrap up.');
  } else {
    startOrchestrator();
  }
}

if (loadedManifest) resumeRun(loadedManifest);
else if (!startIdle) startOrchestrator();
// else: start screen - the UI calls startFromLauncher()
