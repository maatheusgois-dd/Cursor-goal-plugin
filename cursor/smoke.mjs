// End-to-end smoke test for the Cursor /goal port. Drives the core through a
// full lifecycle against a temp workspace, without invoking a model.
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"

import {
  handleGoalCommand,
  handleAgentResponse,
  handleStop,
  handleUserIntervention,
  handleSessionStart,
  ruleFilePath,
  loadState,
} from "./goal-core.mjs"

const root = mkdtempSync(join(tmpdir(), "cursor-goal-"))
const SID = "conv-1"

// 1. Set a goal.
let res = await handleGoalCommand(root, SID, "fix the failing tests --max-turns 3")
assert.match(res.message, /New active goal: fix the failing tests/)
assert.equal(res.startWork, true)
assert.ok(existsSync(ruleFilePath(root)), "rule file written on set")
assert.match(readFileSync(ruleFilePath(root), "utf8"), /<goal_objective>/)

// 2. status
res = await handleGoalCommand(root, SID, "status")
assert.match(res.message, /Active goal: fix the failing tests/)

// 3. Assistant turn without completion → stop should auto-continue.
await handleAgentResponse(root, SID, "I ran the suite and three tests still fail. Investigating the assertion in foo.test.js now and editing the helper.")
let followup = await handleStop(root, SID)
assert.ok(followup && followup.includes("<goal_continuation>"), "stop returns a continuation")
let state = await loadState(root)
assert.equal(state.sessions[SID].goals[0].turnCount, 1)

// 4. The continuation prompt itself must NOT count as user intervention.
assert.equal(await handleUserIntervention(root, SID, followup), false)

// 5. Completion without evidence → rejected, keeps running.
await handleAgentResponse(root, SID, "All done.\n[goal:complete]")
state = await loadState(root)
assert.equal(state.sessions[SID].goals.length, 1, "unverified completion not archived")
followup = await handleStop(root, SID)
assert.ok(followup.includes("evidence"), "re-prompts for evidence")

// 6. Completion with evidence → archived.
await handleAgentResponse(root, SID, "Ran npm test: 42 passing, 0 failing.\n[goal:evidence] full suite green\n[goal:complete]")
state = await loadState(root)
assert.equal(state.sessions[SID].goals.length, 0, "goal archived on verified completion")
assert.equal(state.sessions[SID].lastResult.state, "achieved")
assert.ok(!existsSync(ruleFilePath(root)), "rule removed after completion")
followup = await handleStop(root, SID)
assert.equal(followup, null, "no continuation after completion")

// 7. User intervention pauses a running loop.
await handleGoalCommand(root, SID, "build the feature")
await handleAgentResponse(root, SID, "Starting on the feature, creating the module and wiring it up across the router.")
await handleStop(root, SID) // turnCount -> 1
const paused = await handleUserIntervention(root, SID, "actually, stop and do something else")
assert.equal(paused, true)
state = await loadState(root)
assert.equal(state.sessions[SID].goals[0].stopReason, "user intervention")

// 8. resume restores it.
res = await handleGoalCommand(root, SID, "resume")
assert.match(res.message, /Goal resumed/)

// 9. blocked with reason pauses.
await handleAgentResponse(root, SID, "Need the staging DB password to proceed.\n[goal:blocked]")
state = await loadState(root)
assert.equal(state.sessions[SID].goals[0].stopReason, "blocked")
assert.match(state.sessions[SID].goals[0].blockedReason, /staging DB password/)

// 10. sisyphus ordered sequence + auto-promote.
await handleGoalCommand(root, SID, "sisyphus first task; second task; third task")
state = await loadState(root)
assert.equal(state.sessions[SID].goals.length, 3)
assert.equal(state.sessions[SID].ordered, true)
await handleAgentResponse(root, SID, "Did it.\n[goal:evidence] verified\n[goal:complete]")
state = await loadState(root)
assert.equal(state.sessions[SID].goals.length, 2, "first ordered goal archived")
assert.equal(state.sessions[SID].goals[0].condition, "second task")
assert.equal(state.sessions[SID].focusedGoalId, state.sessions[SID].goals[0].goalId, "next promoted")

// 11. sessionStart re-materializes the rule for the active goal.
await handleSessionStart(root, SID)
assert.ok(existsSync(ruleFilePath(root)), "rule restored on session start")

// 12. clear wipes everything.
res = await handleGoalCommand(root, SID, "clear")
assert.match(res.message, /Goal cleared/)
state = await loadState(root)
assert.equal(state.sessions[SID].goals.length, 0)

// 13. bad flag is rejected.
res = await handleGoalCommand(root, SID, "do a thing --bogus 5")
assert.match(res.message, /could not be parsed/)

console.log("cursor smoke: all assertions passed")
