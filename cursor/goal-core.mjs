// Cursor port of the /goal workflow.
//
// OpenCode runs the plugin as one long-lived process that holds goal state in
// in-memory Maps and drives auto-continue from a `session.idle` event. Cursor
// has no plugin runtime: each lifecycle event spawns a short-lived hook process
// that talks JSON over stdin/stdout. So this core is *stateless across calls* —
// every hook loads goal state from `.cursor/goals/state.json`, mutates it, and
// writes it back.
//
// All prompt/parse/format logic is reused verbatim from the OpenCode plugin via
// its `testInternals` export, so the goal block, continuation prompt, completion
// gate, limit warnings, and argument parsing stay byte-for-byte identical. Only
// the stateful glue (persistence, the per-event state machine, and the
// rule-file injection that replaces OpenCode's system.transform) lives here.

import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { dirname, join } from "node:path"

import { testInternals } from "./shared.mjs"

const {
  parseGoalArguments,
  normalizeOptions,
  normalizeMode,
  parseTokenBudget,
  buildGoalBlock,
  buildContinueMessage,
  buildLimitWarning,
  buildCompactionContext,
  goalIsComplete,
  goalIsBlocked,
  extractCompletionEvidence,
  extractBlockedReason,
  stopReason,
  budgetWrapupNeeded,
  formatStatus,
  formatArgumentErrors,
} = testInternals

// ---------------------------------------------------------------------------
// Constants (mirrored from the OpenCode plugin).
// ---------------------------------------------------------------------------

const STATE_FILE_VERSION = 1
const MAX_HISTORY_ENTRIES = 20
const MAX_CHECKPOINTS = 5
const CHECKPOINT_CHAR_LIMIT = 280
const MAX_ARCHIVED_PER_SESSION = 10
// Cursor hooks never see real token counts except at preCompact, so per-turn
// budget tracking estimates output tokens from text length (~4 chars/token).
const CHARS_PER_TOKEN = 4

const CLEAR_COMMANDS = new Set(["clear", "stop", "off", "reset", "none", "cancel"])
const PAUSE_COMMANDS = new Set(["pause"])

export const DEFAULT_OPTIONS = normalizeOptions({})

// ---------------------------------------------------------------------------
// Paths.
// ---------------------------------------------------------------------------

export function stateFilePath(root) {
  const envPath = process.env.CURSOR_GOAL_STATE_PATH
  if (typeof envPath === "string" && envPath.trim()) return envPath.trim()
  return join(root, ".cursor", "goals", "state.json")
}

export function ledgerFilePath(root) {
  return `${stateFilePath(root)}.ledger.jsonl`
}

export function ruleFilePath(root) {
  return join(root, ".cursor", "rules", "active-goal.mdc")
}

// ---------------------------------------------------------------------------
// Small stateful helpers reimplemented here (not exported by the plugin).
// ---------------------------------------------------------------------------

function summarizeText(text, limit = CHECKPOINT_CHAR_LIMIT) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

function makeHistoryEntry(type, detail, timestamp = Date.now()) {
  return { type, detail: summarizeText(detail, 400), timestamp }
}

function pushHistory(goal, type, detail, timestamp = Date.now()) {
  const entry = makeHistoryEntry(type, detail, timestamp)
  goal.history = [...(goal.history || []), entry].slice(-MAX_HISTORY_ENTRIES)
  return entry
}

function recordCheckpoint(goal, text, timestamp = Date.now()) {
  const summary = summarizeText(text)
  if (!summary) return
  if (goal.lastCheckpoint?.summary === summary) return
  const checkpoint = { summary, timestamp }
  goal.lastCheckpoint = checkpoint
  goal.checkpoints = [...(goal.checkpoints || []), checkpoint].slice(-MAX_CHECKPOINTS)
}

