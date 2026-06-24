# cursor-goal-plugin

A session-scoped `/goal` command for [Cursor](https://cursor.com) using [Cursor Hooks](https://cursor.com/docs/agent/hooks).

Set a goal and the agent keeps working — auto-continuing whenever it stops — until the goal is marked complete (with evidence), a concrete blocker is reported, or a safety limit (turns / time / context tokens) is reached.

> Cursor Hooks are a beta feature. Re-test against your exact Cursor build.

## Install

Copy `.cursor/hooks.json`, `.cursor/commands/goal.md`, and the `cursor/` directory into your project (hooks reference `./cursor/hooks/*.mjs` relative to the workspace root). Requires Node 18+ on `PATH`. Reload Cursor to pick up `hooks.json`.

The state path can be overridden with `CURSOR_GOAL_STATE_PATH`.

## Usage

Set a goal:

```
/goal fix the failing tests and verify the suite passes
```

Override limits:

```
/goal ship the release --max-turns 20 --max-minutes 30 --max-tokens 400000
```

Add success criteria, constraints, and a mode:

```
/goal ship it --success "tests pass and changelog updated" --constraints "do not touch the public API" --mode ordered
```

Other commands:

```
/goal status      /goal history     /goal list
/goal add <objective>     /goal focus <number>
/goal sisyphus <obj 1>; <obj 2>; <obj 3>
/goal edit <new objective>
/goal pause       /goal resume      /goal clear
```

Flags accept `--flag value` or `--flag=value`. Multi-word values must be quoted.

## How it works

1. `/goal <objective>` writes state to `.cursor/goals/state.json` and injects the goal into the agent via an always-apply rule at `.cursor/rules/active-goal.mdc`.
2. The `stop` hook returns a `followup_message` to auto-continue whenever the agent stops, as long as the goal is active.
3. The `afterAgentResponse` hook checks each response for `[goal:complete]` or `[goal:blocked]` markers, enforcing the evidence gate before archiving.
4. `preCompact` and `sessionStart` inject a goal summary into the compaction context so the goal survives session compaction.
5. `beforeSubmitPrompt` intercepts `/goal …` directives and pauses the loop when a real user message arrives ("latest instruction wins").

## Completion markers

The agent ends a turn with `[goal:complete]` **only** when the goal is verified, and must put a `[goal:evidence] …` line immediately before it:

```
[goal:evidence] ran npm test (83 passing), verified the build output
[goal:complete]
```

```
The deploy step needs a production API token I don't have.
[goal:blocked]
```

A `[goal:complete]` with no `[goal:evidence]` line is rejected and the loop continues. A `[goal:blocked]` with no concrete blocker is also rejected.

## Safety limits

| Limit | Default |
|---|---|
| Auto-continue turns | 10 |
| Max duration | 15 minutes |
| Context tokens | 200,000 |
| Min delay between continues | 1.5 seconds |
| No-progress pause | < 50 output tokens on a stalled turn (2-turn grace window) |

### Per-goal flags

| Flag | Controls |
|---|---|
| `--max-turns <n>` | Auto-continue turn limit |
| `--max-minutes <n>` | Duration limit in minutes |
| `--max-tokens <n>` | Context token limit |
| `--budget <n>` | Context token limit (accepts `k`/`m` suffix: `100k`, `1.5m`) |
| `--success <text>` | Success criteria |
| `--constraints <text>` | Constraints / non-goals (alias `--non-goals`) |
| `--mode <normal\|ordered>` | Execution mode; `ordered` (alias `sisyphus`) for strict sequences |

## Multiple goals

```
/goal add write the migration guide
/goal list
/goal focus 1
```

`/goal add` backgrounds the current goal and focuses a new one. Only the focused goal is auto-continued.

### Ordered (sisyphus) sequences

```
/goal sisyphus build the parser; write the tests; ship the release
```

Runs goals one at a time, auto-focusing the next when the current one completes.

## State

State is persisted to `.cursor/goals/state.json` (+ `.ledger.jsonl`). An append-only ledger records every lifecycle event. If the state file is missing or corrupted, goals are reconstructed from the ledger in a paused recovery state.

You may want to add `.cursor/goals/` to your `.gitignore`.

## Behavior notes

- **Setting a goal starts a turn.** `beforeSubmitPrompt` cannot rewrite the prompt, so `/goal <objective>` is passed through to the agent. Read-only and admin subcommands (`status`, `history`, `pause`, `clear`, etc.) block submission and return output directly.
- **Token budgeting is estimated** per turn from response length (~4 chars/token) and corrected with the real context size at `preCompact`.
- **No-tool-call detection** is omitted — `afterAgentResponse` only provides text, not tool call metadata.
- **The completion auditor** (child-session verification) is not ported; Cursor hooks have no session-spawning API. The `[goal:evidence]` gate still applies.

## Hook mapping

| Cursor hook | Role |
|---|---|
| `beforeSubmitPrompt` | Parse `/goal …` directives; pause on real user messages |
| `stop` | Return `followup_message` to auto-continue |
| `afterAgentResponse` | Check completion/blocked markers; update checkpoints |
| `preCompact` | Inject goal summary into compaction context; record real token count |
| `sessionStart` | Inject goal summary as `additional_context` after restart |

## Test

```sh
npm run smoke
```

Drives the core through set → continue → reject-unverified → complete → pause → resume → blocked → sisyphus auto-promote → clear, against a temp workspace, without invoking a model.

```sh
npm test
```

## Development

```sh
npm test             # run the test suite
npm run smoke        # verify end-to-end without a model call
npm run check        # tests only (no syntax check needed for .mjs)
npm run pack:check   # verify package contents before publishing
```

## License

MIT
