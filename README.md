# skylla

Multi-agent orchestrator dashboard for Claude Code. One orchestrator session
plans and delegates; workers run as visible, budget-capped panels in a tiling
desktop window. Spend exactly what the task requires — no more, no less.

## Install

Clone anywhere, then double-click `install.cmd`. It installs node (winget) if
missing, project deps, the Claude Code CLI if missing, adds the folder to your
user PATH, and creates `Skylla.lnk`. Log in once with `claude` before first use.

## Starting

| command | what it does |
|---|---|
| `skylla "task"` | desktop app (Electron), orchestrator starts on the task |
| `skylla` | desktop app, orchestrator greets and waits |
| `skylla --tui "task"` | terminal UI instead of the desktop window |
| `skylla resume [runId]` | resume a run (workers reattach idle, orchestrator re-syncs) |
| `skylla runs` | list this project's runs (terminal only) |
| `Skylla.lnk` / `Skylla.vbs` | desktop app, no console window |

Run from your project directory — sessions, runs, and layout are per-project.

### Flags

| flag | default | meaning |
|---|---|---|
| `--orch-model <m>` | `auto` | orchestrator model: `haiku\|sonnet\|opus\|fable`, or `auto` = sonnet→opus→fable escalation ladder |
| `--budget <eq>` | 10 | global spend cap (API-equivalent $); spawns are code-blocked beyond it |
| `--recycle-at <pct>` | 50 | context % that triggers handoff-recycling at the next task boundary |
| `--host <addr>` | 127.0.0.1 | bind beyond localhost for remote access; URL gets a required auth token |
| `--auto-approve` | off | skip the spend gate (plans auto-approved) |
| `--tui` | off | terminal UI (Ink) instead of Electron |
| `-C <dir>` | cwd | run in another directory |
| `--mode <m>` | ask | permission mode for all sessions: `ask` (edits auto, shell asks), `auto`, `bypass`, `manual`; switch live with the titlebar dropdown or `/mode <m>` |

## The input box

Messages go to the orchestrator by default. Prefix `@name` or
`@<session-id-prefix>` to target a worker (autocomplete with arrow keys).

### Slash commands (all @-routable, desktop and TUI)

| command | effect |
|---|---|
| `/model <m>` | switch that session's model, keeping the conversation (also the model button next to the paperclip) |
| `/effort <level>` | low · medium · high · xhigh · max; reopens the same session, conversation kept |
| `/handoff [m]` | controlled compaction: handoff file → fresh context, optionally on another model (aliases: `/recycle`, `/pipe`) |
| `/clear` | hard context reset, no handoff (workers only) |
| `/stop` (`/esc`) | interrupt the current turn; session stays alive |
| `/kill` | kill + retire a worker (panel removed, cost kept) |
| `/status` | print model, gen, ctx %, cost, session id (free, local) |
| `/approve` / `/reject [reason]` | answer the pending @@PLAN |

Unknown slash commands pass through to the Claude session itself.

## Spend control

- **Spend gate**: the orchestrator must emit `@@PLAN` (summary, workers,
  estimate) before its first spawn; all spawns are code-blocked until you
  Approve. New/changed plans re-gate. Trivial tasks need no plan.
- **Hard caps**: max 18 workers, global `--budget`, per-worker budget — all
  enforced in code, never trusted to the model.
- **Governor**: real Max-plan meters (session ≥85 % → spawns downgraded a
  tier; fable weekly ≥90 % → fable requests become opus). Your own commands
  are warned, never overridden.
- **Meters**: per-panel cost, burn rate, context %; status bar shows run/week
  eq (API-equivalent $) and your real plan percentages from Anthropic.
- **Receipts**: `@@DONE` writes `report.md` (duration, totals, per-worker table).

## Desktop app features

- Tiling layout (VS Code style): drag a panel onto another's half to split,
  drag gutters to resize, double-click header or ⛶ to maximize (Esc restores).
  Orchestrator is the heaviest tile. Layout persists per project.
- Panel buttons: `id` copy session id · `tx` full transcript viewer ·
  `Δ` branch diff with **Merge / Discard** (worktree workers) · `■` interrupt ·
  `⛶` maximize · `✕` kill.
- **Shell** button: shared console tile with every Bash command + output,
  color-tagged by session.
- **Open Folder**: native picker → choose model → New Window / This Window /
  Resume Last Run.
- Uploads: drop files on a panel, paste screenshots, or use the paperclip
  (`@target` respected). Saved under the run dir; path handed to the session.
- Toasts when unfocused: run done, plan awaiting approval, near budget,
  worker error/stall.
- Orchestrator model dropdown in the title bar (handoff-swap mid-run).
- Right-click: cut/copy/paste; text selection pauses panel re-rendering.

## Remote

`skylla "task" --host 0.0.0.0` (or a Tailscale IP) and open the printed
token URL from any device. Plain HTTP — use a trusted network or Tailscale.

## How it works

Workers are persistent `claude -p --input-format stream-json` child processes.
The orchestrator emits directives (`@@PLAN`, `@@SPAWN`, `@@SEND`, `@@KILL`,
`@@DONE`, `@@ESCALATE`) that skylla parses and enforces. Context is managed by
handoff files (written at task boundaries, piped into fresh sessions) rather
than blind compaction. Parallel repo edits use git worktrees
(`@@SPAWN {"worktree":true}` → branch `skylla/<name>`), merged from the diff
viewer or by the orchestrator. Destructive git commands are denied to workers
via mechanical settings guards. A watchdog flags sessions silent for 4+ min.

Run data: `<project>/.skylla/runs/<timestamp>/` (manifest, orch.log, handoffs,
uploads, report.md). Layout: `<project>/.skylla/layout.json`. Weekly eq tally:
`~/.skylla-usage.json`.

## Terminal UI parity

The TUI (`--tui`) shares the whole engine — spend gate, governor, caps,
recycling, worktrees, guards, watchdog, resume, and every slash command work
identically (approve plans with `/approve`). Desktop-only: the tiling/drag
layout, diff & transcript viewers, shell tile, uploads, toasts, autocomplete,
and the plan-usage display.
