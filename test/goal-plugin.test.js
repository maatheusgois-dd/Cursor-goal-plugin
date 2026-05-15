import assert from "node:assert/strict"
import test from "node:test"
import pluginModule, { GoalPlugin, testInternals } from "../src/goal-plugin.js"

const {
  goalIsBlocked,
  goalIsComplete,
  isIdleEvent,
  normalizeOptions,
  parseGoalArguments,
} = testInternals

function textPart(text) {
  return { type: "text", text }
}

function message(text) {
  return {
    info: {
      id: "msg-assistant",
      role: "assistant",
      sessionID: "session-1",
      tokens: { input: 1, output: 1, reasoning: 0 },
    },
    parts: [textPart(text)],
  }
}

async function createHooks(overrides = {}) {
  const calls = []
  const client = {
    session: {
      messages: overrides.messages || (async () => ({ data: [message("still working")] })),
      promptAsync:
        overrides.promptAsync ||
        (async (input) => {
          calls.push(input)
          return {}
        }),
    },
  }
  const hooks = await GoalPlugin({ client }, overrides.options || {})
  return { calls, hooks }
}

test("exports v1 OpenCode plugin module shape", () => {
  assert.equal(pluginModule.id, "opencode-goal-plugin")
  assert.equal(pluginModule.server, GoalPlugin)
})

test("completion markers must be final-line markers", () => {
  assert.equal(goalIsComplete("Done\n\n[goal:complete]"), true)
  assert.equal(goalIsComplete("Done\n\n[goal:complete]   "), true)
  assert.equal(goalIsComplete("Is the goal complete?"), false)
  assert.equal(goalIsComplete("[goal:complete] (5 turns)"), false)
  assert.equal(goalIsBlocked("Need input\n[goal:blocked]"), true)
  assert.equal(goalIsBlocked("Don't consider this goal blocked."), false)
})

test("parses per-goal flags without including them in the condition", () => {
  const parsed = parseGoalArguments(
    'fix tests --max-turns 20 --max-minutes 15 --max-tokens 400000 --cooldown-ms 25',
    normalizeOptions(),
  )
  assert.equal(parsed.condition, "fix tests")
  assert.equal(parsed.options.maxTurns, 20)
  assert.equal(parsed.options.maxDurationMs, 15 * 60 * 1000)
  assert.equal(parsed.options.maxTokens, 400000)
  assert.equal(parsed.options.minDelayMs, 25)
})

test("recognizes session.status idle events alongside deprecated session.idle", () => {
  assert.equal(isIdleEvent({ type: "session.idle", properties: { sessionID: "a" } }), true)
  assert.equal(
    isIdleEvent({
      type: "session.status",
      properties: { sessionID: "a", status: { type: "idle" } },
    }),
    true,
  )
  assert.equal(
    isIdleEvent({
      type: "session.status",
      properties: { sessionID: "a", status: { type: "busy" } },
    }),
    false,
  )
})

test("system transform is idempotent", async () => {
  const { hooks } = await createHooks()
  await hooks["command.execute.before"](
    { command: "goal", sessionID: "session-1", arguments: "ship it" },
    { parts: [] },
  )

  const output = { system: [] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "session-1" }, output)
  await hooks["experimental.chat.system.transform"]({ sessionID: "session-1" }, output)

  assert.equal(output.system.length, 1)
  assert.match(output.system[0], /Active session goal: ship it/)
})

test("session.status idle auto-continues once", async () => {
  const { calls, hooks } = await createHooks({ options: { minDelayMs: 1 } })
  await hooks["command.execute.before"](
    { command: "goal", sessionID: "session-1", arguments: "ship it" },
    { parts: [] },
  )

  await hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "idle" } },
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].path.id, "session-1")
})

test("clear during an in-flight idle handler prevents promptAsync", async () => {
  let resolveMessages
  const messagesPromise = new Promise((resolve) => {
    resolveMessages = resolve
  })
  const { calls, hooks } = await createHooks({
    messages: async () => messagesPromise,
    options: { minDelayMs: 1 },
  })

  await hooks["command.execute.before"](
    { command: "goal", sessionID: "session-1", arguments: "ship it" },
    { parts: [] },
  )

  const idle = hooks.event({
    event: { type: "session.idle", properties: { sessionID: "session-1" } },
  })

  await hooks["command.execute.before"](
    { command: "goal", sessionID: "session-1", arguments: "clear" },
    { parts: [] },
  )

  resolveMessages({ data: [message("still working")] })
  await idle

  assert.equal(calls.length, 0)
})