function buildGoalState(sessionID, condition, options, meta = {}, lastStatus = "Goal set.") {
  return {
    goalId: randomUUID(),
    condition,
    successCriteria: typeof meta.successCriteria === "string" ? meta.successCriteria : "",
    constraints: typeof meta.constraints === "string" ? meta.constraints : "",
    mode: normalizeMode(meta.mode) || "normal",
    sessionID,
    turnCount: 0,
    startedAt: Date.now(),
    totalTokens: 0,
    options,
    lastStatus,
    lastAssistantText: "",
    lastContinueAt: 0,
    lastProgressAt: 0,
    noProgressTurns: 0,
    blockedReason: "",
    budgetWrapupSent: false,
    stopped: false,
    stopReason: "",
    promptFailures: 0,
    history: [],
    checkpoints: [],
    lastCheckpoint: null,
  }
}

function formatHistory(history = []) {
  if (!history.length) return "No goal history recorded yet."
  return history
    .map((entry) => `- [${new Date(entry.timestamp).toISOString()}] ${entry.type}: ${entry.detail}`)
    .join("\n")
}

function rememberResult(sessionState, goal, state, reason = "", evidence = "") {
  sessionState.lastResult = {
    condition: goal.condition,
    state,
    reason,
    evidence,
    blockedReason: goal.blockedReason,
    turnCount: goal.turnCount,
    totalTokens: goal.totalTokens,
    startedAt: goal.startedAt,
    finishedAt: Date.now(),
    lastStatus: goal.lastStatus,
    lastCheckpoint: goal.lastCheckpoint || null,
    history: [...(goal.history || [])],
  }
  sessionState.archive = [...(sessionState.archive || []), { ...sessionState.lastResult }].slice(
    -MAX_ARCHIVED_PER_SESSION,
  )
}

function formatGoalResult(result) {
  const elapsed = Math.round((result.finishedAt - result.startedAt) / 1000)
  const lines = [
    `Last goal: ${result.condition}`,
    `State: ${result.state}`,
    `Auto-continues sent: ${result.turnCount}`,
    `Elapsed: ${elapsed}s`,
    `Last status: ${result.lastStatus || "No status recorded."}`,
  ]
  if (result.evidence) lines.push(`Evidence: ${result.evidence}`)
  if (result.blockedReason) lines.push(`Blocked reason: ${result.blockedReason}`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Persistence. State shape:
//   { version, sessions: { [sessionID]: { focusedGoalId, ordered, goals: [],
//                                          lastResult, archive: [] } } }
// ---------------------------------------------------------------------------

function emptyState() {
  return { version: STATE_FILE_VERSION, sessions: {} }
}

export async function loadState(root) {
  try {
    const raw = await fs.readFile(stateFilePath(root), "utf8")
    const parsed = JSON.parse(raw)
    if (parsed?.version !== STATE_FILE_VERSION || typeof parsed.sessions !== "object") {
      return emptyState()
    }
    return parsed
  } catch {
    return emptyState()
  }
}

export async function saveState(root, state) {
  const path = stateFilePath(root)
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 })
  await fs.rename(tmp, path)
}

async function appendLedger(root, goal, entry) {
  try {
    const path = ledgerFilePath(root)
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await fs.appendFile(
      path,
      `${JSON.stringify({ ts: entry.timestamp, sessionID: goal.sessionID, goalId: goal.goalId, condition: goal.condition, type: entry.type, detail: entry.detail })}\n`,
      { mode: 0o600 },
    )
  } catch {
    // Ledger is best-effort durability; never break the workflow.
  }
}

function sessionState(state, sessionID) {
  if (!state.sessions[sessionID]) {
    state.sessions[sessionID] = { focusedGoalId: null, ordered: false, goals: [], lastResult: null, archive: [] }
  }
  return state.sessions[sessionID]
}

function focusedGoal(session) {
  if (!session?.focusedGoalId) return null
  return (session.goals || []).find((g) => g.goalId === session.focusedGoalId) || null
}

function listGoals(session) {
  return session?.goals || []
}

function removeGoal(session, goalId) {
  session.goals = (session.goals || []).filter((g) => g.goalId !== goalId)
}

function promoteNextOrdered(session) {
  const next = listGoals(session)[0]
  if (!next) {
    session.ordered = false
    session.focusedGoalId = null
    return null
  }
  next.stopped = false
  next.stopReason = ""
  next.blockedReason = ""
  next.lastStatus = "Promoted as the next ordered goal."
  pushHistory(next, "focused", "Auto-promoted as the next goal in the ordered (sisyphus) sequence.")
  session.focusedGoalId = next.goalId
  return next
}

