#!/usr/bin/env node
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker, COLORS } from './worker.js';
import { App } from './ui.js';
import { ORCHESTRATOR_PROMPT, WORKER_PROMPT, MODEL_ALIASES, parseDirectives } from './orchestrator.js';
import { fetchPlanUsage } from './usage.js';

// --- args ---
const argv = process.argv.slice(2);
let cwd = process.cwd();
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
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-C') cwd = resolve(argv[++i]);
  else if (argv[i] === '--budget') budget = parseFloat(argv[++i]);
  else if (argv[i] === '--orch-model') orchModel = argv[++i];
  else if (argv[i] === '--recycle-at') recycleAt = parseInt(argv[++i], 10);
  else if (argv[i] === '--tui') useTui = true;
  else if (argv[i] === '--host') host = argv[++i];
  else if (argv[i] === '--auto-approve') autoApprove = true;
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
mkdirSync(join(runDir, 'handoffs'), { recursive: true });

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
writeGuards();

const state = {
  cwd, runDir,
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
  bumpWeekly(totalCost());
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({
    runId, cwd, budget: state.budget, totalCost: totalCost(),
    orchestrator: state.orchestrator && {
      sessions: state.orchestrator.sessionIds, model: state.orchestrator.model, cost: state.orchestrator.cost,
    },
    workers: [
      ...state.workers.map(w => ({
        name: w.name, model: w.model, color: w.color, status: w.status,
        cost: w.cost, sessions: w.sessionIds, generation: w.generation, cwd: w.cwd,
      })),
      ...state.retired,
    ],
  }, null, 2));
}

