// Badge system tests, written against the v0.2.x glyphs (● ↻ ✕) and the
// retry/exhausted states. The dedup + suffix-strip findings were contributed
// by @xmejl (PR #5); the tests here cover those cases against the current
// semantics.
import test from "node:test"
import assert from "node:assert/strict"
import { countRunningModels, pickBadge, stripBadge } from "../lib.ts"

const NOW = 100_000

const state = (overrides = {}) => ({
  sessionModels: new Map([["s1", "openai/gpt"]]),
  statusBusy: new Set(),
  statusRetry: new Set(),
  statusKnown: new Set(),
  retryMark: new Map(),
  lastActivity: new Map(),
  toolBusy: new Map(),
  now: NOW,
  activityTtlMs: 15_000,
  toolMaxMs: 600_000,
  ...overrides,
})

// ---- stripBadge ----

test("strips current glyph badges", () => {
  assert.equal(stripBadge("Foo"), "Foo")
  assert.equal(stripBadge("Foo ●"), "Foo")
  assert.equal(stripBadge("Foo ● [3]"), "Foo")
  assert.equal(stripBadge("Foo ↻"), "Foo")
  assert.equal(stripBadge("Foo ✕"), "Foo")
})

test("strips legacy emoji badges (old builds heal on the first transform)", () => {
  assert.equal(stripBadge("Foo ✅"), "Foo")
  assert.equal(stripBadge("Foo ✅ 3x"), "Foo")
  assert.equal(stripBadge("Foo ⭐"), "Foo")
  assert.equal(stripBadge("Foo ✔️ [3]"), "Foo")
})

test("strips accumulated mixed badges — names can never stack", () => {
  assert.equal(stripBadge("Foo ● [3] ✅ ✔️ [4] ↻ ✕"), "Foo")
  assert.equal(stripBadge("Foo ✅ ✅ ✅"), "Foo")
  assert.equal(stripBadge("Foo ● [2] ● [5]"), "Foo")
})

test("leaves real question marks alone — only the badge forms die", () => {
  assert.equal(stripBadge("Question?"), "Question?")
  assert.equal(stripBadge("Foo ?bar"), "Foo ?bar")
})

// ---- pickBadge ----

test("pickBadge: no badge for 0 or negative running counts", () => {
  assert.equal(pickBadge(0), "")
  assert.equal(pickBadge(-3), "")
})

test("pickBadge: exactly one running session -> ●", () => {
  assert.equal(pickBadge(1), " ●")
})

test("pickBadge: two or more running sessions -> ● [N]", () => {
  assert.equal(pickBadge(2), " ● [2]")
  assert.equal(pickBadge(3), " ● [3]")
})

test("pickBadge: priority running > retrying > exhausted", () => {
  assert.equal(pickBadge(2, 5, true), " ● [2]")
  assert.equal(pickBadge(1, 5, true), " ●")
  assert.equal(pickBadge(0, 5, true), " ↻")
  assert.equal(pickBadge(0, 0, true), " ✕")
  assert.equal(pickBadge(0, 0, false), "")
})

// ---- countRunningModels ----

test("counts a session once when busy status and fresh activity overlap (dedup)", () => {
  const s = state({
    statusBusy: new Set(["s1"]),
    statusKnown: new Set(["s1"]),
    lastActivity: new Map([["s1", NOW]]),
  })
  assert.deepEqual([...countRunningModels(s).running], [["openai/gpt", 1]])
})

test("counts distinct busy sessions on the same model", () => {
  const s = state({
    sessionModels: new Map([["s1", "openai/gpt"], ["s2", "openai/gpt"], ["s3", "anthropic/claude"]]),
    statusBusy: new Set(["s1", "s2", "s3"]),
    statusKnown: new Set(["s1", "s2", "s3"]),
  })
  const { running } = countRunningModels(s)
  assert.equal(running.get("openai/gpt"), 2)
  assert.equal(running.get("anthropic/claude"), 1)
})

test("stale activity is not running — unless a tool call is still open", () => {
  const open = state({
    lastActivity: new Map([["s1", NOW - 20_000]]),
    toolBusy: new Map([["s1", new Map([["t1", NOW - 5_000]])]]),
  })
  assert.equal(countRunningModels(open).running.get("openai/gpt"), 1)
  const capped = state({
    lastActivity: new Map([["s1", NOW - 20_000]]),
    toolBusy: new Map([["s1", new Map([["t1", NOW - 700_000]])]]),
  })
  assert.deepEqual([...countRunningModels(capped).running], [])
})

test("a tool-only session (no activity entry yet) still counts", () => {
  const s = state({ toolBusy: new Map([["s1", new Map([["t1", NOW - 1_000]])]]) })
  assert.equal(countRunningModels(s).running.get("openai/gpt"), 1)
})

test("sessions without a model mapping never count", () => {
  const s = state({ sessionModels: new Map(), toolBusy: new Map([["s1", new Map([["t1", NOW]])]]) })
  assert.deepEqual([...countRunningModels(s).running], [])
})

test("retrying sessions are ↻, not running", () => {
  const s = state({ statusRetry: new Set(["s1"]), statusKnown: new Set(["s1"]) })
  const { running, retrying } = countRunningModels(s)
  assert.equal(running.size, 0)
  assert.deepEqual([...retrying], [["openai/gpt", 1]])
})

test("exhausted marks survive until their epoch — then vanish", () => {
  const before = state({ retryMark: new Map([["s1", NOW + 100]]) })
  assert.deepEqual([...countRunningModels(before).exhausted], ["openai/gpt"])
  const after = state({ retryMark: new Map([["s1", NOW]]) })
  const { exhausted } = countRunningModels(after)
  assert.deepEqual([...exhausted], [])
  assert.equal(after.retryMark.has("s1"), false) // expired marks are pruned
})

test("exhausted is suppressed while the model is running or retrying", () => {
  const busy = state({
    statusBusy: new Set(["s1"]),
    statusKnown: new Set(["s1"]),
    retryMark: new Map([["s1", NOW + 100]]),
  })
  assert.deepEqual([...countRunningModels(busy).exhausted], [])

  const retrying = state({
    statusRetry: new Set(["s1"]),
    statusKnown: new Set(["s1"]),
    retryMark: new Map([["s1", NOW + 100]]),
  })
  assert.deepEqual([...countRunningModels(retrying).exhausted], [])
})
