import assert from "node:assert/strict"
import test from "node:test"
import { parseModel, projectRootFor, replyFrom, turnOutcome, type Message } from "../src/api.ts"

const assistant = (at: number, parts: Message["content"], extra: Partial<Message> = {}): Message => ({
  id: `msg_${at}`,
  type: "assistant",
  time: { created: at, completed: at },
  content: parts,
  finish: "stop",
  ...extra,
})

test("returns the newest assistant text and ignores reasoning parts", () => {
  const messages: Message[] = [
    assistant(200, [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "second" },
    ]),
    assistant(100, [{ type: "text", text: "first" }]),
  ]
  const reply = replyFrom(messages)
  assert.equal(reply?.text, "second")
  assert.equal(reply?.at, 200)
})

test("joins several text parts", () => {
  const reply = replyFrom([assistant(1, [{ type: "text", text: "a" }, { type: "text", text: "b" }])])
  assert.equal(reply?.text, "a\n\nb")
})

test("ignores replies from before the prompt was sent", () => {
  const messages: Message[] = [assistant(100, [{ type: "text", text: "old" }])]
  assert.equal(replyFrom(messages, 150), undefined)
})

test("carries the remote error message", () => {
  const reply = replyFrom([
    assistant(5, [], { finish: "error", error: { type: "provider.auth", message: "Model access is disabled" } }),
  ])
  assert.equal(reply?.error, "Model access is disabled")
  assert.equal(reply?.text, "")
})

test("reads the outcome from the newest idle marker", () => {
  const messages: Message[] = [
    { id: "idle-2", type: "idle", time: { created: 30 }, outcome: "failed", error: { message: "boom" } },
    { id: "idle-1", type: "idle", time: { created: 10 }, outcome: "succeeded" },
  ]
  assert.deepEqual(turnOutcome(messages), { outcome: "failed", error: "boom" })
})

test("parses provider/model and rejects a bare name", () => {
  assert.deepEqual(parseModel("opencode-go/deepseek-v4.1-flash"), {
    providerID: "opencode-go",
    id: "deepseek-v4.1-flash",
  })
  assert.equal(parseModel(undefined), undefined)
  assert.throws(() => parseModel("deepseek"), /provider\/model/)
})

test("finds the project that contains a directory", () => {
  const roots = ["/srv/app", "/srv/app/docs", "/home/you/work"]
  assert.equal(projectRootFor("/srv/app", roots), "/srv/app")
  assert.equal(projectRootFor("/srv/app/src/lib", roots), "/srv/app")
  assert.equal(projectRootFor("/srv/app/docs", roots), "/srv/app/docs")
  assert.equal(projectRootFor("/srv/app/docs/img/a.png", roots), "/srv/app/docs")
})

test("keeps a directory that belongs to no project, and handles trailing slashes", () => {
  assert.equal(projectRootFor("/tmp/scratch", ["/srv/app"]), "/tmp/scratch")
  assert.equal(projectRootFor("/srv/app/", ["/srv/app/"]), "/srv/app")
  assert.equal(projectRootFor("/srv/application", ["/srv/app"]), "/srv/application")
})
