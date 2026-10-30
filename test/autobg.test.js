import test from "node:test"
import assert from "node:assert/strict"
import { register } from "node:module"
import { writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// AutoBG (autobg.ts + index.ts wiring): a tool call that keeps a session
// blocked for >= 2 min is auto-moved to background (the Ctrl+B operation,
// POST /api/session/{id}/background), with ONE "Ns left" toast at T-30s and
// ONE "moved" toast at the fire. Model-chat-only runs, sub-2-min tools,
// subagent children (parentID) and zombie clocks (missed end events) must
// never fire it.
register("./fixtures/plugin-loader.js", import.meta.url)
const { default: plugin } = await import("../index.ts")
const { createAutoBg, AUTOBG } = await import("../autobg.ts")
const flush = async () => {
  // Deterministic drain: node 22's mocked tick() can end with plugin async
  // work still pending in the microtask queue (postBackground's dynamic
  // imports + fetch + toast chain). A single setImmediate was not enough —
  // those continuations landed in the NEXT test's fetch mock. Drain
  // microtasks, hop a macrotask, drain again.
  for (let i = 0; i < 25; i++) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  for (let i = 0; i < 25; i++) await Promise.resolve()
}

const clockAt = (start = 1_700_000_000_000) => {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

// ---- pure state machine ----------------------------------------------------

test("autoBg warns once at T-30s and fires exactly one background request at 2 min", async () => {
  const c = clockAt()
  const toasts = []
  let bgCalls = 0
  const bg = createAutoBg({
    now: c.now,
    toast: (message, variant) => toasts.push({ message, variant }),
    background: async () => { bgCalls++ },
  })
  bg.start("s1", "c1", "bash")
  for (let s = 1; s <= 89; s++) { c.advance(1_000); bg.poll() }
  assert.deepEqual(bg.stats(), { open: 1, warned: 0, requested: 0 }, "no warn before T-30s")
  c.advance(1_000); bg.poll() // 90s — exactly at the checkpoint
  assert.equal(toasts.length, 1)
  assert.match(toasts[0].message, /AutoBG: 30s — "bash"/)
  assert.equal(toasts[0].variant, "info")
  for (let s = 0; s < 29; s++) { c.advance(1_000); bg.poll() }
  assert.equal(toasts.length, 1, "warn fires once, never re-sends")
  c.advance(1_000); bg.poll() // 120s — fire
  await flush()
  c.advance(5_000); bg.poll() // would fire again without the one-shot guard
  await flush()
  assert.equal(bgCalls, 1, "exactly one background request per session turn")
  assert.equal(toasts.length, 2)
  assert.match(toasts[1].message, /AutoBG: moved to background \(ran 2m\d\d? \w*\)|moved to background \(ran 2m/ )
  assert.equal(toasts[1].variant, "success")
})

test("a tool that ends before the threshold never fires and resets its own clock", async () => {
  const c = clockAt()
  let bgCalls = 0
  const bg = createAutoBg({
    now: c.now,
    toast: () => {},
    background: async () => { bgCalls++ },
  })
  bg.start("s1", "c1", "bash")
  c.advance(90_000); bg.poll() // warned
  bg.end("s1", "c1")
  for (let s = 0; s < 120; s++) { c.advance(1_000); bg.poll() }
  assert.equal(bgCalls, 0, "ended call cannot fire anything")
  // a later call starts its own clock from zero
  bg.start("s1", "c2", "edit")
  for (let s = 0; s < 119; s++) { c.advance(1_000); bg.poll() }
  assert.equal(bgCalls, 0)
  c.advance(1_000); bg.poll()
  await flush()
  assert.equal(bgCalls, 1)
})

test("the oldest open call drives the trigger; short interleaved calls cannot delay it", async () => {
  const c = clockAt()
  let bgCalls = 0
  const bg = createAutoBg({
    now: c.now,
    toast: () => {},
    background: async () => { bgCalls++ },
  })
  bg.start("s1", "c1", "bash") // the long one
  c.advance(60_000)
  bg.start("s1", "c2", "read") // a quick call inside the same turn
  bg.end("s1", "c2")
  c.advance(59_000); bg.poll() // 119s on c1
  assert.equal(bgCalls, 0)
  c.advance(1_000); bg.poll()
  await flush()
  assert.equal(bgCalls, 1)
})

test("execution end (clear) re-arms the trigger for the NEXT long run", async () => {
  const c = clockAt()
  let bgCalls = 0
  const bg = createAutoBg({
    now: c.now,
    toast: () => {},
    background: async () => { bgCalls++ },
  })
  bg.start("s1", "c1", "bash")
  c.advance(125_000); bg.poll()
  await flush()
  assert.equal(bgCalls, 1)
  bg.clear("s1") // session.execution.succeeded / idle / deleted
  bg.start("s1", "c2", "bash")
  c.advance(119_000); bg.poll()
  assert.equal(bgCalls, 1, "second run still under threshold")
  c.advance(1_000); bg.poll()
  await flush()
  assert.equal(bgCalls, 2, "re-armed: a fresh long run fires again")
})

test("repeated starts of the same call dedupe; the 10-minute cap stands down zombie clocks", async () => {
  const c = clockAt()
  let bgCalls = 0
  const bg = createAutoBg({
    now: c.now,
    toast: () => {},
    background: async () => { bgCalls++ },
  })
  bg.start("s1", "c1", "bash")
  bg.start("s1", "c1", "bash") // tool.called re-fires input.started of one call
  assert.equal(bg.stats().open, 1)
  c.advance(AUTOBG.CAP_MS + 60_000); bg.poll()
  assert.deepEqual(bg.stats(), { open: 0, warned: 0, requested: 0 }, "zombie clock dropped silently")
  assert.equal(bgCalls, 0)
  // dropped clock cannot resurrect
  c.advance(30_000); bg.poll()
  assert.equal(bgCalls, 0)
})

// ---- integration through index.ts (real SSE fixture frames) ------------------

async function setup(t, list = [{ id: "s1", model: { providerID: "provider", id: "a" } }]) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] })
  let stream
  let connected
  const connection = new Promise((resolve) => { connected = resolve })
  const body = new ReadableStream({ start(controller) { stream = controller } })
  const bgCalls = []
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if (String(url).startsWith("http://opencode.test/api/event")) {
      assert.equal(init.method ?? "GET", "GET")
      init.signal?.addEventListener("abort", () => stream.error(new Error("fixture aborted")), { once: true })
      connected()
      return { ok: true, status: 200, body }
    }
    if (String(url).startsWith("http://opencode.test/api/session/") && String(url).endsWith("/background")) {
      bgCalls.push(String(url))
      return { ok: true, status: 204 }
    }
    return { ok: false, status: 404 }
  })

  const models = new Map([
    ["provider/a", { providerID: "provider", id: "a", name: "A" }],
  ])
  // CI runners have no real ~/.config/opencode/service.json — point the
  // raw background POST at a fixture copy through the plugin's own
  // OPENCODE_SERVICE_JSON override (the multi-instance escape hatch).
  const svcFile = join(tmpdir(), "opencode-test-service.json")
  writeFileSync(svcFile, JSON.stringify({ url: "http://opencode.test", password: "t" }))
  process.env.OPENCODE_SERVICE_JSON = svcFile
  t.after(() => { delete process.env.OPENCODE_SERVICE_JSON; try { rmSync(svcFile) } catch {} })
  let transform
  const toasts = []
  // client carries ONLY the toast — with no duck-typed session.background the
  // plugin must fall back to the raw POST /api/session/{id}/background route
  const ctx = {
    client: { tui: { showToast: async ({ body }) => toasts.push({ message: body.message, variant: body.variant, title: body.title }) } },
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
    const frame = { id: "evt_" + Math.random().toString(16).slice(2), type, created: Date.now(), data, ...extra }
    stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`))
    await flush()
  }
  await tick(500)
  return { emit, tick, bgCalls, toasts, autoBgStats: ctx.autoBgStats }
}

test("integration: v2 long tool moves the session to background with both toasts (raw route)", async (t) => {
  const h = await setup(t)
  await h.emit("session.tool.input.started", { sessionID: "s1", assistantMessageID: "m1", id: "c1", name: "bash" })
  await h.tick(89_000)
  assert.equal(h.bgCalls.length, 0, "silent under 90s")
  assert.deepEqual(h.toasts, [], "no warn under T-30s")
  await h.tick(1_000)
  assert.equal(h.toasts.filter((x) => x.message.includes("30s")).length, 1, "warned exactly once at 90s")
  await h.tick(29_000)
  assert.equal(h.bgCalls.length, 0, "119s: not yet")
  await h.tick(2_000)
  assert.deepEqual(h.bgCalls, ["http://opencode.test/api/session/s1/background"])
  assert.equal(h.toasts.filter((x) => x.variant === "success" && /moved to background \(ran 2m/.test(x.message)).length, 1)
  assert.equal(h.toasts.filter((x) => x.title === "AutoBG").length, 2)
  // idempotent: no more requests while the call stays open
  await h.tick(5_000)
  assert.equal(h.bgCalls.length, 1)
  // tool ends -> turn over -> a fresh long run can fire again
  await h.emit("session.tool.success", { sessionID: "s1", assistantMessageID: "m1", id: "c1", content: [{ type: "text", text: "ok" }], executed: true })
  await h.tick(500)
  await h.emit("session.tool.input.started", { sessionID: "s1", assistantMessageID: "m2", id: "c2", name: "bash" })
  await h.tick(120_000)
  assert.equal(h.bgCalls.length, 2, "re-armed across turns")
})

test("integration: model-chat-only runs and sub-2-min tools never background (#AutoBG scope)", async (t) => {
  const h = await setup(t)
  // a pure model run (thinking/streaming) with no tool calls, kept long on purpose
  await h.emit("session.execution.started", { sessionID: "s1" })
  await h.tick(180_000)
  assert.equal(h.bgCalls.length, 0, "model runs are never auto-backgrounded")
  // a tool that finishes quickly
  await h.emit("session.tool.input.started", { sessionID: "s1", assistantMessageID: "m1", id: "c1", name: "read" })
  await h.tick(30_000)
  await h.emit("session.tool.success", { sessionID: "s1", assistantMessageID: "m1", id: "c1", content: [{ type: "text", text: "ok" }], executed: true })
  await h.tick(180_000)
  assert.equal(h.bgCalls.length, 0)
})

test("integration: subagent children and unknown sessions are skipped (#12 guard)", async (t) => {
  const h = await setup(t, [
    { id: "root", model: { providerID: "provider", id: "a" }, time: { busy: Date.now() - 1_000 } },
    // only the ROOT is mapped (parentID children never enter the model map)
  ])
  // a subagent child of root running a long tool — its events arrive but the
  // map owns the badge; backgrounding the CHILD would detach grep from its
  // parent conversation, so AutoBG must not fire for it
  await h.emit("session.tool.input.started", { sessionID: "child-not-in-map", assistantMessageID: "m1", id: "c1", name: "bash" })
  await h.tick(150_000)
  assert.equal(h.bgCalls.length, 0, "sessions outside the visible map never fire AutoBG")
})
