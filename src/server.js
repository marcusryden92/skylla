// Web dashboard: tiny local HTTP server + SSE state stream, no dependencies.
// Binds 127.0.0.1 only. The browser tab is a disposable view; the run lives here.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePricing, multiplier } from './pricing.js';

function serializeWorker(w) {
  if (!w) return null;
  return {
    name: w.name,
    model: w.model,
    color: w.color,
    status: w.status,
    cost: w.cost,
    contextPct: w.contextPct,
    burn: w.burnPerMin,
    generation: w.generation,
    sessions: w.sessionIds ?? [],
    lines: w.lines.slice(-300),
    label: resolvePricing(w.model)?.label ?? w.model ?? '?',
    mult: multiplier(w.model),
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
  };
}

export function startServer({ state, onInput, onOpenFolder }) {
  const htmlPath = join(dirname(fileURLToPath(import.meta.url)), 'web', 'index.html');
  const clients = new Set();

  const srv = createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(snapshot(state))}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (req.url === '/send' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try { onInput(String(JSON.parse(body).text ?? '')); } catch { /* ignore bad payloads */ }
        res.writeHead(204).end();
      });
    } else if (req.url === '/open' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try { const dir = String(JSON.parse(body).dir ?? ''); if (dir) onOpenFolder?.(dir); } catch { /* ignore */ }
        res.writeHead(204).end();
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
    srv.listen(0, '127.0.0.1', () =>
      done({ broadcast, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}
