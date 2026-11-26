import type { Host } from "./hosts.ts"

const TIMEOUT_MS = 20_000

export type ModelRef = { providerID: string; id: string }

export type Session = {
  id: string
  title?: string
  projectID?: string
  model?: ModelRef & { variant?: string }
  outcome?: string
  location?: { directory?: string }
  time?: { created?: number; updated?: number; busy?: number; idle?: number }
}

export type Message = {
  id: string
  type: string
  time?: { created?: number; completed?: number }
  content?: { type: string; text?: string }[]
  finish?: string
  outcome?: string
  text?: string
  agent?: string
  model?: ModelRef
  error?: { type?: string; message?: string }
}

export type Reply = {
  text: string
  error?: string
  finish?: string
  agent?: string
  model?: string
  at: number
}

const unwrap = (value: any): any[] => (Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [])
const unwrapOne = (value: any): any => (value?.data && !Array.isArray(value.data) ? value.data : value)

/** Session routes are scoped by the project directory the session lives in. */
const at = (path: string, directory?: string | null) =>
  directory ? `${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}` : path

const abort = (outer: AbortSignal | undefined, timeoutMs: number) =>
  outer ? AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)

export const isTimeout = (error: unknown) =>
  (error as any)?.name === "TimeoutError" || (error as any)?.name === "AbortError"