function resetBudget(goal) {
  goal.goalId = randomUUID()
  goal.startedAt = Date.now()
  goal.turnCount = 0
  goal.totalTokens = 0
  goal.lastContinueAt = 0
  goal.lastProgressAt = 0
  goal.noProgressTurns = 0
  goal.budgetWrapupSent = false
  goal.promptFailures = 0
  goal.history = [...(goal.history || [])].slice(-MAX_HISTORY_ENTRIES)
}

// ---------------------------------------------------------------------------
// Rule-file injection. Cursor's beforeSubmitPrompt cannot inject context, so the
// goal block is materialized into an always-apply rule that Cursor loads into
// every turn — the equivalent of OpenCode's experimental.chat.system.transform.
// ---------------------------------------------------------------------------

export async function writeRule(root, goal) {
  const path = ruleFilePath(root)
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const body = [
    "---",
    "description: Active autonomous /goal for this session — keep working until satisfied.",
    "alwaysApply: true",
    "---",
    "",
    buildGoalBlock(goal),
    "",
    "Keep working until the goal is fully satisfied.",
    "When fully satisfied, put a `[goal:evidence]` line summarizing what you verified immediately before `[goal:complete]`. A `[goal:complete]` without evidence is rejected.",
    "If user input is required, explain the concrete blocker in the line immediately before `[goal:blocked]`. A `[goal:blocked]` without a concrete blocker is rejected.",
    buildLimitWarning(goal),
  ]
    .filter(Boolean)
    .join("\n")
  await fs.writeFile(path, `${body}\n`, { encoding: "utf8", mode: 0o600 })
}

export async function clearRule(root) {
  try {
    await fs.rm(ruleFilePath(root))
  } catch {
    // Already gone.
  }
}

// Re-derive the rule file from current state: write the focused running goal's
// block, or remove the rule when nothing is actively running.
async function syncRule(root, session) {
  const goal = focusedGoal(session)
  if (goal && !goal.stopped) {
    await writeRule(root, goal)
  } else {
    await clearRule(root)
  }
}

// ---------------------------------------------------------------------------
// Command surface — ports `command.execute.before` (`/goal …`).
// Returns { message, startWork } where startWork=true means the agent should
// begin a turn toward a freshly created goal.
// ---------------------------------------------------------------------------

