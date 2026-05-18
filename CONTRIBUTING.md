# Contributing

Thanks for helping improve `opencode-goal-plugin`.

## Development

Run the local checks before submitting changes:

```sh
npm run check
npm run pack:check
```

For behavior changes, add or update tests in `test/goal-plugin.test.js`.

## OpenCode Compatibility

This plugin depends on OpenCode plugin hooks, including experimental hooks. When changing hook usage or command behavior:

1. Check the current OpenCode plugin and command documentation.
2. Test against a real OpenCode install when possible.
3. Update the README compatibility note if the tested version changes.

## Pull Requests

Keep pull requests focused. Include:

- what changed
- why it changed
- the checks you ran
- any manual OpenCode smoke testing performed