async function call<T = any>(
  host: Host,
  method: string,
  path: string,
  body?: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  let response: Response
  try {
    response = await fetch(`${host.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${host.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abort(options.signal, timeoutMs),
    })
  } catch (error) {
    if (isTimeout(error)) throw new Error(`${host.label}: no answer within ${Math.round(timeoutMs / 1000)}s.`)
    const code = (error as any)?.cause?.code ?? (error as any)?.code
    throw new Error(`${host.label}: cannot reach ${host.apiUrl}${code ? ` (${code})` : ""}.`)
  }

  if (response.status === 204) return undefined as T

  const raw = await response.text()
  let payload: any
  try {
    payload = raw ? JSON.parse(raw) : undefined
  } catch {
    payload = raw
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `${host.label}: the client token was rejected (${response.status}). Re-pair this instance in OpenChamber, or update its token in remote-hosts.json.`,
      )
    }
    const detail = typeof payload === "string" ? payload : payload?.error?.message ?? payload?.error ?? raw
    throw new Error(`${host.label}: ${method} ${path} failed with ${response.status}${detail ? `: ${String(detail).slice(0, 400)}` : ""}`)
  }

  return payload as T
}

export async function listProjects(host: Host, signal?: AbortSignal): Promise<{ id: string; canonical?: string; time?: { updated?: number; active?: number } }[]> {
  return unwrap(await call(host, "GET", "/api/project", undefined, { signal, timeoutMs: 8_000 }))
}

export async function listSessions(host: Host, signal?: AbortSignal): Promise<Session[]> {
  return unwrap(await call(host, "GET", "/api/session", undefined, { signal }))
}

export async function getSession(host: Host, sessionID: string, directory?: string | null, signal?: AbortSignal): Promise<Session> {
  return unwrapOne(await call(host, "GET", at(`/api/session/${encodeURIComponent(sessionID)}`, directory), undefined, { signal }))
}

export async function createSession(
  host: Host,
  input: { title: string; directory: string; model?: ModelRef },
  signal?: AbortSignal,
): Promise<Session> {
  return unwrapOne(
    await call(
      host,
      "POST",
      at("/api/session", input.directory),
      { title: input.title, location: { directory: input.directory }, ...(input.model ? { model: input.model } : {}) },
      { signal },
    ),
  )
}

export async function prompt(
  host: Host,
  sessionID: string,
  text: string,
  directory?: string | null,
  signal?: AbortSignal,
): Promise<void> {
  await call(host, "POST", at(`/api/session/${encodeURIComponent(sessionID)}/prompt`, directory), { text }, { signal })
}

/** Blocks on the instance until the session stops working on the current turn. */
export async function waitForTurn(
  host: Host,
  sessionID: string,
  directory: string | null | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await call(host, "POST", at(`/api/experimental/session/${encodeURIComponent(sessionID)}/wait`, directory), {}, { signal, timeoutMs })
}

export async function listMessages(
  host: Host,
  sessionID: string,
  directory?: string | null,
  limit = 20,
  signal?: AbortSignal,
): Promise<Message[]> {
  const path = at(`/api/session/${encodeURIComponent(sessionID)}/message?limit=${limit}&order=desc`, directory)
  return unwrap(await call(host, "GET", path, undefined, { signal }))
}

export async function listPermissions(
  host: Host,
  sessionID: string,
  directory?: string | null,
  signal?: AbortSignal,
): Promise<any[]> {
  return unwrap(await call(host, "GET", at(`/api/session/${encodeURIComponent(sessionID)}/permission`, directory), undefined, { signal }))
}

export type ExecResult = {
  command: string
  success: boolean
  exitCode?: number
  stdout?: string
  stderr?: string
}

/** The project a path belongs to: the longest configured root that contains it. */
export function projectRootFor(cwd: string, roots: string[]): string {
  const clean = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const target = clean(cwd)
  return (
    roots
      .map(clean)
      .filter((root) => root && (target === root || target.startsWith(`${root}/`)))
      .sort((a, b) => b.length - a.length)[0] ?? cwd
  )
}

/**
 * Runs one command on the instance. The API only accepts a cwd inside a known
 * project, so the project that contains cwd becomes the request's workspace.
 */
export async function exec(
  host: Host,
  input: { command: string; cwd: string },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ success: boolean; results: ExecResult[] }> {
  const projects = await listProjects(host, signal).catch(() => [])
  const roots = projects.map((project) => project.canonical ?? project.id).filter((path): path is string => Boolean(path))
  const root = projectRootFor(input.cwd, roots)
  const payload = await call<{ success?: boolean; results?: ExecResult[] }>(
    host,
    "POST",
    at("/api/fs/exec", root),
    { commands: [input.command], cwd: input.cwd },
    { signal, timeoutMs },
  )
  return {
    success: payload?.success === true,
    results: Array.isArray(payload?.results) ? payload.results : [],
  }
}

/** `busy` is a timestamp, so a session is only working while it is newer than `idle`. */
export const isBusy = (session: Session | undefined) =>
  (session?.time?.busy ?? 0) > (session?.time?.idle ?? 0)

/** The newest assistant message at or after `since`, as the remote agent left it. */
export function replyFrom(messages: Message[], since = 0): Reply | undefined {
  const newest = messages
    .filter((message) => message.type === "assistant")
    .filter((message) => (message.time?.completed ?? message.time?.created ?? 0) >= since)
    .sort((a, b) => (b.time?.completed ?? b.time?.created ?? 0) - (a.time?.completed ?? a.time?.created ?? 0))[0]
  if (!newest) return undefined
  const text = (newest.content ?? [])
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text!.trim())
    .join("\n\n")
  return {
    text,
    error: newest.error?.message,
    finish: newest.finish,
    agent: newest.agent,
    model: newest.model ? `${newest.model.providerID}/${newest.model.id}` : undefined,
    at: newest.time?.completed ?? newest.time?.created ?? 0,
  }
}

/** How the turn ended, from the idle marker the instance writes after each turn. */
export function turnOutcome(messages: Message[]): { outcome?: string; error?: string } {
  const idle = messages.filter((message) => message.type === "idle").sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))[0]
  return { outcome: idle?.outcome, error: idle?.error?.message }
}

export function parseModel(value: string | undefined): ModelRef | undefined {
  if (!value) return undefined
  const slash = value.indexOf("/")
  if (slash < 1) throw new Error(`model must look like "provider/model", got "${value}".`)
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
}
