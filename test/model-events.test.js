import test from "node:test"
import assert from "node:assert/strict"
import { register } from "node:module"

register("./fixtures/plugin-loader.js", import.meta.url)
const { default: plugin } = await import("../index.ts")
const flush = () => new Promise((resolve) => setImmediate(resolve))

async function setup(t) {
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
  let selected = "a"
  let transform
  let listCalls = 0
  let pendingList
  const ctx = {
    session: {
      list: async ({ cursor }) => {
        listCalls++
        const snapshot = selected
        if (!cursor && pendingList) {
          const pending = pendingList
          pendingList = undefined
          await pending
        }
        return cursor
          ? { data: [{ id: "idle", model: { providerID: "other", id: "b" } }] }
          : { data: [{ id: "s1", model: { providerID: "provider", id: snapshot } }], cursor: { next: "second" } }
      },
    },
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
  const emit = async (type, data) => {
    stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data })}\n\n`))
    await flush()
  }
  await tick(500)
  await emit("session.status", { sessionID: "s1", status: { type: "busy" } })
  await tick(500)
  assert.equal(models.get("provider/a").name, "A ●")
  const pauseList = () => {
    let resume
    pendingList = new Promise((resolve) => { resume = resolve })
    return resume
  }
  return { models, emit, tick, pauseList, calls: () => listCalls, select: (id) => { selected = id } }
}

test("model payloads move a running badge immediately without listing sessions", async (t) => {
  const h = await setup(t)
  const calls = h.calls()
  await h.emit("session.model.updated", { sessionID: "s1", model: { providerID: "provider", id: "b" } })
  assert.equal(h.models.get("provider/a").name, "A")
  assert.equal(h.models.get("provider/b").name, "B ●")
  assert.equal(h.calls(), calls)

  await h.emit("session.model", { sessionID: "s1", model: { providerID: "other", modelID: "b" } })
  assert.equal(h.models.get("provider/b").name, "B")
  assert.equal(h.models.get("other/b").name, "Other B ●")
  assert.equal(h.calls(), calls)
})

test("a model event without usable model data refreshes the complete paginated map promptly", async (t) => {
  const h = await setup(t)
  const calls = h.calls()
  h.select("b")
  await h.emit("session.model.updated", { sessionID: "s1", model: { providerID: "provider" } })
  await h.tick(500)
  assert.equal(h.calls(), calls + 2)
  assert.equal(h.models.get("provider/a").name, "A")
  assert.equal(h.models.get("provider/b").name, "B ●")
})

test("bulk session updates keep the eight-second debounce and do not activate idle sessions", async (t) => {
  const h = await setup(t)
  const calls = h.calls()
  h.select("b")
  await h.emit("session.updated", { sessionID: "s1" })
  await h.tick(500)
  assert.equal(h.calls(), calls)
  assert.equal(h.models.get("provider/a").name, "A ●")
  await h.tick(7500)
  assert.equal(h.calls(), calls + 2)
  assert.equal(h.models.get("provider/a").name, "A")
  assert.equal(h.models.get("provider/b").name, "B ●")
  assert.equal(h.models.get("other/b").name, "Other B")
})

test("a session list started before a model switch cannot restore the old badge", async (t) => {
  const h = await setup(t)
  const resume = h.pauseList()
  await h.emit("session.status", { sessionID: "s1", status: { type: "busy" } })
  await h.tick(500)
  await h.emit("session.model.updated", { sessionID: "s1", model: { providerID: "provider", id: "b" } })
  assert.equal(h.models.get("provider/b").name, "B ●")
  resume()
  await flush()
  assert.equal(h.models.get("provider/a").name, "A")
  assert.equal(h.models.get("provider/b").name, "B ●")
})
