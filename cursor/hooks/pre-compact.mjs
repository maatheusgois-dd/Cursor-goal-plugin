#!/usr/bin/env node
// preCompact: sync the real context-token count into the goal budget and
// preserve the goal across compaction (observational — cannot block).
import { readInput, sessionIdOf, rootOf, emit, run } from "./_io.mjs"
import { handlePreCompact } from "../goal-core.mjs"

run(async () => {
  const input = await readInput()
  const context = await handlePreCompact(rootOf(input), sessionIdOf(input), Number(input.context_tokens))
  emit(context ? { user_message: "Active /goal preserved across compaction." } : {})
})