export async function handleGoalCommand(root, sessionID, rawArgs) {
  const state = await loadState(root)
  const session = sessionState(state, sessionID)
  const args = String(rawArgs || "").trim()
  let startWork = false

  const finish = async (message) => {
    await syncRule(root, session)
    await saveState(root, state)
    return { message, startWork }
  }
  const record = async (goal, type, detail) => {
    await appendLedger(root, goal, pushHistory(goal, type, detail))
  }

  if (!args || args === "status") {
    const goal = focusedGoal(session)
    return finish(
      goal
        ? formatStatus(goal, "goal")
        : session.lastResult
          ? formatGoalResult(session.lastResult)
          : "No active goal. Set one with `/goal <condition>`.",
    )
  }

  if (args === "history") {
    const goal = focusedGoal(session)
    if (goal) {
      return finish(
        [`Goal history for: ${goal.condition}`, "", `Latest checkpoint: ${goal.lastCheckpoint?.summary || "none yet"}`, "", formatHistory(goal.history)].join("\n"),
      )
    }
    if (session.lastResult) {
      return finish(
        [`Last goal history for: ${session.lastResult.condition}`, "", `Latest checkpoint: ${session.lastResult.lastCheckpoint?.summary || "none recorded"}`, "", formatHistory(session.lastResult.history)].join("\n"),
      )
    }
    return finish("No goal history recorded yet. Set a goal with `/goal <condition>`.")
  }

  if (CLEAR_COMMANDS.has(args)) {
    session.goals = []
    session.focusedGoalId = null
    session.ordered = false
    session.lastResult = null
    return finish("Goal cleared.")
  }

  if (PAUSE_COMMANDS.has(args)) {
    const goal = focusedGoal(session)
    if (!goal) return finish("No active goal. Set one with `/goal <condition>`.")
    goal.stopped = true
    goal.stopReason = "paused"
    goal.lastStatus = "Goal paused."
    await record(goal, "paused", "User paused the active goal.")
    return finish(`Goal paused: ${goal.condition}`)
  }

  if (args === "resume") {
    const goal = focusedGoal(session)
    if (!goal) return finish("No active goal. Set one with `/goal <condition>`.")
    if (!goal.stopped) return finish("Goal is already running.")
    resetBudget(goal)
    session.focusedGoalId = goal.goalId
    goal.stopped = false
    goal.stopReason = ""
    goal.blockedReason = ""
    goal.lastStatus = "Goal resumed with a fresh local budget."
    await record(goal, "resumed", "User resumed the goal with a fresh local budget window.")
    startWork = true
    return finish(`Goal resumed with fresh limits: ${goal.condition}`)
  }

  if (args === "list") {
    return finish(formatGoalList(session))
  }

  if (args === "edit" || args.toLowerCase().startsWith("edit ")) {
    const goal = focusedGoal(session)
    if (!goal) return finish("No active goal to edit. Set one with `/goal <condition>`.")
    const newObjective = stripQuotes(args.slice("edit".length).trim())
    if (!newObjective) return finish("No new objective provided. Use `/goal edit <new objective>`.")
    goal.condition = newObjective
    goal.stopped = false
    goal.stopReason = ""
    goal.blockedReason = ""
    goal.budgetWrapupSent = false
    goal.noProgressTurns = 0
    goal.lastStatus = "Goal objective updated."
    await record(goal, "edited", `Objective updated to: ${summarizeText(newObjective, 400)}`)
    startWork = true
    return finish(`Goal objective updated: ${goal.condition}\n\nBudgets and history are preserved. Run \`/goal resume\` for a fresh budget window.`)
  }

  if (args === "focus" || args.toLowerCase().startsWith("focus ")) {
    const ref = args.slice("focus".length).trim()
    const goals = listGoals(session)
    if (!goals.length) return finish("No goals to focus. Set one with `/goal <condition>`.")
    if (!ref) return finish(["Specify which goal to focus:", "", formatGoalList(session)].join("\n"))
    let target
    if (/^\d+$/.test(ref)) {
      const index = Number.parseInt(ref, 10)
      target = index >= 1 && index <= goals.length ? goals[index - 1] : undefined
    } else {
      target = goals.find((g) => g.goalId === ref || g.goalId.startsWith(ref))
    }
    if (!target) return finish(`No goal matches "${ref}". Run \`/goal list\` to see the numbered goals.`)
    const current = focusedGoal(session)
    if (current && current.goalId === target.goalId) return finish(`Goal already focused: ${target.condition}`)
    if (current) {
      current.stopped = true
      current.stopReason = "backgrounded"
      await record(current, "backgrounded", "Backgrounded when focus switched to another goal.")
    }
    target.stopped = false
    target.stopReason = ""
    target.blockedReason = ""
    target.lastStatus = "Goal focused."
    await record(target, "focused", "Brought into focus as the session's active goal.")
    session.focusedGoalId = target.goalId
    startWork = true
    return finish([`Focused goal: ${target.condition}`, current ? `Backgrounded: ${current.condition}` : null].filter(Boolean).join("\n"))
  }

  if (args === "sisyphus" || args.toLowerCase().startsWith("sisyphus ")) {
    const rest = args.slice("sisyphus".length).trim()
    const objectives = rest.split(/\n|;/).map((p) => stripQuotes(p.trim())).filter(Boolean)
    if (!objectives.length) {
      return finish("No objectives provided. Use `/goal sisyphus <objective 1>; <objective 2>; …` (separate with `;` or newlines).")
    }
    session.goals = []
    session.lastResult = null
    let first = null
    for (const [index, objective] of objectives.entries()) {
      const created = buildGoalState(sessionID, objective, { ...DEFAULT_OPTIONS })
      if (index === 0) first = created
      else {
        created.stopped = true
        created.stopReason = "queued"
      }
      pushHistory(created, "set", `Ordered goal ${index + 1}/${objectives.length} created (sisyphus sequence).`)
      session.goals.push(created)
    }
    session.focusedGoalId = first.goalId
    session.ordered = true
    startWork = true
    return finish([`Started an ordered sequence of ${objectives.length} goal(s) (sisyphus mode):`, ...objectives.map((o, i) => `${i + 1}. ${o}`), "", `Focused goal 1: ${first.condition}`].join("\n"))
  }

  // add / set (objective + flags).
  const isAdd = args === "add" || args.toLowerCase().startsWith("add ")
  const createArgs = isAdd ? args.slice("add".length).trim() : args
  const parsed = parseGoalArguments(createArgs, DEFAULT_OPTIONS)
  if (parsed.errors.length > 0) return finish(formatArgumentErrors(parsed.errors))
  if (!parsed.condition) {
    return finish(isAdd ? "No objective provided. Use `/goal add <condition>`." : "No goal provided. Set one with `/goal <condition>`.")
  }

  if (isAdd) {
    const current = focusedGoal(session)
    if (current) {
      current.stopped = true
      current.stopReason = "backgrounded"
      await record(current, "backgrounded", "Backgrounded when a new goal was added.")
    }
    const added = buildGoalState(sessionID, parsed.condition, parsed.options, parsed.meta)
    await record(added, "set", `Goal added with limits: ${added.options.maxTurns} auto-continues, ${Math.round(added.options.maxDurationMs / 1000)}s, ${added.options.maxTokens.toLocaleString()} context tokens.`)
    session.goals.push(added)
    session.focusedGoalId = added.goalId
    startWork = true
    return finish([`Added and focused new goal: ${added.condition}`, `${listGoals(session).length} goal(s) now active in this session. Run \`/goal list\` to see them.`].join("\n"))
  }

  // Replace the focused goal.
  const goal = buildGoalState(sessionID, parsed.condition, parsed.options, parsed.meta)
  await record(goal, "set", `Goal created with limits: ${goal.options.maxTurns} auto-continues, ${Math.round(goal.options.maxDurationMs / 1000)}s, ${goal.options.maxTokens.toLocaleString()} context tokens.`)
  if (session.focusedGoalId) removeGoal(session, session.focusedGoalId)
  session.lastResult = null
  session.goals.push(goal)
  session.focusedGoalId = goal.goalId
  startWork = true
  return finish(
    [
      `New active goal: ${goal.condition}`,
      goal.successCriteria ? `Success criteria: ${goal.successCriteria}` : null,
      goal.constraints ? `Constraints / non-goals: ${goal.constraints}` : null,
      goal.mode !== "normal" ? `Mode: ${goal.mode}` : null,
      "",
      "Start working toward this goal now. It will auto-continue until satisfied.",
      `Limits: ${goal.options.maxTurns} auto-continues, ${Math.round(goal.options.maxDurationMs / 1000)}s, ${goal.options.maxTokens.toLocaleString()} context tokens.`,
    ]
      .filter((l) => l !== null)
      .join("\n"),
  )
}

