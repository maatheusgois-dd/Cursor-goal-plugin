Set a session-scoped goal and auto-continue until it is complete, blocked, or a
safety limit is reached.

Usage (the `beforeSubmitPrompt` hook parses everything after `/goal`):

- `/goal <objective>` — set a goal and start working toward it
- `/goal <objective> --max-turns 20 --max-minutes 30 --max-tokens 400000`
- `/goal <objective> --success "tests pass" --constraints "don't touch the API" --mode ordered`
- `/goal status` — show the active goal and budget usage
- `/goal history` — lifecycle events and the latest checkpoint
- `/goal list` — all goals in this session (focused / background / queued)
- `/goal add <objective>` — background the current goal and focus a new one
- `/goal focus <number>` — switch the focused goal
- `/goal sisyphus <obj 1>; <obj 2>; …` — run an ordered sequence
- `/goal edit <new objective>` — revise the objective in place
- `/goal pause` / `/goal resume` / `/goal clear`

$ARGUMENTS
