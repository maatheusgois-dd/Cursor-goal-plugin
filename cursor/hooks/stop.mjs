#!/usr/bin/env node
// stop: decide whether to auto-continue toward the active goal. A non-empty
// followup_message is auto-submitted by Cursor as the next user message, which
// drives the loop (OpenCode's session.idle auto-continue, ported).
import { readInput, sessionIdOf, rootOf, emit, run } from "./_io.mjs"
import { handleStop } from "../goal-core.mjs"

run(async () => {
  const input = await readInput()
  // Only continue after a normal completion; never resurrect an aborted/errored
  // turn.
  if (input.status && input.status !== "completed") {
    emit({})
    return
  }
  const followup = await handleStop(rootOf(input), sessionIdOf(input))
  emit(followup ? { followup_message: followup } : {})
})
