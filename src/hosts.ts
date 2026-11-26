import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/** An OpenChamber instance this machine may talk to. */
export type Host = {
  id: string
  label: string
  /** Base URL of the instance's HTTP API, or null when only the relay is configured. */
  apiUrl: string | null
  /** Client token paired by OpenChamber, or null when the entry has none. */
  token: string | null
  /** Why the entry cannot be used, when it cannot. */
  reason?: string
}

export const configDir = () => join(homedir(), ".config", "openchamber")

const readJson = async (path: string): Promise<any> => {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return undefined
  }
}

const httpUrl = (value: unknown): string | null =>
  typeof value === "string" && /^https?:\/\//i.test(value) ? value.replace(/\/+$/, "") : null

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null

/** Build the host list from the desktop settings and the optional extra file. */
export function hostsFrom(settings: any, extra: any): Host[] {
  const byId = new Map<string, Host>()

  const add = (entry: any) => {
    const id = text(entry?.id) ?? text(entry?.label)
    if (!id) return
    const apiUrl = httpUrl(entry?.apiUrl) ?? httpUrl(entry?.url)
    const token = text(entry?.clientToken) ?? text(entry?.token)
    const reason = !apiUrl
      ? "relay-only; the relay speaks an encrypted WebSocket, not HTTP"
      : !token
        ? "no client token; pair a device with this instance in OpenChamber"
        : undefined
    byId.set(id, {
      id,
      label: text(entry?.label) ?? id,
      apiUrl,
      token,
      reason,
    })
  }

  for (const entry of Array.isArray(settings?.desktopHosts) ? settings.desktopHosts : []) add(entry)
  for (const entry of Array.isArray(extra?.hosts) ? extra.hosts : []) add(entry)

  return [...byId.values()]
}

/**
 * Hosts come from the OpenChamber desktop settings (the same saved instances the
 * app shows) plus an optional `remote-hosts.json` beside them for machines that
 * have no OpenChamber install of their own.
 */
export async function loadHosts(): Promise<Host[]> {
  return hostsFrom(
    await readJson(join(configDir(), "settings.json")),
    await readJson(join(configDir(), "remote-hosts.json")),
  )
}

/** Find one host by id or label and make sure it can actually be reached. */
export async function resolveHost(name: string): Promise<Host> {
  const hosts = await loadHosts()
  const wanted = name.trim().toLowerCase()
  const host =
    hosts.find((entry) => entry.id.toLowerCase() === wanted) ??
    hosts.find((entry) => entry.label.toLowerCase() === wanted)
  if (!host) {
    throw new Error(
      `Unknown host "${name}". Known hosts: ${hosts.map((entry) => entry.id).join(", ") || "none"}.`,
    )
  }
  if (!host.apiUrl) throw new Error(`Host "${host.label}" cannot be reached: ${host.reason}.`)
  if (!host.token) throw new Error(`Host "${host.label}" cannot be reached: ${host.reason}.`)
  return host
}
