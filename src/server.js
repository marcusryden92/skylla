// Web dashboard: tiny local HTTP server + SSE state stream, no dependencies.
// Binds 127.0.0.1 only. The browser tab is a disposable view; the run lives here.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolvePricing, multiplier } from './pricing.js';

const requireCjs = createRequire(import.meta.url);

function serializeWorker(w) {
  if (!w) return null;
  return {
    name: w.name,
    model: w.model,
    color: w.color,
    status: w.status,
    stalled: !!w.stallFlagged,
    cost: w.cost,
    contextPct: w.contextPct,
    burn: w.burnPerMin,
    generation: w.generation,
    sessions: w.sessionIds ?? [],
    effort: w.effort ?? null,
    perm: w.permRequests?.[0]
      ? { tool: w.permRequests[0].tool, detail: JSON.stringify(w.permRequests[0].input ?? {}).slice(0, 160), more: w.permRequests.length - 1 }
      : null,
    lines: w.lines.slice(-300),
    label: resolvePricing(w.model)?.label ?? w.model ?? '?',
    mult: multiplier(w.model),
    mode: w.effectiveMode ?? null,
    wantMode: w.permissionMode ?? null,
  };
}

function snapshot(state) {
  return {
    orchestrator: serializeWorker(state.orchestrator),
    workers: state.workers.map(serializeWorker),
    budget: state.budget,
    weekUsd: state.weekUsd,
    done: state.done,
    maxWorkers: state.maxWorkers,
    cwd: state.cwd,
    permMode: state.permMode ?? 'acceptEdits',
    launcher: !!state.launcher,
    budgetFromArgs: !!state.budgetFromArgs,
    layout: state.layout ?? null,
    planUsage: state.planUsage ?? null,
    pendingPlan: state.pendingPlan ?? null,
    planApproved: !!state.planApproved,
    shellLog: (state.shellLog ?? []).slice(-100),
    remoteUrl: state.remoteUrl ?? null,
  };
}

export function startServer({ state, onInput, onOpenFolder, onUpload, onLayout, onDiff, onMerge, onDiscard, onTranscript, onListRuns, onRemote, onTrust, isTrusted, onStart, host = '127.0.0.1', port = 0, token = null }) {
  const htmlPath = join(dirname(fileURLToPath(import.meta.url)), 'web', 'index.html');
  const clients = new Set();

  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    // token required for non-local clients only (the desktop window is always trusted)
    const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (token && !isLocal && u.searchParams.get('t') !== token) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (u.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(snapshot(state))}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (u.pathname === '/send' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try { onInput(String(JSON.parse(body).text ?? '')); } catch { /* ignore bad payloads */ }
        res.writeHead(204).end();
      });
    } else if (u.pathname === '/open' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { dir, model, mode, runId } = JSON.parse(body);
          if (dir) onOpenFolder?.({ dir: String(dir), model: model ? String(model) : null, mode: ['current', 'resume'].includes(mode) ? mode : 'new', runId: runId ? String(runId) : null });
        } catch { /* ignore */ }
        res.writeHead(204).end();
      });
    } else if (u.pathname === '/layout' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try { onLayout?.(JSON.parse(body).tree ?? null); } catch { /* ignore */ }
        res.writeHead(204).end();
      });
    } else if (u.pathname === '/remote' && req.method === 'POST') {
      const out = onRemote?.() ?? { ok: false, text: 'unavailable' };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } else if (u.pathname === '/qrlib.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' })
        .end(readFileSync(requireCjs.resolve('qrcode-generator')));
    } else if (u.pathname === '/manifest.json') {
      // PWA: Add to Home Screen on a phone -> standalone window, no browser chrome
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        name: 'skylla', short_name: 'skylla', display: 'standalone',
        background_color: '#0d1117', theme_color: '#161b22',
        start_url: token ? `/?t=${token}` : '/',
        icons: [{ src: token ? `/icon.png?t=${token}` : '/icon.png', sizes: '256x256', type: 'image/png' }],
      }));
    } else if (u.pathname === '/icon.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
        .end(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon.png')));
    } else if (u.pathname === '/trust' && req.method === 'GET') {
      const dir = u.searchParams.get('dir') ?? '';
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ trusted: !!isTrusted?.(dir) }));
    } else if (u.pathname === '/trust' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let out = { trusted: false };
        try { out = onTrust?.(String(JSON.parse(body).dir ?? '')) ?? out; } catch { /* unreadable config */ }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      });
    } else if (u.pathname === '/start' && req.method === 'POST') {
      // start screen: new run or resume, in this or another folder
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let out = { ok: false, text: 'bad request' };
        try {
          const { dir, model, action, runId, task, effort, budget } = JSON.parse(body);
          out = onStart?.({
            dir: dir ? String(dir) : null,
            model: ['haiku', 'sonnet', 'opus', 'fable', 'auto'].includes(model) ? model : null,
            action: action === 'resume' ? 'resume' : 'new',
            runId: runId ? String(runId) : null,
            task: task ? String(task) : null,
            effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : null,
            budget: Number.isFinite(+budget) && +budget >= 0 && budget !== null && budget !== '' ? +budget : null,
          }) ?? { ok: false, text: 'unavailable' };
        } catch (e) { out = { ok: false, text: String(e.message ?? e) }; }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      });
    } else if (u.pathname === '/runs') {
      const out = onListRuns?.(u.searchParams.get('dir') ?? '') ?? [];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } else if (u.pathname === '/diff' || u.pathname === '/transcript') {
      const fn = u.pathname === '/diff' ? onDiff : onTranscript;
      const out = fn?.(u.searchParams.get('name') ?? '') ?? { ok: false, text: 'unavailable' };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } else if ((u.pathname === '/merge' || u.pathname === '/discard') && req.method === 'POST') {
      const fn = u.pathname === '/merge' ? onMerge : onDiscard;
      const out = fn?.(u.searchParams.get('name') ?? '') ?? { ok: false, text: 'unavailable' };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } else if (u.pathname === '/upload' && req.method === 'POST') {
      const name = (u.searchParams.get('name') || 'upload.bin').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
      const target = u.searchParams.get('target') || '';
      const chunks = [];
      let size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > 50 * 1024 * 1024) { req.destroy(); return; } // 50MB cap
        chunks.push(c);
      });
      req.on('end', () => {
        try { onUpload?.(target, name, Buffer.concat(chunks)); res.writeHead(204).end(); }
        catch { res.writeHead(500).end(); }
      });
    } else {
      // re-read each request so tweaking the html needs no restart
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(htmlPath));
    }
  });

  let timer = null;
  const broadcast = () => {
    if (timer) return; // coalesce bursts to ~10 fps
    timer = setTimeout(() => {
      timer = null;
      const data = `data: ${JSON.stringify(snapshot(state))}\n\n`;
      for (const c of clients) c.write(data);
    }, 100);
  };

  return new Promise(done => {
    srv.listen(port, host, () => {
      const shownHost = host === '0.0.0.0' ? '127.0.0.1' : host;
      const t = token ? `/?t=${token}` : '';
      done({ broadcast, url: `http://${shownHost}:${srv.address().port}${t}` });
    });
  });
}
