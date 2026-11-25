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
  constructor({ name, model, cwd, color, systemPrompt, permissionMode }) {
    super();
    this.permissionMode = permissionMode;
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
      '--permission-mode', this.permissionMode ?? 'acceptEdits',
    ];
    if (this.model) args.push('--model', this.model);
    if (this.systemPrompt) args.push('--append-system-prompt', this.systemPrompt);

    const env = { ...process.env };
    delete env.CLAUDECODE; // allow spawning workers even when skylla itself was started from inside a Claude Code session
    this.proc = CLAUDE_CLI
      ? spawn(process.execPath, [CLAUDE_CLI, ...args], { cwd: this.cwd, windowsHide: true, env })
      : spawn('claude', args.map(a => `"${a}"`), { cwd: this.cwd, shell: true, windowsHide: true, env });
    this.proc.stdout.on('data', d => this.onData(d));
    this.proc.stderr.on('data', d => this.pushLine(String(d).trim()));
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
    // echo incoming prompt into the panel so it's visible where the message landed
    const first = text.split('\n')[0];
    this.pushLine(`> ${first.slice(0, 160)}${first.length > 160 || text.includes('\n') ? ' …' : ''}`);
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
          this.pushLine(`[${block.name}] ${summarizeInput(block.input)}`);
        }
      }
    } else if (ev.type === 'result') {
      if (typeof ev.total_cost_usd === 'number') {
        this.cost += ev.total_cost_usd;
        this.generationCost += ev.total_cost_usd;
      }
      this.status = ev.is_error ? 'error' : 'idle'; // idle = session alive, awaiting next turn
      this.emit('result', ev);
    }
    this.emit('update');
  }

  pushLine(line) {
    this.lines.push(line);
    if (this.lines.length > 200) this.lines.splice(0, this.lines.length - 200);
  }

  kill() {
    if (this.proc) {
      this.status = 'killed';
      this.proc.kill();
    }
  }
}

function summarizeInput(input) {
  if (!input) return '';
  const s = input.command ?? input.file_path ?? input.pattern ?? input.prompt ?? JSON.stringify(input);
  return String(s).slice(0, 80);
}
