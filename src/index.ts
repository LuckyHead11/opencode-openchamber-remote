import { Plugin } from "@opencode/plugin"
import * as api from "./api.ts"
import { loadHosts, resolveHost, type Host } from "./hosts.ts"

const MAX_PROMPT = 20_000
const MAX_REPLY = 8_000
const DEFAULT_WAIT_SECONDS = 300

const clip = (value: string, max = MAX_REPLY) =>
  value.length > max ? `${value.slice(0, max)}\n\n[truncated ${value.length - max} characters]` : value

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const ago = (time?: number) => {
  if (!time) return "unknown"
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

const heading = (host: Host) => `${host.label} (${host.id})`

const directoryOf = (session: api.Session) => session.location?.directory ?? null

async function describeHosts(signal?: AbortSignal): Promise<string> {
  const hosts = await loadHosts()
  if (!hosts.length) {
    return "No instances configured. OpenChamber saves them in ~/.config/openchamber/settings.json; add any others to ~/.config/openchamber/remote-hosts.json."
  }
  const lines = await Promise.all(
    hosts.map(async (host) => {
      if (!host.apiUrl || !host.token) return `${host.id} (${host.label}) — unusable: ${host.reason}`
      try {
        const projects = await api.listProjects(host, signal)
        // shortcut: OpenChamber makes a project per chat directory, which buries the real ones; list them only if nothing else is left
        const paths = [
          ...new Set(
            projects
              .slice()
              .sort((a, b) => (b.time?.active ?? b.time?.updated ?? 0) - (a.time?.active ?? a.time?.updated ?? 0))
              .map((project) => project.canonical ?? project.id)
              .filter((path): path is string => Boolean(path)),
          ),
        ]
        const real = paths.filter((path) => !path.includes("/.config/openchamber/chats/"))
        const usable = real.length ? real : paths
        const shown = usable.slice(0, 8)
        const more = usable.length - shown.length
        return [
          `${host.id} (${host.label}) — ${host.apiUrl}`,
          `  projects: ${shown.join(", ") || "none"}${more > 0 ? ` (+${more} more)` : ""}`,
        ].join("\n")
      } catch (error) {
        return `${host.id} (${host.label}) — ${message(error)}`
      }
    }),
  )
  return lines.join("\n")
}

async function describeSessions(host: Host, query: string | undefined, limit: number, signal?: AbortSignal): Promise<string> {
  const sessions = await api.listSessions(host, signal)
  const needle = query?.trim().toLowerCase()
  const matched = sessions
    .filter((session) => {
      if (!needle) return true
      return `${session.title ?? ""} ${directoryOf(session) ?? ""} ${session.id}`.toLowerCase().includes(needle)
    })
    .sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))
    .slice(0, limit)
  if (!matched.length) return `No sessions${needle ? ` matching "${query}"` : ""} on ${heading(host)}.`
  const rows = matched.map((session) => {
    const state = api.isBusy(session) ? "busy" : (session.outcome ?? "idle")
    return [
      session.id,
      state.padEnd(7),
      ago(session.time?.updated ?? session.time?.created),
      directoryOf(session) ?? "?",
      session.title ?? "(untitled)",
    ].join("  ")
  })
  return [`${heading(host)} — ${sessions.length} sessions, showing ${matched.length}`, ...rows].join("\n")
}

async function send(
  host: Host,
  input: { text: string; sessionId?: string; directory?: string; title?: string; model?: string; wait: boolean; timeoutMs: number },
  signal?: AbortSignal,
): Promise<string> {
  let session: api.Session
  if (input.sessionId) {
    session = await api.getSession(host, input.sessionId, input.directory, signal)
    if (!session?.id) throw new Error(`Session ${input.sessionId} was not found on ${heading(host)}.`)
  } else {
    if (!input.directory) {
      throw new Error("Pass directory (the project path on the remote instance) to start a new session, or sessionId to continue one.")
    }
    session = await api.createSession(
      host,
      {
        title: input.title ?? input.text.slice(0, 60).replace(/\s+/g, " ").trim(),
        directory: input.directory,
        model: api.parseModel(input.model),
      },
      signal,
    )
  }

  const directory = directoryOf(session) ?? input.directory ?? null
  const sentAt = Date.now()
  await api.prompt(host, session.id, input.text, directory, signal)

  const queued = `Queued on ${heading(host)} · ${session.id}${input.title ? ` · ${input.title}` : ""}. Check it with remote_check.`
  if (!input.wait) return queued

  const deadline = sentAt + input.timeoutMs
  let reply: api.Reply | undefined
  let messages: api.Message[] = []

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    try {
      await api.waitForTurn(host, session.id, directory, remaining, signal)
    } catch (error) {
      if (!api.isTimeout(error)) throw error
    }
    messages = await api.listMessages(host, session.id, directory, 10, signal)
    reply = api.replyFrom(messages, sentAt)
    if (reply) break
    const current = await api.getSession(host, session.id, directory, signal)
    if (!api.isBusy(current)) {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      messages = await api.listMessages(host, session.id, directory, 10, signal)
      reply = api.replyFrom(messages, sentAt)
      break
    }
  }

  if (!reply) {
    const permissions = await api.listPermissions(host, session.id, directory, signal).catch(() => [])
    const stuck = permissions.length
      ? ` It is waiting on ${permissions.length} approval request${permissions.length === 1 ? "" : "s"} on that machine.`
      : ""
    return `Still running on ${heading(host)} after ${Math.round(input.timeoutMs / 1000)}s. Session ${session.id}.${stuck} Ask remote_check for the result.`
  }

  const meta = [session.id, reply.agent, reply.model, `${((reply.at || Date.now()) - sentAt) / 1000}s`]
    .filter(Boolean)
    .join(" · ")

  if (reply.error) {
    return [
      `${heading(host)} · ${meta}`,
      `The remote turn failed: ${reply.error}`,
      `Retry with model "provider/model" (for example opencode-go/deepseek-v4.1-flash), or fix the model on that instance.`,
    ].join("\n")
  }

  if (!reply.text) {
    const outcome = api.turnOutcome(messages)
    return [
      `${heading(host)} · ${meta}`,
      `The remote turn ended (${reply.finish ?? outcome.outcome ?? "no text"}) without a reply.`,
      outcome.error ? `Error: ${outcome.error}` : `Session ${session.id}.`,
    ].join("\n")
  }

  return [`${heading(host)} · ${meta}`, "", clip(reply.text)].join("\n")
}

