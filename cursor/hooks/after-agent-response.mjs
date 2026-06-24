#!/usr/bin/env node
// afterAgentResponse: record the assistant turn, run the completion/blocked
// integrity gate, checkpoint progress, and estimate token usage.
import { readInput, sessionIdOf, rootOf, run } from "./_io.mjs"
import { handleAgentResponse } from "../goal-core.mjs"

run(async () => {
  const input = await readInput()
  await handleAgentResponse(rootOf(input), sessionIdOf(input), input.text || "")
})
