#!/usr/bin/env node
// sessionStart: re-surface the active goal as additional_context and refresh the
// always-apply rule, so a resumed/new session keeps the goal in view.
import { readInput, sessionIdOf, rootOf, emit, run } from "./_io.mjs"
import { handleSessionStart } from "../goal-core.mjs"

run(async () => {
  const input = await readInput()
  const context = await handleSessionStart(rootOf(input), sessionIdOf(input))
  emit(context ? { additional_context: context } : {})
})
