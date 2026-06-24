#!/usr/bin/env node
// beforeSubmitPrompt: intercept `/goal …` directives and enforce "latest
// instruction wins" by pausing the loop when a real user message arrives.
import { readInput, sessionIdOf, rootOf, emit, run } from "./_io.mjs"
import { handleGoalCommand, handleUserIntervention } from "../goal-core.mjs"

const GOAL_DIRECTIVE = /^\/goal\b[ \t]*(.*)$/is

run(async () => {
  const input = await readInput()
  const root = rootOf(input)
  const sessionID = sessionIdOf(input)
  const prompt = typeof input.prompt === "string" ? input.prompt : ""

  const match = prompt.trim().match(GOAL_DIRECTIVE)
  if (match) {
    const { message, startWork } = await handleGoalCommand(root, sessionID, match[1])
    if (startWork) {
      // Let the submission through so the agent starts working toward the new
      // goal; the always-apply rule now carries the goal framing.
      emit({ continue: true })
    } else {
      // Read-only / admin subcommand: no agent turn needed — block and surface
      // the result to the user.
      emit({ continue: false, user_message: message })
    }
    return
  }

  // Not a directive: a genuine user message. If a loop is mid-flight, pause it
  // (the user's new instruction wins) but still let their message through.
  await handleUserIntervention(root, sessionID, prompt)
  emit({ continue: true })
})