/** The most recently used project on the instance, used when no cwd is given. */
async function defaultCwd(host: Host, signal?: AbortSignal): Promise<string> {
  const projects = await api.listProjects(host, signal)
  const newest = projects
    .slice()
    .sort((a, b) => (b.time?.active ?? b.time?.updated ?? 0) - (a.time?.active ?? a.time?.updated ?? 0))[0]
  const directory = newest?.canonical ?? newest?.id
  if (!directory) throw new Error(`${heading(host)} has no project directories; pass cwd.`)
  return directory
}

async function check(host: Host, sessionId: string, signal?: AbortSignal): Promise<string> {
  const session = await api.getSession(host, sessionId, undefined, signal)
  if (!session?.id) throw new Error(`Session ${sessionId} was not found on ${heading(host)}.`)
  const directory = directoryOf(session)
  const messages = await api.listMessages(host, sessionId, directory, 20, signal)
  const reply = api.replyFrom(messages)
  const outcome = api.turnOutcome(messages)
  const permissions = await api.listPermissions(host, sessionId, directory, signal).catch(() => [])

  const state = api.isBusy(session) ? "working" : (outcome.outcome ?? "idle")
  const lines = [
    `${heading(host)} · ${session.id} · ${session.title ?? "(untitled)"}`,
    `state: ${state} · updated ${ago(session.time?.updated ?? session.time?.created)} · ${directory ?? "unknown directory"}`,
  ]
  if (session.model) lines.push(`model: ${session.model.providerID}/${session.model.id}`)
  if (permissions.length) {
    const ids = permissions.map((entry) => entry?.id ?? entry?.requestID).filter(Boolean).slice(0, 3)
    lines.push(`waiting on ${permissions.length} approval request${permissions.length === 1 ? "" : "s"}${ids.length ? ` (${ids.join(", ")})` : ""}`)
  }
  if (reply?.error) lines.push(`last turn failed: ${reply.error}`)
  if (reply?.text) lines.push("", "last reply:", clip(reply.text, 4_000))
  else if (!api.isBusy(session)) lines.push("", "no reply yet.")
  return lines.join("\n")
}