// --- UI: Electron window (default) or terminal via --tui ---
let rerender = () => {};
if (useTui) {
  const React = (await import('react')).default;
  const { render } = await import('ink');
  const { App } = await import('./ui.js');
  const app = render(React.createElement(App, { state, onSubmit: handleUserInput }));
  rerender = () => app.rerender(React.createElement(App, { state, onSubmit: handleUserInput }));
} else {
  const { startServer } = await import('./server.js');
  const { randomUUID } = await import('node:crypto');
  const token = host !== '127.0.0.1' ? randomUUID().replaceAll('-', '') : null;
  const { broadcast, url } = await startServer({
    state,
    host,
    token,
    onInput: handleUserInput,
    // "open folder": new window = fresh skylla instance; current = repoint this one
    onOpenFolder: ({ dir, model, mode }) => {
      if (mode === 'current') return openHere(dir, model);
      spawn(process.execPath, [fileURLToPath(import.meta.url), '-C', dir, '--orch-model', model ?? orchModel],
        { detached: true, stdio: 'ignore' }).unref();
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
  console.log(`skylla dashboard: ${url}`);
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

function sysToOrch(text) {
  // feed enforcement feedback back to the orchestrator
  state.orchestrator?.send(`[system] ${text}`);
}

// "@w1 msg" or "@<session-id prefix> msg" routes to that worker; default orchestrator.
// "/model <alias>" (routable with @) swaps that session's model via handoff-recycle.
function handleUserInput(text) {
  text = text.trim();
  if (!text) return;
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
  if (/^\/(stop|esc)\s*$/.test(text)) { target?.interrupt(); return; }
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
      return swapModel(target, rc[1].toLowerCase());
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
  target?.send(text);
}

function swapModel(target, alias) {
  if (!target) return;
  if (!MODEL_ALIASES[alias]) {
    target.pushLine(`[skylla] unknown model "${alias}" - use haiku | sonnet | opus | fable`);
    return rerender();
  }
  const gov = governedModel(alias);
  if (gov !== alias) // user commands are warned, not overridden - the human outranks the governor
    target.pushLine(`[skylla] heads-up: plan usage is high (governor would pick ${gov}); proceeding with ${alias}`);
  if (target === state.orchestrator) return escalateOrch(`user requested ${alias}`, alias);
  if (resolvePricingLabel(target.model) === alias) {
    target.pushLine(`[skylla] already on ${alias}`);
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
  });
  wireWorker(w);
  state.workers.push(w);
  w.start(prompt);
  saveManifest();
}

function wireWorker(w) {
  w.on('update', rerender);
  w.on('text', text => {
    if (text.includes('===HANDOFF_DONE===')) return recycleNow(w);
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

function requestHandoff(w) {
  const file = join(runDir, 'handoffs', `${w.name}-gen${w.generation}.md`);
  w.handoffFile = file;
  w.send(`Before your context is recycled, write a handoff file to "${file}" containing: the goal, decisions made so far, current state, and concrete next steps. Then reply with exactly ===HANDOFF_DONE===`);
}

function recycleNow(w) {
  w.pushLine(`[skylla] recycling (gen ${w.generation} -> ${w.generation + 1})`);
  w.recyclePending = false;
  const handoff = w.handoffFile;
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
function escalateOrch(reason, targetAlias) {
  const o = state.orchestrator;
  if (!o || o.escalating) return;
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
  const file = join(runDir, 'handoffs', `orch-gen${o.generation}.md`);
  o.handoffFile = file;
  o.pushLine(`[skylla] ${next ? `switching to ${next}` : 'recycling'}: ${reason}`);
  o.send(`[system] You are being ${next ? `replaced by another model (${next})` : 'recycled with fresh context'}: ${reason}. Write a complete orchestrator handoff to "${file}": the user's task, overall plan and progress, every worker (name, model, assignment, status), budget spent, and concrete next steps. Then reply with exactly ===HANDOFF_DONE===`);
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
  });
  o.on('update', rerender);
  o.on('text', text => {
    appendFileSync(join(runDir, 'orch.log'), text + '\n---\n');
    if (text.includes('===HANDOFF_DONE===') && o.escalating) {
      const handoff = o.handoffFile;
      o.kill();
      o.once('exit', () => {
        o.escalating = false;
        o.contextTokens = 0;
        const target = o.pendingModel ?? currentOrchModel();
        o.pendingModel = null;
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
    if (o.contextPct >= state.recycleAtPct && !o.escalating) escalateOrch(`context at ${o.contextPct}%`);
  });
  state.orchestrator = o;
  return o;
}

// Reuse this window/process for a different project: tear down the run, start fresh.
function openHere(dir, model) {
  for (const w of [state.orchestrator, ...state.workers]) w?.kill();
  state.workers = [];
  state.retired = [];
  state.orchestrator = null;
  state.done = false;
  cwd = resolve(dir);
  state.cwd = cwd;
  state.layout = null;
  try { state.layout = JSON.parse(readFileSync(layoutFile(), 'utf8')); } catch { /* none yet */ }
  if (model) { orchModel = model; orchRung = 0; }
  runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  runDir = join(cwd, '.skylla', 'runs', runId);
  state.runDir = runDir;
  mkdirSync(join(runDir, 'handoffs'), { recursive: true });
  writeGuards();
  lastTotalForWeekly = 0; // new run starts from zero spend
  task = null;
  startOrchestrator();
}

function startOrchestrator() {
  const o = buildOrchestrator(MODEL_ALIASES[currentOrchModel()] ?? currentOrchModel());
  o.start(task ?? 'No initial task given. Greet the user briefly and wait for instructions.');
}

function resumeRun(m) {
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
    const w = new Worker({ name: mw.name, model: mw.model, cwd: mw.cwd ?? cwd, color: mw.color, systemPrompt: WORKER_PROMPT, settingsFile: guardsFile });
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
  o.generation = o.sessionIds.length;
  state.planApproved = true; // a resumed run was already mid-flight; don't re-gate existing work
  lastTotalForWeekly = totalCost(); // rehydrated spend is already in the weekly tally
  if (o.sessionIds.length) {
    o.resume('[system] skylla was restarted and this run resumed. Workers are reattached but idle; any that died mid-task did not finish. Re-sync: review state, @@SEND continuation prompts to workers that should proceed, respawn from handoffs if a session is broken, or wrap up.');
  } else {
    startOrchestrator();
  }
}

loadedManifest ? resumeRun(loadedManifest) : startOrchestrator();
