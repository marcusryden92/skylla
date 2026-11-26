import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { contextLimitFor } from './pricing.js';
import { resolveClaudeCli } from './claude-bin.js';

const CLAUDE_CLI = resolveClaudeCli();

// Panel colors cycle; a worker keeps its color across recycles (continuity).
export const COLORS = ['cyan', 'green', 'yellow', 'magenta', 'blue', 'red'];

let nextWorkerNum = 1;

export class Worker extends EventEmitter {
  constructor({ name, model, cwd, color, systemPrompt, permissionMode, settingsFile }) {
    super();
    this.permissionMode = permissionMode ?? 'acceptEdits'; // requested mode
    this.effectiveMode = null;  // what the CLI actually runs (auto can be refused per model)
    this.settingsFile = settingsFile;
    this.name = name ?? `w${nextWorkerNum++}`;
    this.model = model;
    this.cwd = cwd;
    this.color = color ?? COLORS[(nextWorkerNum - 2) % COLORS.length];
    this.systemPrompt = systemPrompt;

    this.generation = 0;        // bumped on each recycle
    this.sessionIds = [];       // lineage, for the manifest
    this.status = 'idle';       // idle | running | done | error | killed
    this.cost = 0;              // cumulative USD across generations
    this.generationCost = 0;
    this.contextTokens = 0;     // latest known context size
    this.startedAt = null;
    this.lines = [];            // rendered output tail
    this.recyclePending = false;
    this.proc = null;
    this.buf = '';
  }

  get contextPct() { return Math.min(100, Math.round((this.contextTokens / contextLimitFor(this.model)) * 100)); }

  get burnPerMin() {
    if (!this.startedAt || this.generationCost === 0) return 0;
    const mins = (Date.now() - this.startedAt) / 60_000;
    return mins > 0.05 ? this.generationCost / mins : 0;
  }

  start(prompt) {
    if (this.proc) throw new Error(`${this.name} already running`);
    const sessionId = randomUUID();
    this.sessionIds.push(sessionId);
    this.generation += 1;
    this.pushLine(`--- gen ${this.generation} · session ${sessionId.slice(0, 8)} ---`);
    this.launch(['--session-id', sessionId]);
    this.status = 'running';
    this.send(prompt);
    this.flushPending();
    return sessionId;
  }

  // Reattach to the most recent session (full history reloaded by the CLI).
  // Without a prompt, the session sits idle awaiting @@SEND / user input.
  resume(prompt) {
    if (this.proc) throw new Error(`${this.name} already running`);
    const sessionId = this.sessionIds.at(-1);
    if (!sessionId) throw new Error(`${this.name} has no session to resume`);
    this.pushLine(`--- resumed · session ${sessionId.slice(0, 8)} ---`);
    this.launch(['--resume', sessionId]);
    this.status = prompt ? 'running' : 'idle';
    if (prompt) this.send(prompt);
    this.flushPending();
    return sessionId;
  }

  launch(sessionArgs) {
    this.generationCost = 0;
    this.startedAt = Date.now();
    const args = [
      '-p',
      '--input-format', 'stream-json',   // persistent: prompts arrive as JSON lines on stdin
      '--output-format', 'stream-json',
      '--verbose',
      ...sessionArgs,
      // always launch in acceptEdits, then switch: a mode the model can't run
      // (auto on haiku) is refused with an error instead of failing the launch
      '--permission-mode', 'acceptEdits',
      '--allow-dangerously-skip-permissions', // makes bypass switchable mid-session; doesn't enable it
      '--permission-prompt-tool', 'stdio', // tools outside the mode prompt via control_request instead of auto-deny
    ];
    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    if (this.systemPrompt) args.push('--append-system-prompt', this.systemPrompt);
    if (this.settingsFile) args.push('--settings', this.settingsFile); // mechanical guards (deny rules)

    const env = { ...process.env };
    delete env.CLAUDECODE; // allow spawning workers even when skylla itself was started from inside a Claude Code session
    this.proc = CLAUDE_CLI
      ? spawn(process.execPath, [CLAUDE_CLI, ...args], { cwd: this.cwd, windowsHide: true, env })
      : spawn('claude', args.map(a => `"${a}"`), { cwd: this.cwd, shell: true, windowsHide: true, env });
    this.proc.stdout.on('data', d => this.onData(d));
    this.proc.stderr.on('data', d => this.pushLine(String(d).trim()));
    this.effectiveMode = 'acceptEdits';
    if (this.permissionMode !== 'acceptEdits') this.setPermissionMode(this.permissionMode);
    this.proc.on('close', code => {
      this.proc = null;
      if (this.status === 'running') this.status = code === 0 ? 'done' : 'error';
      this.emit('exit', { code });
      this.emit('update');
    });
    this.emit('update');
  }

