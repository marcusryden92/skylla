// Live test of the can_use_tool permission flow (haiku, costs pennies).
// Expects: PERMISSION NEEDED line -> respondPermission(true) -> turn completes.
import { Worker } from '../src/worker.js';

const w = new Worker({ name: 'permtest', model: 'claude-haiku-4-5', cwd: process.cwd(), permissionMode: process.env.PERM_MODE });
let answered = false;

w.on('update', () => {
  if (!answered && w.permRequests?.length) {
    answered = true;
    console.log('GOT PERMISSION REQUEST:', w.permRequests[0].tool, JSON.stringify(w.permRequests[0].input));
    w.respondPermission(true);
  }
});
w.on('result', ev => {
  console.log('RESULT: error =', ev.is_error, '| cost =', ev.total_cost_usd);
  console.log('last lines:', w.lines.slice(-6).join(' | '));
  console.log(answered ? 'PERMISSION FLOW OK' : 'NO PERMISSION PROMPT SEEN (tool may have been auto-allowed or auto-denied)');
  w.kill();
  process.exit(0);
});

w.start(process.env.PERM_PROMPT ?? 'Use the WebSearch tool to search for "electron titleBarOverlay". Then reply with just the word DONE.');
setTimeout(() => { console.log('TIMEOUT. lines:', w.lines.slice(-8).join(' | ')); w.kill(); process.exit(1); }, 120_000);
