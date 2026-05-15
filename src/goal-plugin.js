const DEFAULT_OPTIONS = {
  maxTurns: 10,
  maxDurationMs: 5 * 60 * 1000,
  maxTokens: 200000,
  minDelayMs: 1500,
  warnTurnsRemaining: 3,
  warnDurationMsRemaining: 60 * 1000,
  warnTokensRemaining: 25000,
}

const goalStates = new Map()
const seenTokens = new Map()
const activeContinues = new Set()
let nextGoalID = 1

function getText(parts) {
  return (parts || [])
    .filter((part) => part && part.type === "text" && !part.ignored)
    .map((part) => part.text || "")
    .join("\n")
    .trim()
}

function makeTextPart(text) {
  return { type: "text", text }
}

function getSessionID(event) {
  return event?.properties?.sessionID || event?.properties?.info?.sessionID || null
}

function isIdleEvent(event) {
  return (
    event?.type === "session.idle" ||
    (event?.type === "session.status" && event?.properties?.status?.type === "idle")
  )
}

function formatStatus(goal) {
  const elapsed = Math.round((Date.now() - goal.startedAt) / 1000)
  return [
    `Active goal: ${goal.condition}`,
    `Auto-continues sent: ${goal.turnCount}/${goal.options.maxTurns}`,
    `Tokens: ${goal.totalTokens.toLocaleString()}/${goal.options.maxTokens.toLocaleString()}`,
    `Elapsed: ${elapsed}s/${Math.round(goal.options.maxDurationMs / 1000)}s`,
    `Last status: ${goal.lastStatus || "No assistant turn recorded yet."}`,
  ].join("\n")
}

function goalIsComplete(text) {
  return /(^|\n)\s*\[goal:complete\]\s*$/i.test(text.trimEnd())
}

function goalIsBlocked(text) {
  return /(^|\n)\s*\[goal:blocked\]\s*$/i.test(text.trimEnd())
}

function stopReason(goal) {
  if (goal.turnCount >= goal.options.maxTurns) return `max turns reached (${goal.options.maxTurns})`
  if (Date.now() - goal.startedAt >= goal.options.maxDurationMs) {
    return `max duration reached (${Math.round(goal.options.maxDurationMs / 1000)}s)`
  }
  if (goal.totalTokens >= goal.options.maxTokens) return `max tokens reached (${goal.options.maxTokens})`
  return null
}

function cleanupGoal(sessionID) {
  const goal = goalStates.get(sessionID)
  if (goal) {
    for (const messageID of goal.messageIDs) {
      seenTokens.delete(messageID)
    }
  }
  goalStates.delete(sessionID)
  activeContinues.delete(sessionID)
}

function currentGoal(sessionID, goalID) {
  const goal = goalStates.get(sessionID)
  if (!goal) return null
  if (goalID !== undefined && goal.id !== goalID) return null
  return goal
}

function toPositiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeOptions(options = {}) {
  return {
    maxTurns: toPositiveInteger(options.maxTurns, DEFAULT_OPTIONS.maxTurns),
    maxDurationMs: toPositiveInteger(options.maxDurationMs, DEFAULT_OPTIONS.maxDurationMs),
    maxTokens: toPositiveInteger(options.maxTokens, DEFAULT_OPTIONS.maxTokens),
    minDelayMs: toPositiveInteger(options.minDelayMs, DEFAULT_OPTIONS.minDelayMs),
    warnTurnsRemaining: toPositiveInteger(
      options.warnTurnsRemaining,
      DEFAULT_OPTIONS.warnTurnsRemaining,
    ),
    warnDurationMsRemaining: toPositiveInteger(
      options.warnDurationMsRemaining,
      DEFAULT_OPTIONS.warnDurationMsRemaining,
    ),
    warnTokensRemaining: toPositiveInteger(
      options.warnTokensRemaining,
      DEFAULT_OPTIONS.warnTokensRemaining,
    ),
  }
}

