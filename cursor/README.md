# /goal for Cursor

A port of the OpenCode `/goal` workflow to [Cursor](https://cursor.com) using
[Cursor Hooks](https://cursor.com/docs/agent/hooks). Set a goal and the agent
keeps working — auto-continuing whenever it stops — until the goal is marked
complete (with evidence), a concrete blocker is reported, or a safety limit
(turns / time / context tokens) is reached.

> Cursor Hooks are a beta feature. Re-test against your exact Cursor build.

## How it maps to Cursor

OpenCode runs the plugin as one long-lived process with in-memory state and a
`session.idle` auto-continue. Cursor has no plugin runtime — it runs short-lived
hook scripts per lifecycle event — so the same behavior is rebuilt on hooks. All
prompt/parse/format/completion logic is **reused verbatim** from the OpenCode
plugin (`src/goal-plugin.js` via its `testInternals` export); only the
persistence and per-event state machine are reimplemented in `cursor/goal-core.mjs`.

| OpenCode plugin | Cursor port |
|---|---|
| `command.execute.before` (`/goal …`) | `beforeSubmitPrompt` parses `/goal …` directives |
| `session.idle` auto-continue (`promptAsync`) | `stop` hook returns `followup_message` |
| message/idle completion + token tracking | `afterAgentResponse` (text) + `preCompact` (real tokens) |
| `experimental.chat.system.transform` | always-apply rule `.cursor/rules/active-goal.mdc` |
| `experimental.session.compacting` | `preCompact` + `sessionStart` `additional_context` |
| "latest instruction wins" | `beforeSubmitPrompt` pauses on a non-continuation user message |
| state in `~/.opencode/.../state.json` | `.cursor/goals/state.json` (+ `.ledger.jsonl`) |

## Install

Copy `.cursor/hooks.json`, `.cursor/commands/goal.md`, and the `cursor/`
directory into your project (the hooks reference `./cursor/hooks/*.mjs` relative
to the workspace root). Requires Node 18+ on `PATH`. Reload Cursor so it picks up
`hooks.json`.

The state path can be overridden with `CURSOR_GOAL_STATE_PATH`.

## Usage

```
/goal fix the failing tests and verify the suite passes
/goal ship the release --max-turns 20 --max-minutes 30 --max-tokens 400000
/goal ship it --success "tests pass and changelog updated" --constraints "do not touch the public API" --mode ordered
/goal status      /goal history     /goal list
/goal add <objective>     /goal focus <number>
/goal sisyphus <obj 1>; <obj 2>; <obj 3>
/goal edit <new objective>
/goal pause       /goal resume      /goal clear
```

Flags accept `--flag value` or `--flag=value`; quote multi-word values. The
supported set and validation are identical to the OpenCode plugin.

## Completion protocol

The agent ends a turn with `[goal:complete]` **only** when the goal is verified,
and must put a `[goal:evidence] …` line immediately before it — a
`[goal:complete]` with no evidence is rejected and the loop continues. If user
input is required, it states the concrete blocker on the line immediately before
`[goal:blocked]`.

## Behavior differences from OpenCode

- **Setting a goal starts a turn.** `beforeSubmitPrompt` cannot rewrite the
  prompt, so `/goal <objective>` is allowed through to the agent (the goal rule
  reframes it). Read-only subcommands (`status`, `history`, `list`) and admin
  ones (`pause`, `clear`) block submission and return their output directly.
- **Token budgeting is estimated** per turn from response length (~4 chars/token)
  and corrected with the real context size at `preCompact`. Turn and time limits
  are exact.
- **No-tool-call detection** is omitted — Cursor hook payloads don't expose a
  turn's tool calls (`afterAgentResponse` provides only text). The low-output
  no-progress guard covers most stall cases.
- **The completion auditor** (child-session verification) is not ported; Cursor
  hooks have no session-spawning API. The evidence gate still applies.

## Test

```
npm run smoke:cursor
```

Drives the core through set → continue → reject-unverified → complete → pause →
resume → blocked → sisyphus auto-promote → clear, against a temp workspace,
without invoking a model.
