// Free smoke test: fake state, real server + electron window. No API calls.
import { startServer } from '../src/server.js';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const mk = (name, model, color, status, lines, ctx, cost) => ({
  name, model, color, status, cost, generation: 1, sessionIds: [crypto.randomUUID()],
  contextPct: ctx, burnPerMin: status === 'running' ? 0.4 : 0,
  lines,
});

const state = {
  budget: 10, weekUsd: 3.21, done: false, maxWorkers: 18,
  orchestrator: mk('orch', 'claude-fable-5', 'white', 'running', [
    '--- gen 1 · session abc123 ---',
    'Classification: LARGE, 3 workers, parallelizable rewrite.',
    '@@SPAWN {"name":"w1","model":"sonnet","prompt":"rewrite module A"}',
    '[w1 report] done (cost $0.12): module A rewritten',
    'Integrating results, sending follow-up to w2.',
  ], 22, 1.84),
  workers: [
    mk('w1', 'claude-sonnet-4-6', 'cyan', 'running',
      ['[Read] src/moduleA.js', '[Edit] src/moduleA.js', 'Refactoring exports...', 'Running tests now.'], 34, 0.42),
    mk('w2', 'claude-opus-4-6', 'green', 'running',
      ['[Bash] npm test', 'All 48 tests pass.', 'Starting on step file 7.'], 61, 0.88),
    mk('w3', 'claude-haiku-4-5', 'yellow', 'idle',
      ['Wrote docs for module A.', '===TASK_DONE==='], 12, 0.07),
  ],
};

const { broadcast, url } = await startServer({ state, onInput: t => {
  state.orchestrator.lines.push(`[user] ${t}`);
  broadcast();
}});
console.log('smoke dashboard:', url);

// simulate activity
let i = 0;
setInterval(() => {
  state.workers[0].lines.push(`working... tick ${++i}`);
  state.workers[0].cost += 0.01;
  state.workers[1].contextPct = Math.min(95, 61 + i);
  if (i === 5) state.workers.push(mk('w4', 'claude-fable-5', 'magenta', 'running', ['spawned late, big panel (fable)'], 5, 0));
  broadcast();
}, 1000);

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const electronBin = (await import('electron')).default;
spawn(electronBin, [join(srcDir, 'electron-main.cjs'), url], { stdio: 'ignore', detached: true }).unref();
