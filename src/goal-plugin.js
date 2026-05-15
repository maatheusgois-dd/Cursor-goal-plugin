const DEFAULT_MAX_TURNS = 10
const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1000
const DEFAULT_MAX_TOKENS = 200000

const goalStates = new Map()
const seenTokens = new Map()
const activeContinues = new Set()

function getText(parts) {
  return (parts || [])
    .filter((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text || "")
    .join("\n")
    .trim()
}

function makeTextPart(text) {
  return { type: "text", text }
}

function getSessionID(event) {
  return event?.properties?.sessionID || event?.properties?.info?.sessionID || event?.sessionID || null
}

function formatStatus(goal) {
  const elapsed = Math.round((Date.now() - goal.startedAt) / 1000)
  return [
    `Active goal: ${goal.condition}`,
    `Turns: ${goal.turnCount}/${goal.maxTurns}`,
    `Tokens: ${goal.totalTokens.toLocaleString()}/${goal.maxTokens.toLocaleString()}`,
    `Elapsed: ${elapsed}s/${Math.round(goal.maxDurationMs / 1000)}s`,
    `Last status: ${goal.lastStatus || "No assistant turn recorded yet."}`,
  ].join("\n")
}

function goalIsComplete(text) {
  return /\[goal:complete\]/i.test(text) || /\bgoal complete\b/i.test(text)
}

function goalIsBlocked(text) {
  return /\[goal:blocked\]/i.test(text) || /\bgoal blocked\b/i.test(text)
}

function stopReason(goal) {
  if (goal.turnCount >= goal.maxTurns) return `max turns reached (${goal.maxTurns})`
  if (Date.now() - goal.startedAt >= goal.maxDurationMs) {
    return `max duration reached (${Math.round(goal.maxDurationMs / 1000)}s)`
  }
  if (goal.totalTokens >= goal.maxTokens) return `max tokens reached (${goal.maxTokens})`
  return null
}

export const GoalPlugin = async ({ client }) => {
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
        goalStates.delete(sessionID)
        activeContinues.delete(sessionID)
        output.parts = [makeTextPart("Goal cleared.")]
        return
      }

      const goal = {
        condition: args,
        sessionID,
        turnCount: 0,
        startedAt: Date.now(),
        totalTokens: 0,
        maxTurns: DEFAULT_MAX_TURNS,
        maxDurationMs: DEFAULT_MAX_DURATION_MS,
        maxTokens: DEFAULT_MAX_TOKENS,
        lastStatus: "Goal set.",
        lastAssistantText: "",
      }

      goalStates.set(sessionID, goal)
      output.parts = [
        makeTextPart(
          [
            `New active goal: ${args}`,
            "",
            "Start working toward this goal now.",
            "When the goal is fully satisfied, end your response with `[goal:complete]`.",
            "If you are truly blocked and need the user, end with `[goal:blocked]`.",
          ].join("\n"),
        ),
      ]
    },

    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const message = event.properties?.info
        if (!message || message.role !== "assistant") return

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
        }
        return
      }

      if (event.type !== "session.idle") return

      const sessionID = getSessionID(event)
      const goal = goalStates.get(sessionID)
      if (!goal || activeContinues.has(sessionID)) return

      activeContinues.add(sessionID)
      try {
        const messages = await client.session.messages({
          path: { id: sessionID },
          query: { limit: 12 },
        })
        const latestAssistant = [...(messages.data || [])]
          .reverse()
          .find((message) => message.info?.role === "assistant")
        const latestText = getText(latestAssistant?.parts)

        goal.lastAssistantText = latestText

        if (goalIsComplete(latestText)) {
          goalStates.delete(sessionID)
          return
        }

        if (goalIsBlocked(latestText)) {
          goal.lastStatus = "Assistant reported blocked."
          goalStates.delete(sessionID)
          return
        }

        const limitReason = stopReason(goal)
        if (limitReason) {
          goal.lastStatus = limitReason
          goalStates.delete(sessionID)
          return
        }

        goal.turnCount += 1
        goal.lastStatus = latestText
          ? `Continuing after assistant turn ${goal.turnCount}.`
          : `Continuing after idle event ${goal.turnCount}.`

        await client.session.promptAsync({
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
                ].join("\n"),
              ),
            ],
          },
        })
      } catch (error) {
        console.error("[goal-plugin]", error?.message || error)
      } finally {
        activeContinues.delete(sessionID)
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return

      const goal = goalStates.get(input.sessionID)
      if (!goal) return

      const nearLimit =
        goal.turnCount >= goal.maxTurns - 3
          ? ` You are near the goal turn limit (${goal.turnCount}/${goal.maxTurns}); finish decisively.`
          : ""

      output.system.push(
        [
          `Active session goal: ${goal.condition}.`,
          "Keep working until the goal is fully satisfied.",
          "When fully satisfied, end the response with `[goal:complete]`.",
          "If user input is required, end the response with `[goal:blocked]`.",
          nearLimit,
        ].join(" "),
      )
    },
  }
}

export default GoalPlugin
