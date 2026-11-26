/**
 * Loads the plugin the way OpenCode does, but with a fake tool editor, then calls
 * the read-only tools against the hosts on this machine.
 *
 *   npm run smoke            # hosts + sessions
 *   npm run smoke -- vps     # narrow to one host id
 *
 * Not part of `npm test`: it needs real hosts and the network.
 */
import plugin from "../src/index.ts"

const only = process.argv[2]
const tools = new Map<string, any>()

const editor = {
  namespace() {},
  add(tool: any) {
    tools.set(tool.name, tool)
  },
  list: () => [],
  get: () => undefined,
  update() {},
  remove() {},
}

await (plugin as any).setup({
  tool: {
    transform: async (callback: (editor: any) => void) => {
      callback(editor)
      return { dispose() {} }
    },
  },
})

const run = async (name: string, input: Record<string, unknown>) => {
  const tool = tools.get(name)
  if (!tool) throw new Error(`tool ${name} was not registered`)
  console.log(`\n=== remote_${name} ${JSON.stringify(input)}`)
  const result = await tool.execute(input, { signal: AbortSignal.timeout(30_000), progress: async () => {} })
  console.log(result.content)
}

await run("hosts", {})

if (only) {
  await run("sessions", { host: only, limit: 5 })
} else {
  const listed = await tools.get("hosts")!.execute({}, { signal: AbortSignal.timeout(30_000), progress: async () => {} })
  const ids = [...String(listed.content).matchAll(/^(\S+) \([^)]*\) — http/gm)].map((match) => match[1])
  for (const id of ids) await run("sessions", { host: id, limit: 3 })
}