export default Plugin.define({
  id: "openchamber-remote",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "remote",
        description: "Reach the user's other OpenChamber instances: list them, find sessions, send work, read results.",
      })

      editor.add({
        name: "hosts",
        description:
          "List the OpenChamber instances this machine can reach, with each one's project directories. Call this first when the user mentions another machine, server or instance, such as their VPS.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "remote" },
        execute: async (_input, context) => ({ content: await describeHosts(context.signal) }),
      })

      editor.add({
        name: "sessions",
        description:
          "List recent sessions on a remote OpenChamber instance, newest first, optionally filtered by text in the title, path or id. Use it to find the session a task belongs to before sending anything.",
        input: {
          type: "object",
          properties: {
            host: { type: "string", description: "Instance id or label, as shown by remote_hosts." },
            query: { type: "string", description: "Optional text to match against title, directory or session id." },
            limit: { type: "number", description: "How many sessions to show. Default 20." },
          },
          required: ["host"],
          additionalProperties: false,
        },
        options: { namespace: "remote" },
        execute: async (input, context) => {
          const args = input as { host: string; query?: string; limit?: number }
          const host = await resolveHost(args.host)
          return { content: await describeSessions(host, args.query, Math.min(Math.max(args.limit ?? 20, 1), 100), context.signal) }
        },
      })

      editor.add({
        name: "send",
        description:
          "Send a task to a remote OpenChamber instance: continue an existing session (sessionId) or start a new one (directory). Waits for that machine's agent to finish and returns what it said. The work runs there, with that instance's own tools, model and permissions.",
        input: {
          type: "object",
          properties: {
            host: { type: "string", description: "Instance id or label, as shown by remote_hosts." },
            text: { type: "string", description: "The task or message for the remote agent." },
            sessionId: { type: "string", description: "Existing session to continue. Omit to start a new session." },
            directory: { type: "string", description: "Project path on the remote instance. Required when starting a new session; also used to locate an existing one." },
            title: { type: "string", description: "Title for a new session. Defaults to the start of text." },
            model: { type: "string", description: "Model as provider/model, for a new session. Defaults to the instance's default model." },
            wait: { type: "boolean", description: "Wait for the turn to finish and return its reply. Default true." },
            timeoutSec: { type: "number", description: "How long to wait when wait is true. Default 300." },
          },
          required: ["host", "text"],
          additionalProperties: false,
        },
        options: { namespace: "remote" },
        execute: async (input, context) => {
          const args = input as {
            host: string
            text: string
            sessionId?: string
            directory?: string
            title?: string
            model?: string
            wait?: boolean
            timeoutSec?: number
          }
          if (!args.text?.trim()) throw new Error("text is empty.")
          if (args.text.length > MAX_PROMPT) throw new Error(`text is ${args.text.length} characters; the limit is ${MAX_PROMPT}.`)
          const host = await resolveHost(args.host)
          const seconds = Math.min(Math.max(args.timeoutSec ?? DEFAULT_WAIT_SECONDS, 5), 3_600)
          return {
            content: await send(
              host,
              {
                text: args.text,
                sessionId: args.sessionId,
                directory: args.directory,
                title: args.title,
                model: args.model,
                wait: args.wait !== false,
                timeoutMs: seconds * 1_000,
              },
              context.signal,
            ),
          }
        },
      })

      editor.add({
        name: "check",
        description:
          "Check a remote session: whether it is still working, what its agent last said, and whether it is blocked on an approval. Use after remote_send with wait false, or when a send timed out.",
        input: {
          type: "object",
          properties: {
            host: { type: "string", description: "Instance id or label, as shown by remote_hosts." },
            sessionId: { type: "string", description: "Session to inspect." },
          },
          required: ["host", "sessionId"],
          additionalProperties: false,
        },
        options: { namespace: "remote" },
        execute: async (input, context) => {
          const args = input as { host: string; sessionId: string }
          const host = await resolveHost(args.host)
          return { content: await check(host, args.sessionId, context.signal) }
        },
      })

      editor.add({
        name: "exec",
        description:
          "Run one shell command on a remote OpenChamber instance and return its exit code, stdout and stderr. It is a real command on that machine, run as that instance's user, and it goes through your bash permission rules. Use it for a quick, specific command; use remote_send when you want that machine's agent to think about something.",
        input: {
          type: "object",
          properties: {
            host: { type: "string", description: "Instance id or label, as shown by remote_hosts." },
            command: { type: "string", description: "The command, run with the instance's shell." },
            cwd: {
              type: "string",
              description:
                "Directory on the remote instance. Must be one of its projects or inside one. Defaults to its most recently used project.",
            },
            timeoutSec: { type: "number", description: "How long to wait for the command. Default 60, max 600." },
          },
          required: ["host", "command"],
          additionalProperties: false,
        },
        options: { namespace: "remote" },
        execute: async (input, context) => {
          const args = input as { host: string; command: string; cwd?: string; timeoutSec?: number }
          if (!args.command?.trim()) throw new Error("command is empty.")
          const host = await resolveHost(args.host)
          const cwd = args.cwd?.trim() || (await defaultCwd(host, context.signal))

          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "bash",
            resources: [args.command],
            source: { type: "tool", messageID: context.messageID, id: context.id },
          })

          const seconds = Math.min(Math.max(args.timeoutSec ?? 60, 1), 600)
          const started = Date.now()
          const result = await api.exec(host, { command: args.command, cwd }, seconds * 1_000, context.signal)
          const first = result.results[0]
          const code = first?.exitCode ?? (result.success ? 0 : "?")
          const head = `${heading(host)} · ${cwd} · exit ${code} · ${((Date.now() - started) / 1_000).toFixed(1)}s`
          const body = [first?.stdout?.trimEnd(), first?.stderr?.trim() ? `stderr:\n${first.stderr.trimEnd()}` : ""]
            .filter(Boolean)
            .join("\n\n")
          if (!first && !result.success) throw new Error(`${heading(host)} ran nothing; the command was rejected.`)
          return { content: body ? `${head}\n\n${clip(body)}` : `${head}\n\n(no output)` }
        },
      })
    })
  },
})