function formatGoalList(session) {
  const goals = listGoals(session)
  const focusedId = session.focusedGoalId
  const archived = session.archive || []
  if (!goals.length && !archived.length) {
    return "No goals yet. Set one with `/goal <condition>`, or add more with `/goal add <condition>`."
  }
  const lines = []
  if (goals.length) {
    lines.push(`Goals (${goals.length})${session.ordered ? " — ordered (sisyphus)" : ""}:`)
    goals.forEach((goal, index) => {
      const marker = goal.goalId === focusedId ? "focused" : goal.stopped ? "background" : "idle"
      const state = goal.stopped && goal.goalId !== focusedId ? ` — ${goal.stopReason || "stopped"}` : ""
      lines.push(`${index + 1}. [${marker}] ${goal.condition}${state}`)
    })
    lines.push("Switch with `/goal focus <number>`.")
  }
  if (archived.length) {
    lines.push("", `Archived (${archived.length}, newest last):`)
    archived.forEach((r) => lines.push(`- [${r.state}] ${r.condition}`))
  }
  return lines.join("\n")
}

function stripQuotes(value) {
  return String(value).replace(/^["']|["']$/g, "")
}

// ---------------------------------------------------------------------------
// afterAgentResponse — records the assistant turn, runs the completion/blocked
// integrity gate, checkpoints progress, and estimates token usage.
// ---------------------------------------------------------------------------

export async function handleAgentResponse(root, sessionID, text) {
  const state = await loadState(root)
  const session = sessionState(state, sessionID)
  const goal = focusedGoal(session)
  if (!goal || goal.stopped) return
  const record = async (type, detail) => appendLedger(root, goal, pushHistory(goal, type, detail))

  const latestText = String(text || "")
  recordCheckpoint(goal, latestText)
  goal.lastAssistantText = latestText
  // Estimate the turn's output tokens; feeds the no-progress + budget checks.
  const estTokens = Math.ceil(latestText.length / CHARS_PER_TOKEN)
  goal.totalTokens += estTokens
  goal.lastEstOutputTokens = estTokens
  if (estTokens >= goal.options.noProgressTokenThreshold) goal.lastProgressAt = Date.now()

  if (goalIsComplete(latestText)) {
    const evidence = extractCompletionEvidence(latestText)
    if (evidence) {
      goal.lastStatus = "Goal completed."
      await record("completed", `Assistant marked the goal complete with evidence: ${summarizeText(evidence, 400)}`)
      rememberResult(session, goal, "achieved", "", evidence)
      removeGoal(session, goal.goalId)
      session.focusedGoalId = null
      if (session.ordered) promoteNextOrdered(session)
    } else {
      goal.completionUnverified = true
      goal.lastStatus = "Rejected [goal:complete]: no [goal:evidence] line provided. Re-prompting for evidence."
      await record("completion-unverified", "Assistant output [goal:complete] without a [goal:evidence] line; completion rejected, continuing.")
    }
  } else if (goalIsBlocked(latestText)) {
    const reason = extractBlockedReason(latestText)
    if (reason) {
      goal.blockedReason = reason
      goal.lastStatus = "Assistant reported blocked."
      goal.stopped = true
      goal.stopReason = "blocked"
      await record("blocked", reason)
    } else {
      goal.blockerUnstated = true
      goal.lastStatus = "Rejected [goal:blocked]: no concrete blocker stated. Re-prompting for the specific blocker."
      await record("blocker-unstated", "Assistant output [goal:blocked] without a concrete blocker line; rejected, continuing.")
    }
  }

  await syncRule(root, session)
  await saveState(root, state)
}

// ---------------------------------------------------------------------------
// stop — decides whether to auto-continue. Returns a followup_message string to
// drive another turn, or null to let the agent stop.
// ---------------------------------------------------------------------------

export async function handleStop(root, sessionID) {
  const state = await loadState(root)
  const session = sessionState(state, sessionID)
  const goal = focusedGoal(session)
  if (!goal || goal.stopped) return null
  const record = async (type, detail) => appendLedger(root, goal, pushHistory(goal, type, detail))

  const completionUnverified = goal.completionUnverified === true
  const blockerUnstated = goal.blockerUnstated === true
  delete goal.completionUnverified
  delete goal.blockerUnstated

  // Hard limit gate: turns / duration / tokens.
  const limitReason = stopReason(goal)
  if (limitReason) {
    if (!goal.budgetWrapupSent) {
      goal.budgetWrapupSent = true
      goal.stopped = true
      goal.stopReason = limitReason
      goal.lastStatus = `${limitReason}; requested final handoff.`
      await record("limit", `${limitReason}; requested a final handoff.`)
      await syncRule(root, session)
      await saveState(root, state)
      return buildContinueMessage(goal, { budgetWrapup: true })
    }
    goal.stopped = true
    goal.stopReason = limitReason
    goal.lastStatus = limitReason
    await record("limit", limitReason)
    await syncRule(root, session)
    await saveState(root, state)
    return null
  }

  // No-progress gate: repeated low-output turns indicate a stall.
  const lowOutput = goal.turnCount > 0 && (goal.lastEstOutputTokens || 0) < goal.options.noProgressTokenThreshold
  if (lowOutput) {
    goal.noProgressTurns += 1
    if (goal.noProgressTurns >= goal.options.noProgressTurnsBeforePause) {
      goal.stopped = true
      goal.stopReason = "no progress"
      goal.lastStatus = `Goal auto-continue paused after ${goal.noProgressTurns} low-progress turn(s). Run /goal resume to continue.`
      await record("paused", `Paused after ${goal.noProgressTurns} low-progress turn(s) below ${goal.options.noProgressTokenThreshold} output tokens.`)
      await syncRule(root, session)
      await saveState(root, state)
      return null
    }
    await record("warning", `Observed a low-progress turn; grace count ${goal.noProgressTurns}/${goal.options.noProgressTurnsBeforePause}.`)
  } else {
    goal.noProgressTurns = 0
  }

  // Budget wrap-up: near the token ceiling, request a final handoff turn.
  const wrapup = budgetWrapupNeeded(goal)
  if (wrapup) {
    goal.budgetWrapupSent = true
    goal.stopped = true
    goal.stopReason = "budget wrap-up requested"
    goal.lastStatus = "Budget threshold reached; requested final handoff."
  }

  goal.turnCount += 1
  goal.lastContinueAt = Date.now()
  if (!wrapup) {
    goal.lastStatus = completionUnverified
      ? `Rejected an unverified [goal:complete]; re-prompting for evidence on turn ${goal.turnCount}.`
      : blockerUnstated
        ? `Rejected a [goal:blocked] with no concrete blocker; re-prompting on turn ${goal.turnCount}.`
        : `Continuing after assistant turn ${goal.turnCount}.`
  }
  await record(wrapup ? "budget-wrapup" : "auto-continue", wrapup ? "Sent a final handoff request near the context token budget." : `Sent auto-continue prompt ${goal.turnCount}/${goal.options.maxTurns}.`)
  await syncRule(root, session)
  await saveState(root, state)
  return buildContinueMessage(goal, { budgetWrapup: wrapup, completionUnverified, blockerUnstated })
}

// ---------------------------------------------------------------------------
// beforeSubmitPrompt — "latest instruction wins". A real user message (not one
// of our own continuation prompts) while a goal loop is running pauses the goal.
// Returns true when the goal was paused.
// ---------------------------------------------------------------------------

export async function handleUserIntervention(root, sessionID, prompt) {
  const text = String(prompt || "")
  if (text.includes("<goal_continuation>")) return false // our own auto-continue
  const state = await loadState(root)
  const session = sessionState(state, sessionID)
  const goal = focusedGoal(session)
  if (!goal || goal.stopped || goal.turnCount <= 0) return false
  goal.stopped = true
  goal.stopReason = "user intervention"
  goal.lastStatus = "Auto-continue paused: you sent a new message, so the latest instruction wins. Run /goal resume to continue the goal."
  await appendLedger(root, goal, pushHistory(goal, "paused", "Paused auto-continue after a real user message arrived; latest instruction wins."))
  await clearRule(root)
  await saveState(root, state)
  return true
}

// ---------------------------------------------------------------------------
// preCompact — sync real token usage and preserve the goal across compaction.
// sessionStart — re-surface the active goal block as additional_context.
// ---------------------------------------------------------------------------

export async function handlePreCompact(root, sessionID, contextTokens) {
  const state = await loadState(root)
  const session = sessionState(state, sessionID)
  const goal = focusedGoal(session)
  if (!goal) return null
  if (Number.isFinite(contextTokens) && contextTokens > 0) {
    goal.totalTokens = Math.max(goal.totalTokens, contextTokens)
    await saveState(root, state)
  }
  return buildCompactionContext(goal)
}

export async function handleSessionStart(root, sessionID) {
  const state = await loadState(root)
  const session = sessionState(state, sessionID)
  const goal = focusedGoal(session)
  if (!goal || goal.stopped) {
    await clearRule(root)
    return null
  }
  await writeRule(root, goal)
  return buildCompactionContext(goal)
}
