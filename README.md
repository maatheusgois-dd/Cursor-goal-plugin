# opencode-goal-plugin

Experimental session-scoped `/goal` workflow for [OpenCode](https://opencode.ai/).

This plugin lets you set a goal, keeps that goal in the session context, and auto-continues when the session becomes idle until the assistant marks the goal complete, reports that it is blocked, or a hard safety limit is reached.

## Install

Install the package in your OpenCode config directory or project:

```sh
npm install opencode-goal-plugin
```

Add the plugin and command to your OpenCode config:

```json
{
  "plugin": ["opencode-goal-plugin"],
  "command": {
    "goal": {
      "description": "Set a session-scoped goal and auto-continue until complete.",
      "template": "{{ .Arguments }}",
      "agent": "build"
    }
  }
}
```

## Usage

Set a goal:

```text
/goal fix the failing tests and verify the suite passes
```

Show status:

```text
/goal status
```

Clear the active goal:

```text
/goal clear
```

## Completion Markers

The plugin stops auto-continuing when the assistant includes one of these markers:

```text
[goal:complete]
[goal:blocked]
```

`[goal:complete]` means the goal is done. `[goal:blocked]` means user input is required.

## Safety Limits

The current defaults are intentionally conservative:

- 10 auto-continue turns
- 5 minutes
- 200,000 tracked tokens

When a limit is reached, the plugin clears the active goal instead of continuing indefinitely.

## Current Limitation

This is not a full Claude/Codex-style evaluator-backed `/goal` implementation yet. It is marker-based: the assistant is responsible for ending with `[goal:complete]` or `[goal:blocked]`.

That keeps the plugin small and avoids sending hidden evaluator prompts into the same session. A future version could add a separate evaluator model once OpenCode exposes a clean plugin API for that flow.

## Local Development

For local testing, add a file URL to your OpenCode config:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-goal-plugin/src/goal-plugin.js"]
}
```

Keep test files outside OpenCode's auto-loaded plugin directory. OpenCode will try to load plugin-like files in that folder during startup.

## License

MIT
