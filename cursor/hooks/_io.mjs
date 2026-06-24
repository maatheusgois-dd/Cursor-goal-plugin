// Shared stdin/stdout plumbing for Cursor hook scripts.
// Cursor invokes each hook as a process, passes a JSON payload on stdin, and
// reads a JSON object from stdout. Exit 0 = use stdout; other codes fail-open.

export async function readInput() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString("utf8").trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function sessionIdOf(input) {
  return input.conversation_id || input.session_id || input.sessionId || "default"
}

export function rootOf(input) {
  const roots = input.workspace_roots
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) return roots[0]
  return process.cwd()
}

export function emit(output) {
  process.stdout.write(JSON.stringify(output ?? {}))
}

// Hooks must never crash the agent: log to stderr and exit 0 (fail-open).
export function run(main) {
  main().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`[goal-hook] ${error?.stack || error}\n`)
      process.exit(0)
    },
  )
}