function parseGoalArguments(args, defaults) {
  const parts = args.match(/"[^"]*"|'[^']*'|\S+/g) || []
  const condition = []
  const options = { ...defaults }

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]
    const next = parts[i + 1]

    if (part === "--max-turns" && next) {
      options.maxTurns = toPositiveInteger(next, options.maxTurns)
      i += 1
      continue
    }
    if (part === "--max-duration-ms" && next) {
      options.maxDurationMs = toPositiveInteger(next, options.maxDurationMs)
      i += 1
      continue
    }
    if (part === "--max-minutes" && next) {
      options.maxDurationMs = toPositiveInteger(next, options.maxDurationMs / 60000) * 60000
      i += 1
      continue
    }
    if (part === "--max-tokens" && next) {
      options.maxTokens = toPositiveInteger(next, options.maxTokens)
      i += 1
      continue
    }
    if (part === "--cooldown-ms" && next) {
      options.minDelayMs = toPositiveInteger(next, options.minDelayMs)
      i += 1
      continue
    }

    condition.push(part.replace(/^["']|["']$/g, ""))
  }

  return {
    condition: condition.join(" ").trim(),
    options,
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildLimitWarning(goal) {
  const remainingTurns = goal.options.maxTurns - goal.turnCount
  const remainingMs = goal.options.maxDurationMs - (Date.now() - goal.startedAt)
  const remainingTokens = goal.options.maxTokens - goal.totalTokens
  const warnings = []

  if (remainingTurns <= goal.options.warnTurnsRemaining) {
    warnings.push(`${remainingTurns} auto-continue turn(s) remaining`)
  }
  if (remainingMs <= goal.options.warnDurationMsRemaining) {
    warnings.push(`${Math.max(0, Math.round(remainingMs / 1000))}s remaining`)
  }
  if (remainingTokens <= goal.options.warnTokensRemaining) {
    warnings.push(`${Math.max(0, remainingTokens).toLocaleString()} tracked token(s) remaining`)
  }

  return warnings.length ? ` Limits are near: ${warnings.join(", ")}.` : ""
}

export const GoalPlugin = async ({ client }, pluginOptions = {}) => {
  const defaultGoalOptions = normalizeOptions(pluginOptions)

  return {
    "command.execute.before": async (input, output) => {
      if (input.command !== "goal") return

      const args = (input.arguments || "").trim()
      const sessionID = input.sessionID

      if (!args || args === "status") {
        const goal = goalStates.get(sessionID)
        output.parts = [
          makeTextPart(goal ? formatStatus(goal) : "No active goal. Set one with `/goal <condition>`."),
        ]
        return
      }

      if (args === "clear") {
        cleanupGoal(sessionID)
        output.parts = [makeTextPart("Goal cleared.")]
        return
      }

      const parsed = parseGoalArguments(args, defaultGoalOptions)
      if (!parsed.condition) {
        output.parts = [makeTextPart("No goal provided. Set one with `/goal <condition>`.")]
        return
      }

      const goal = {
        id: nextGoalID++,
        condition: parsed.condition,
        sessionID,
        turnCount: 0,
        startedAt: Date.now(),
        totalTokens: 0,
        options: parsed.options,
        lastStatus: "Goal set.",
        lastAssistantText: "",
        lastContinueAt: 0,
        messageIDs: new Set(),
      }

      cleanupGoal(sessionID)
      goalStates.set(sessionID, goal)
      output.parts = [
        makeTextPart(
          [
            `New active goal: ${goal.condition}`,
            "",
            "Start working toward this goal now.",
            "When the goal is fully satisfied, end your response with `[goal:complete]`.",
            "If you are truly blocked and need the user, end with `[goal:blocked]`.",
            "",
            `Limits: ${goal.options.maxTurns} auto-continues, ${Math.round(
              goal.options.maxDurationMs / 1000,
            )}s, ${goal.options.maxTokens.toLocaleString()} tracked tokens.`,
          ].join("\n"),
        ),
      ]
    },

    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const message = event.properties?.info
        if (!message) return

        const goal = goalStates.get(message.sessionID)
        if (!goal) return

        const currentTokens =
          (message.tokens?.input || 0) +
          (message.tokens?.output || 0) +
          (message.tokens?.reasoning || 0)
        const previousTokens = seenTokens.get(message.id) || 0
        if (currentTokens > previousTokens) {
          goal.totalTokens += currentTokens - previousTokens
          seenTokens.set(message.id, currentTokens)
          goal.messageIDs.add(message.id)
        }
        return
      }

      if (!isIdleEvent(event)) return

      const sessionID = getSessionID(event)
      const goal = goalStates.get(sessionID)
      if (!goal || activeContinues.has(sessionID)) return
      const goalID = goal.id

      activeContinues.add(sessionID)
      try {
        const messages = await client.session.messages({
          path: { id: sessionID },
          query: { limit: 12 },
        })
        const activeGoalAfterMessages = currentGoal(sessionID, goalID)
        if (!activeGoalAfterMessages) return

        const latestAssistant = [...(messages.data || [])]
          .reverse()
          .find((message) => message.info?.role === "assistant")
        const latestText = getText(latestAssistant?.parts)

        activeGoalAfterMessages.lastAssistantText = latestText

        if (goalIsComplete(latestText)) {
          cleanupGoal(sessionID)
          return
        }

        if (goalIsBlocked(latestText)) {
          activeGoalAfterMessages.lastStatus = "Assistant reported blocked."
          cleanupGoal(sessionID)
          return
        }

        const limitReason = stopReason(activeGoalAfterMessages)
        if (limitReason) {
          activeGoalAfterMessages.lastStatus = limitReason
          cleanupGoal(sessionID)
          return
        }

        const elapsedSinceLastContinue = Date.now() - activeGoalAfterMessages.lastContinueAt
        if (
          activeGoalAfterMessages.lastContinueAt &&
          elapsedSinceLastContinue < activeGoalAfterMessages.options.minDelayMs
        ) {
          await sleep(activeGoalAfterMessages.options.minDelayMs - elapsedSinceLastContinue)
        }

        const activeGoalBeforePrompt = currentGoal(sessionID, goalID)
        if (!activeGoalBeforePrompt) return

        activeGoalBeforePrompt.turnCount += 1
        activeGoalBeforePrompt.lastContinueAt = Date.now()
        activeGoalBeforePrompt.lastStatus = latestText
          ? `Continuing after assistant turn ${activeGoalBeforePrompt.turnCount}.`
          : `Continuing after idle event ${activeGoalBeforePrompt.turnCount}.`

        const response = await client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [
              makeTextPart(
                [
                  `Continue working toward the active goal: ${goal.condition}`,
                  "",
                  "Do the next concrete step. Do not ask for confirmation unless you are blocked.",
                  "End with `[goal:complete]` only when the goal is fully satisfied.",
                  "End with `[goal:blocked]` only if user input is required.",
                  buildLimitWarning(activeGoalBeforePrompt),
                ]
                  .filter(Boolean)
                  .join("\n"),
              ),
            ],
          },
        })

        if (response.error) {
          const activeGoalAfterPrompt = currentGoal(sessionID, goalID)
          const message = `Auto-continue failed: ${response.error.name || "unknown error"}`
          if (activeGoalAfterPrompt) activeGoalAfterPrompt.lastStatus = message
          console.error("[goal-plugin]", message, response.error)
        }
      } catch (error) {
        const activeGoalAfterError = currentGoal(sessionID, goalID)
        if (activeGoalAfterError) {
          activeGoalAfterError.lastStatus = `Auto-continue failed: ${error?.message || error}`
        }
        console.error("[goal-plugin]", error?.message || error)
      } finally {
        activeContinues.delete(sessionID)
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return

      const goal = goalStates.get(input.sessionID)
      if (!goal) return
      if (output.system.some((line) => line.startsWith("Active session goal:"))) return

      output.system.push(
        [
          `Active session goal: ${goal.condition}.`,
          "Keep working until the goal is fully satisfied.",
          "When fully satisfied, end the response with `[goal:complete]`.",
          "If user input is required, end the response with `[goal:blocked]`.",
          buildLimitWarning(goal),
        ].join(" "),
      )
    },
  }
}

export default {
  id: "opencode-goal-plugin",
  server: GoalPlugin,
}

export const testInternals = {
  buildLimitWarning,
  cleanupGoal,
  currentGoal,
  formatStatus,
  getSessionID,
  goalIsBlocked,
  goalIsComplete,
  isIdleEvent,
  normalizeOptions,
  parseGoalArguments,
  stopReason,
}