  flushPending() {
    for (const t of this.pendingSends ?? []) this.send(t);
    this.pendingSends = [];
  }

  // Send a user turn to the live session (keeps stdin open between turns).
  // If the process is mid-recycle, queue the message for the next generation.
  send(text) {
    if (!this.proc) { (this.pendingSends ??= []).push(text); return; }
    // echo the full incoming prompt into the panel (UI offers collapse for chunky ones)
    const flat = text.length > 2000 ? text.slice(0, 2000) + ' …[truncated]' : text;
    this.pushLine(`> ${flat}`);
    const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
    this.status = 'running';
    this.emit('update');
  }

  onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { this.pushLine(line); continue; }
      this.onEvent(ev);
    }
  }

  onEvent(ev) {
    this.lastActivity = Date.now(); // any stream event counts as liveness
    if (ev.type === 'system' && ev.subtype === 'init') {
      this.model = ev.model ?? this.model;
    } else if (ev.type === 'assistant') {
      const msg = ev.message;
      if (msg?.usage) {
        this.contextTokens =
          (msg.usage.input_tokens ?? 0) +
          (msg.usage.cache_read_input_tokens ?? 0) +
          (msg.usage.cache_creation_input_tokens ?? 0);
      }
      for (const block of msg?.content ?? []) {
        if (block.type === 'text' && block.text) {
          for (const l of block.text.split('\n')) this.pushLine(l);
          this.emit('text', block.text);
        } else if (block.type === 'tool_use') {
          this.pushLine(`[${block.name}] ${summarizeInput(block.input, this.cwd)}`);
          (this.toolUses ??= new Map()).set(block.id, { name: block.name, cmd: block.input?.command });
          if (this.toolUses.size > 50) this.toolUses.delete(this.toolUses.keys().next().value);
        }
      }
    } else if (ev.type === 'user') {
      // tool results come back as user turns; surface shell output
      for (const block of ev.message?.content ?? []) {
        if (block?.type !== 'tool_result') continue;
        const meta = this.toolUses?.get(block.tool_use_id);
        if (!meta || meta.name !== 'Bash') continue;
        const out = (typeof block.content === 'string'
          ? block.content
          : (block.content ?? []).map(c => c.text ?? '').join('\n')).trim();
        if (out) this.pushLine(`⇠ ${out.split('\n').slice(0, 2).join(' · ').slice(0, 160)}`);
        this.emit('shell', { cmd: meta.cmd ?? '', out });
      }
    } else if (ev.type === 'control_response' && this.modeRequests?.has(ev.response?.request_id)) {
      const mode = this.modeRequests.get(ev.response.request_id);
      this.modeRequests.delete(ev.response.request_id);
      if (ev.response.subtype === 'success') {
        this.effectiveMode = mode;
        if (mode === 'bypassPermissions') while (this.permRequests?.length) this.respondPermission(true);
      } else {
        this.pushLine(`[skylla] mode ${mode} refused: ${ev.response.error ?? 'unknown error'} (staying in ${this.effectiveMode})`);
      }
    } else if (ev.type === 'control_response' && this.modelRequests?.has(ev.response?.request_id)) {
      const model = this.modelRequests.get(ev.response.request_id);
      this.modelRequests.delete(ev.response.request_id);
      if (ev.response.subtype === 'success') {
        this.model = model;
        this.pushLine(`[skylla] now on ${model} (conversation kept)`);
      } else {
        this.pushLine(`[skylla] model switch refused: ${ev.response.error ?? 'unknown error'}`);
      }
    } else if (ev.type === 'control_request' && ev.request?.subtype === 'can_use_tool') {
      const req = { id: ev.request_id, tool: ev.request.tool_name, input: ev.request.input ?? {} };
      (this.permRequests ??= []).push(req);
      this.pushLine(`[skylla] PERMISSION NEEDED: [${req.tool}] ${summarizeInput(req.input, this.cwd)}`);
    } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
      this.emit('ratelimit', ev.rate_limit_info); // fresh plan usage, sent with every API call
    } else if (ev.type === 'result') {
      if (typeof ev.total_cost_usd === 'number') {
        this.cost += ev.total_cost_usd;
        this.generationCost += ev.total_cost_usd;
      }
      this.status = ev.is_error ? 'error' : 'idle'; // idle = session alive, awaiting next turn
      this.emit('result', ev);
      if (this.effortRestartPending && this.proc) this.restartForEffort();
    }
    this.emit('update');
  }

  pushLine(line) {
    this.lines.push(line);
    if (this.lines.length > 200) this.lines.splice(0, this.lines.length - 200);
  }

  // Answer the oldest pending can_use_tool prompt (wire shape verified against cli.js).
  respondPermission(allow) {
    const req = this.permRequests?.shift();
    if (!req || !this.proc) return;
    this.proc.stdin.write(JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: req.id,
        response: allow
          ? { behavior: 'allow', updatedInput: req.input }
          : { behavior: 'deny', message: 'Denied by the user in skylla.' },
      },
    }) + '\n');
    this.pushLine(`[skylla] ${allow ? 'allowed' : 'denied'}: [${req.tool}]`);
    this.emit('update');
  }

  // Effort is a launch flag, so changing it reopens the same session with
  // --resume (conversation kept). Mid-turn, it waits for the turn to finish.
  setEffort(level) {
    this.effort = level;
    if (!this.proc || !this.sessionIds.length) return;
    if (this.status === 'running') {
      this.effortRestartPending = true;
      this.pushLine(`[skylla] effort ${level} applies when this turn finishes`);
      return;
    }
    this.restartForEffort();
  }

  restartForEffort() {
    this.effortRestartPending = false;
    this.once('exit', () => {
      try { this.resume(); this.pushLine(`[skylla] now at effort ${this.effort} (conversation kept)`); }
      catch (e) { this.pushLine(`[skylla] effort change failed: ${e.message}`); }
      this.emit('update');
    });
    this.status = 'idle';
    this.proc.kill();
  }

  // Switch model on the live session, keeping the whole conversation (CLI set_model).
  setModel(model) {
    if (!this.proc) { this.model = model; return; }
    const id = `model-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    (this.modelRequests ??= new Map()).set(id, model);
    this.proc.stdin.write(JSON.stringify({
      type: 'control_request', request_id: id, request: { subtype: 'set_model', model },
    }) + '\n');
  }

  // Switch permission mode on the live session; also used for the next launch.
  setPermissionMode(mode) {
    this.permissionMode = mode;
    if (!this.proc) return;
    const id = `mode-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    (this.modeRequests ??= new Map()).set(id, mode);
    this.proc.stdin.write(JSON.stringify({
      type: 'control_request', request_id: id, request: { subtype: 'set_permission_mode', mode },
    }) + '\n');
  }

  // Esc-equivalent: stop the current turn, session stays alive for the next prompt.
  interrupt() {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify({
      type: 'control_request',
      request_id: `int-${Date.now()}`,
      request: { subtype: 'interrupt' },
    }) + '\n');
    this.pushLine('[skylla] interrupt sent');
    this.emit('update');
  }

  kill() {
    if (this.proc) {
      this.status = 'killed';
      this.proc.kill();
    }
  }
}

// One readable line per tool call instead of a JSON dump.
function summarizeInput(input, cwd) {
  if (!input) return '';
  let s = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern
       ?? input.url ?? input.query ?? input.description ?? input.prompt ?? '';
  if (!s) { // unknown tool: show its first field compactly
    const k = Object.keys(input)[0];
    if (k) s = `${k}: ${typeof input[k] === 'string' ? input[k] : JSON.stringify(input[k])}`;
  }
  s = String(s).replace(/\s+/g, ' ').trim();
  // project-relative paths read far better than C:\Users\...\project\...
  if (cwd && s.toLowerCase().startsWith(String(cwd).toLowerCase())) {
    s = s.slice(String(cwd).length).replace(/^[\\/]/, '');
  }
  return s.slice(0, 100);
}
