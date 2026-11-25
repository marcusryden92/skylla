import React, { useState } from 'react';
import { Box, Text, useStdout, useStdin, useInput } from 'ink';
import { multiplier, resolvePricing } from './pricing.js';

const h = React.createElement;

// Importance weight drives panel size: bigger model = bigger panel.
function weightOf(w) {
  const m = w.model ?? '';
  if (m.includes('fable') || m.includes('opus')) return 3;
  if (m.includes('sonnet')) return 2;
  return 1;
}

function Meter({ worker }) {
  const p = resolvePricing(worker.model);
  const mult = multiplier(worker.model);
  const burn = worker.burnPerMin;
  return h(Text, { wrap: 'truncate' },
    // solid identity strip: worker color as background
    h(Text, { backgroundColor: worker.color, color: 'black', bold: true }, ` ${worker.name} `),
    h(Text, { dimColor: true }, ` ${p?.label ?? worker.model ?? '?'} ${mult.toFixed(1)}x `),
    h(Text, { color: 'white' }, `$${worker.cost.toFixed(2)} `),
    h(Text, { color: worker.contextPct > 50 ? 'yellow' : 'gray' }, `ctx ${worker.contextPct}% `),
    h(Text, { color: burn > 1 ? 'red' : 'gray' }, burn > 0 ? `$${burn.toFixed(2)}/m ` : ''),
    h(Text, { dimColor: true }, worker.status),
  );
}

function WorkerPanel({ worker, height }) {
  const tail = worker.lines.slice(-(Math.max(1, height - 3)));
  return h(Box, {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: worker.color,
      height,
      overflow: 'hidden',
    },
    h(Meter, { worker }),
    h(Box, { flexDirection: 'column', overflow: 'hidden' },
      ...tail.map((l, i) => h(Text, { key: i, wrap: 'truncate', dimColor: worker.status !== 'running' }, l))
    )
  );
}

// manual wrap: ink's wrap pushes newest lines out of the fixed-height panel,
// so chunk long lines ourselves and keep the most recent rows
function wrapLines(lines, width) {
  const out = [];
  for (const l of lines) {
    if (l.length <= width) { out.push(l); continue; }
    for (let i = 0; i < l.length; i += width) out.push(l.slice(i, i + width));
  }
  return out;
}

function OrchestratorPanel({ orchestrator, height, width }) {
  const tail = orchestrator
    ? wrapLines(orchestrator.lines, Math.max(20, width - 4)).slice(-(Math.max(1, height - 3)))
    : ['(starting orchestrator...)'];
  return h(Box, {
      flexDirection: 'column',
      borderStyle: 'double',
      borderColor: 'white',
      height,
      overflow: 'hidden',
    },
    orchestrator
      ? h(Meter, { worker: orchestrator })
      : h(Text, { backgroundColor: 'white', color: 'black', bold: true }, ' SKYLLA '),
    h(Box, { flexDirection: 'column', overflow: 'hidden' },
      ...tail.map((l, i) => h(Text, { key: i, wrap: 'truncate' }, l))
    )
  );
}

function InputBar({ onSubmit }) {
  const [value, setValue] = useState('');
  useInput((input, key) => {
    if (key.return) { onSubmit(value); setValue(''); }
    else if (key.backspace || key.delete) setValue(v => v.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) setValue(v => v + input);
  });
  return h(Box, { paddingLeft: 1 },
    h(Text, { color: 'white', bold: true }, '> '),
    h(Text, null, value),
    h(Text, { inverse: true }, ' ')
  );
}

// Distribute `total` rows across items proportional to their weights (min 4 rows each).
function splitByWeight(items, total) {
  const weights = items.map(weightOf);
  const sum = weights.reduce((a, b) => a + b, 0);
  const sizes = weights.map(w => Math.max(4, Math.floor(total * (w / sum))));
  // trim overflow from the largest panels
  let over = sizes.reduce((a, b) => a + b, 0) - total;
  while (over > 0) {
    const i = sizes.indexOf(Math.max(...sizes));
    if (sizes[i] <= 4) break;
    sizes[i] -= 1; over -= 1;
  }
  return sizes;
}

export function App({ state, onSubmit }) {
  const { stdout } = useStdout();
  const { isRawModeSupported } = useStdin();
  const rows = (stdout?.rows ?? 40) - 3;   // minus status bar + input bar
  const workers = state.workers;
  const n = workers.length;

  // Auto-scaling layout:
  //   0 workers  -> orchestrator fills everything
  //   1+ workers -> orchestrator takes the top band (1/3), workers tile below,
  //                 column count grows with worker count, panel heights by importance
  const orchH = n === 0 ? rows : Math.max(6, Math.floor(rows / 3));
  const gridH = rows - orchH;
  // fill horizontally first (up to 3 columns), then stack within columns
  const nCols = Math.min(Math.max(1, n), 3);
  const colWidth = `${Math.floor(100 / nCols)}%`;
  const cols = Array.from({ length: nCols }, () => []);
  workers.forEach((w, i) => cols[i % nCols].push(w));

  const totalCost = workers.reduce((s, w) => s + w.cost, 0) + (state.orchestrator?.cost ?? 0);
  const totalBurn = workers.reduce((s, w) => s + w.burnPerMin, 0) + (state.orchestrator?.burnPerMin ?? 0);
  const running = workers.filter(w => w.status === 'running').length;

  return h(Box, { flexDirection: 'column', height: rows + 3 },
    h(OrchestratorPanel, { orchestrator: state.orchestrator, height: orchH, width: stdout?.columns ?? 120 }),
    n > 0 && h(Box, { flexDirection: 'row', height: gridH },
      ...cols.map((col, ci) => {
        const sizes = splitByWeight(col, gridH);
        return h(Box, { key: ci, width: colWidth, flexDirection: 'column' },
          ...col.map((w, wi) => h(WorkerPanel, { key: w.name, worker: w, height: sizes[wi] }))
        );
      })
    ),
    h(Box, { paddingLeft: 1 },
      h(Text, { bold: true, inverse: true },
        ` SKYLLA  run ${totalCost.toFixed(2)}eq  week ${(state.weekUsd ?? 0).toFixed(2)}eq  burn ${totalBurn.toFixed(2)}/min  workers ${running}/${n}  cap ${state.budget.toFixed(0)}eq `,
        totalCost > state.budget * 0.8 ? ' !! NEAR BUDGET !! ' : '',
        state.done ? ' DONE ' : ''
      )
    ),
    isRawModeSupported
      ? h(InputBar, { onSubmit: onSubmit ?? (() => {}) })
      : h(Text, { dimColor: true }, ' (no interactive input: not a TTY)')
  );
}
