import test from "node:test"
import assert from "node:assert/strict"
import { register } from "node:module"

// OpenCode v2 event vocabulary (packages/schema/src/session-event.ts):
// session.execution.*, session.retry.scheduled, session.model.selected —
// all framed as { id, type, created, data, durable? } on the SSE stream.
register("./fixtures/plugin-loader.js", import.meta.url)
const { default: plugin } = await import("../index.ts")
const flush = () => new Promise((resolve) => setImmediate(resolve))

async function setup(t, list = [{ id: "s1", model: { providerID: "provider", id: "a" } }]) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  let stream
  let connected
  const connection = new Promise((resolve) => { connected = resolve })
  const body = new ReadableStream({ start(controller) { stream = controller } })
  t.mock.method(globalThis, "fetch", async (url, { signal }) => {
    assert.equal(url, "http://opencode.test/api/event")
    signal.addEventListener("abort", () => stream.error(new Error("fixture aborted")), { once: true })
    connected()
    return { ok: true, status: 200, body }
  })

  const models = new Map([
    ["provider/a", { providerID: "provider", id: "a", name: "A" }],
    ["provider/b", { providerID: "provider", id: "b", name: "B" }],
    ["other/b", { providerID: "other", id: "b", name: "Other B" }],
  ])
  let transform
  const ctx = {
    session: { list: async () => ({ data: list }) },
    model: {
      transform: async (fn) => { transform = fn },
      reload: async () => transform({
        list: () => [...models.values()],
        update: (provider, id, edit) => edit(models.get(`${provider}/${id}`)),
      }),
    },
  }
  const dispose = await plugin.setup(ctx)
  t.after(async () => { dispose(); await flush() })
  await connection
  await flush()
  const tick = async (ms) => { t.mock.timers.tick(ms); await flush() }
  const emit = async (type, data, extra = {}) => {
    // v2 wire frame: id, type, created, data (+ durable envelope, ignored).
    const frame = { id: "evt_" + Math.random().toString(16).slice(2), type, created: Date.now(), data, ...extra }
    stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`))
    await flush()
  }
  await tick(500)
  const name = (key) => models.get(key).name
  return { models, emit, tick, name }
}

test("v2 execution lifecycle paints running and failure without any back-off earns no ✕", async (t) => {
  const h = await setup(t)
  await h.emit("session.execution.started", { sessionID: "s1" })
  await h.tick(500)
  assert.equal(h.name("provider/a"), "A ●")
  // a plain failure (no rate limit in the chain, #10) must NOT exhaust the model
  await h.emit("session.execution.failed", { sessionID: "s1", error: { kind: "provider_error" } })
  await h.tick(500)
  assert.equal(h.name("provider/a"), "A")
})

test("v2 retry back-off shows ↻ and a chain that dies leaves ✕ on the model", async (t) => {
  const h = await setup(t)
  await h.emit("session.retry.scheduled", { sessionID: "s1", at: Date.now() + 9_000, attempt: 2 })
  await h.tick(500)
  assert.equal(h.name("provider/a"), "A ↻")
  // the retry attempt runs again → running beats retrying
  await h.emit("session.execution.started", { sessionID: "s1" })
  await h.tick(500)
  assert.equal(h.name("provider/a"), "A ●")
  // ...and the chain gives up → the ✕ mark holds until the provider's epoch
  await h.emit("session.execution.failed", { sessionID: "s1", error: { kind: "free_tier_limit" } })
  await h.tick(500)
  assert.equal(h.name("provider/a"), "A ✕")
})

test("v2 session.model.selected moves a running badge instantly without listing sessions", async (t) => {
  const h = await setup(t)
  await h.emit("session.execution.started", { sessionID: "s1" })
  await h.tick(500)
  assert.equal(h.name("provider/a"), "A ●")
  await h.emit("session.model.selected", { sessionID: "s1", model: { providerID: "provider", modelID: "b" } })
  assert.equal(h.name("provider/a"), "A")
  assert.equal(h.name("provider/b"), "B ●")
})

test("replayed durable history cannot resurrect a ghost ● on an idle session", async (t) => {
  const h = await setup(t)
  // durable frame stamped long before this connection: bookkeeping only
  await h.emit("session.step.started", { sessionID: "s1" }, { created: Date.now() - 1_000_000, durable: { aggregateID: "s1", seq: 3, version: 1 } })
  assert.equal(h.name("provider/a"), "A")
  // fresh live generation still goes running
  await h.emit("session.text.delta", { sessionID: "s1", assistantMessageID: "m1", ordinal: 0, delta: "x" })
  await h.tick(500)
  assert.equal(h.name("provider/a"), "A ●")
})

test("subagent sessions (parentID) never inflate the count and time.busy seeds liveness (#12)", async (t) => {
  const h = await setup(t, [
    // root conversation currently running — authoritative from the wire DTO
    { id: "root", model: { providerID: "provider", id: "a" }, time: { busy: Date.now() - 5_000 } },
    // its subagent child, running the identical model — must NOT paint ● [2]
    { id: "agent", parentID: "root", model: { providerID: "provider", id: "a" }, time: { busy: Date.now() - 5_000 } },
  ])
  assert.equal(h.name("provider/a"), "A ●")
  // even live child events cannot inflate the visible count
  await h.emit("session.execution.started", { sessionID: "agent" })
  await h.tick(500)
  assert.equal(h.name("provider/a"), "A ●")
})
