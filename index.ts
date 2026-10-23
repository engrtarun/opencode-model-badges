// ---------------------------------------------------------------------------
// model-badges — live running-session badges on OpenCode model names
// ---------------------------------------------------------------------------
//
// What it shows (suffix on the model name inside the model picker):
//   exactly 1 session running on a model   ->  "Big Pickle ●"        (U+25CF dot)
//   2+ sessions running on the same model  ->  "Big Pickle ● [3]"    (dot + count)
//   model rate-limited (session retrying)  ->  "Big Pickle ↻"        (U+21BB retry arrow)
//   limit exhausted / final failure        ->  "Big Pickle ✕"        (U+2715 cross)
//   nothing running                        ->  no badge at all
//
// N = number of CURRENTLY RUNNING chat sessions — never history totals.
//
// Design notes:
//   - Pure Unicode text glyphs (● ↻ ✕) instead of emoji — monochrome,
//     monospace-friendly, and rendered identically by every terminal and
//     font (no Segoe UI Emoji / color-emoji dependency).
//   - Rate-limit visibility: OpenCode core classifies 429s and sets
//     session status to "retry" while it backs off. A retrying session is
//     NOT running — it earns ↻. When the status drops back to idle (the
//     retry policy gave up), the model keeps ✕ until the provider-provided
//     `next` retry epoch (usage-limit resets can be hours away), capped at
//     24h, falling back to RETRY_MARK_DEFAULT_MS when no `next` arrives.
//   - In-process ctx.event.subscribe() delivered ZERO events in practice;
//     this plugin instead consumes the server's SSE stream (GET /api/event)
//     with plain fetch() — no child processes, no terminal flash.
//   - Session liveness = generation-stream events (*.delta, session.step.*,
//     session.tool.*, usage.updated) with a 15s TTL, PLUS explicit tracking
//     of open tool calls by toolCallID so long builds/scripts never lose
//     their badge while the model is silent.
//   - Names are re-derived from the bare name on every transform (badge
//     suffix is stripped first), so badges can never accumulate or go stale.
//
// Event schema (reverse-engineered from the OpenCode CLI / SDK types):
//   session.status -> { sessionID, status: {
//     type: "busy"|"idle"|"retry",
//     attempt?, message?, next?,            // present on retry
//     action?: { reason: "free_tier_limit"|"account_rate_limit", ... }
//   } }
//   session.idle   -> { sessionID }
//
// License: MIT

import { Plugin } from "@opencode/plugin"
import { countRunningModels, pickBadge, stripBadge } from "./lib.ts"

const MAP_REFRESH_DEBOUNCE_MS = 8_000
const STATUS_DEBOUNCE_MS = 500
// Only generation-stream events prove a session is alive RIGHT NOW.
// (Plain session.updated / title events do NOT — that was an early
// false-positive bug that put ✅ on idle models.)
const GEN_RE = /(\.delta|\.streamed)$|session\.(step|tool)\.|session\.(text|reasoning)\.|usage\.updated/
// No delta/step activity for this long -> not running (unless status/tool says busy)
const ACTIVITY_TTL_MS = 15_000
// Tool calls: during a LONG tool (build/script) the model streams nothing,
// so the activity TTL would expire even though the session IS busy. Open tool
// executions are therefore tracked explicitly via toolCallID: start -> open,
// success/failed -> closed. (Counting events was leaky — one call fires BOTH
// tool.called and tool.input.started — a Set of toolCallIDs is exact.)
const TOOL_START_RE = /session\.tool\.(called|input\.started|started)$/
const TOOL_END_RE = /session\.tool\.(success|failed|errored|error|done|finished|closed)$/
// Safety valve: a tool can't legitimately run forever — drop missed-end tools
const TOOL_MAX_MS = 10 * 60_000
// Rate-limit "exhausted" mark: when a retrying session drops back to idle
// (OpenCode's retry policy gave up), keep ✕ on the model until the provider's
// `next` retry epoch. Without a usable `next`, hold the mark for this long:
const RETRY_MARK_DEFAULT_MS = 10 * 60_000
// ...but never trust a provider-provided `next` beyond a day:
const RETRY_MARK_MAX_MS = 24 * 60 * 60_000
const RECONNECT_MS = 3_000
const MAP_REFRESH_INTERVAL_MS = 10 * 60_000

let debugPath = ""

export default Plugin.define({
  id: "model-badges",
  async setup(ctx) {
    // Optional debug log (disabled silently if the directory can't be written)
    try {
      const os = await import("node:os")
      const pathMod = await import("node:path")
      debugPath = pathMod.join(os.homedir(), ".config", "opencode", "plugins", "model-badges", "debug.log")
    } catch {}
    const dbg = (msg: string) => {
      if (!debugPath) return
      import("node:fs")
        .then((fs) => fs.appendFileSync(debugPath, `${new Date().toISOString()} ${msg}\n`))
        .catch(() => {})
    }
    try {
      const fs = await import("node:fs")
      fs.writeFileSync(debugPath, "=== model-badges setup ===\n")
    } catch {}

    // sessionID -> model key (refreshed by refreshMap)
    const sessionModels = new Map<string, string>()
    let modelRevision = 0
    // Authoritative busy set from session.status events
    const statusBusy = new Set<string>()
    // Authoritative retry set — sessions blocked on an OpenCode retry policy
    // (rate limit / 429 back-off). These are NOT running; they earn ↻, not ●.
    const statusRetry = new Set<string>()
    // Sessions for which we have authoritative status (event-based)
    const statusKnown = new Set<string>()
    // sid -> epoch until which the model stays marked "limit exhausted" (✕)
    // after that session's retry status dropped to idle. Provider-provided
    // `next` when we got one, otherwise now + RETRY_MARK_DEFAULT_MS.
    const retryMark = new Map<string, number>()
    // Recent generation-stream timestamps for sessions whose status is unknown
    const lastActivity = new Map<string, number>()
    // Open tool executions per session: sessionID -> Map<toolCallID, startedAt>
    // (Map rather than Set so we also know the oldest open call for the safety cap)
    const toolBusy = new Map<string, Map<string, number>>()
    // model key -> count of currently running sessions; drives the ● badges
    let runningCount = new Map<string, number>()
    // model key -> count of sessions currently blocked in retry (rate limit)
    let retryCount = new Map<string, number>()
    // model keys whose latest activity was a retry policy that gave up (✕)
    let exhaustedModels = new Set<string>()

    const recomputeRunning = () => {
      const { running, retrying, exhausted } = countRunningModels({
        sessionModels,
        statusBusy,
        statusRetry,
        statusKnown,
        retryMark,
        lastActivity,
        toolBusy,
        now: Date.now(),
        activityTtlMs: ACTIVITY_TTL_MS,
        toolMaxMs: TOOL_MAX_MS,
      })
      runningCount = running
      retryCount = retrying
      exhaustedModels = exhausted
    }

    // ---- session -> model map (in-process, paginated) ----
    // Needed to translate running sessionIDs into model keys.
    const refreshMap = async () => {
      const revision = modelRevision
      const seen = new Set<string>()
      let cursor: string | undefined
      for (let page = 0; page < 200; page++) {
        const input: { limit: number; cursor?: string } = { limit: 100 }
        if (cursor) input.cursor = cursor
        const res = await ctx.session.list(input)
        // An event is newer than an in-flight list; don't restore its old model.
        if (revision !== modelRevision) {
          schedule(MAP_REFRESH_DEBOUNCE_MS)
          return
        }
        for (const s of res.data) {
          if (!s.model) continue
          const key = `${s.model.providerID}/${s.model.id}`
          sessionModels.set(s.id, key)
          seen.add(s.id)
        }
        cursor = res.cursor?.next
        if (!cursor) break
      }
      // Drop deleted sessions so ghost IDs can't map to models
      for (const id of [...sessionModels.keys()]) {
        if (!seen.has(id)) sessionModels.delete(id)
      }
      recomputeRunning()
      dbg(
        `map: sessions=${sessionModels.size} running=[${[...runningCount].map(([k, n]) => `${k}(${n})`).join(",")}] ` +
          `retry=[${[...retryCount].map(([k, n]) => `${k}(${n})`).join(",")}] ` +
          `exhausted=[${[...exhaustedModels].join(",")}]`,
      )
    }

    // ---- model name transform ----
    await ctx.model.transform((editor) => {
      try {
        for (const model of editor.list()) {
          const key = `${model.providerID}/${model.id}`
          const base = stripBadge(model.name)
          const n = runningCount.get(key) ?? 0
          const r = retryCount.get(key) ?? 0
          // Priority: actually running wins, then rate-limited, then exhausted
          const suffix = pickBadge(n, r, exhaustedModels.has(key))
          const final = base + suffix
          if (final !== model.name) {
            editor.update(model.providerID, model.id, (draft) => {
              draft.name = final
            })
          }
        }
      } catch (e) {
        dbg(`transform: ${e}`)
      }
    })

    // ---- debounced refresh + reload ----
    let timer: ReturnType<typeof setTimeout> | undefined
    let timerDelay = 0
    const run = () => {
      timer = undefined
      void refreshMap()
        .then(() => ctx.model.reload())
        .catch((e) => dbg(`refreshMap: ${e}`))
    }
    // Keep the EARLIEST deadline — status updates must not be pushed back
    const schedule = (delay: number) => {
      const wait = timer ? Math.min(timerDelay, delay) : delay
      if (timer) clearTimeout(timer)
      timerDelay = wait
      timer = setTimeout(run, delay === STATUS_DEBOUNCE_MS ? delay : wait)
    }

    // Initial map refresh + slow safety refresh (guards against missed events)
    schedule(STATUS_DEBOUNCE_MS)
    const safety = setInterval(() => schedule(MAP_REFRESH_DEBOUNCE_MS), MAP_REFRESH_INTERVAL_MS)

    // ---- SSE event stream (auto-reconnects forever) ----
    const sse = new AbortController()

    const handleEvent = (line: string) => {
      let payload: { type?: string; data?: Record<string, unknown> } | undefined
      try {
        payload = JSON.parse(line)
      } catch {
        return
      }
      const type = payload?.type
      if (typeof type !== "string") return
      const data = (payload.data ?? payload) as Record<string, unknown>
      const sid = data.sessionID
      if (typeof sid === "string") {
        // ---- tool lifecycle (BEFORE GEN_RE: session.tool.* matches both) ----
        if (TOOL_END_RE.test(type)) {
          const tcid = data.toolCallID
          const open = toolBusy.get(sid)
          if (open) {
            if (typeof tcid === "string") open.delete(tcid)
            else if (open.size > 0) open.delete([...open.keys()][open.size - 1])
          }
          lastActivity.set(sid, Date.now())
          dbg(`toolEv end ${type} sid=${sid} open=${open?.size ?? 0}`)
          recomputeRunning()
          schedule(STATUS_DEBOUNCE_MS)
          return
        }
        if (TOOL_START_RE.test(type)) {
          const tcid = data.toolCallID
          let open = toolBusy.get(sid)
          if (!open) {
            open = new Map<string, number>()
            toolBusy.set(sid, open)
          }
          // The same toolCallID fires tool.called AND tool.input.started —
          // the Map key dedupes them automatically.
          const key = typeof tcid === "string" ? tcid : `anon:${Date.now()}`
          open.set(key, Date.now())
          statusKnown.delete(sid) // an open tool OVERRIDES any stale idle status
          statusRetry.delete(sid) // a session executing tools is not rate-limited
          lastActivity.set(sid, Date.now())
          dbg(`toolEv start ${type} sid=${sid} open=${open.size}`)
          recomputeRunning()
          schedule(STATUS_DEBOUNCE_MS)
          return
        }
        if (type === "session.status" || type === "session.idle") {
          let stType: string | undefined
          let next: number | undefined
          if (type === "session.status") {
            const st = data.status as { type?: string; next?: unknown } | string | undefined
            stType = typeof st === "string" ? st : st?.type
            if (typeof st === "object" && st && typeof (st as { next?: unknown }).next === "number") {
              next = (st as { next?: number }).next
            }
          } else {
            stType = "idle"
          }
          statusKnown.add(sid)
          if (stType === "busy") {
            statusBusy.add(sid)
            statusRetry.delete(sid)
          } else if (stType === "retry") {
            // Rate-limited: OpenCode is backing off. NOT running — ↻ territory.
            statusRetry.add(sid)
            statusBusy.delete(sid)
            // Hold the exhausted mark until the provider's own `next` epoch
            // (usage-limit resets can be hours away), capped at 24h; fall back
            // to a fixed window when the event carries no usable `next`.
            const now = Date.now()
            const until = next && next > now && next <= now + RETRY_MARK_MAX_MS
              ? Math.max(retryMark.get(sid) ?? 0, next)
              : Math.max(retryMark.get(sid) ?? 0, now + RETRY_MARK_DEFAULT_MS)
            retryMark.set(sid, until)
          } else {
            // idle: the retry policy gave up → ✕ mark (already set) survives
            statusBusy.delete(sid)
            statusRetry.delete(sid)
          }
          dbg(`statusEv ${type} sid=${sid} st=${stType} next=${next ?? "-"}`)
          recomputeRunning()
          schedule(STATUS_DEBOUNCE_MS)
          return
        }
        if (GEN_RE.test(type)) {
          lastActivity.set(sid, Date.now())
          // Fresh activity = alive RIGHT NOW; it overrides any stale "idle"
          // or "retry" mark, otherwise a session that idled or rate-limited
          // once could never go live again.
          statusKnown.delete(sid)
          statusRetry.delete(sid)
          const before = [...runningCount].sort().toString()
          recomputeRunning()
          const after = [...runningCount].sort().toString()
          if (before !== after) schedule(STATUS_DEBOUNCE_MS)
          return
        }
        if (type.startsWith("session.model")) {
          const model = data.model as { providerID?: unknown; id?: unknown; modelID?: unknown } | undefined
          const modelID = model?.id ?? model?.modelID
          if (typeof model?.providerID === "string" && model.providerID && typeof modelID === "string" && modelID) {
            modelRevision++
            sessionModels.set(sid, `${model.providerID}/${modelID}`)
            recomputeRunning()
            void ctx.model.reload().catch((e) => dbg(`model reload: ${e}`))
          } else {
            schedule(STATUS_DEBOUNCE_MS)
          }
          return
        }
        if (
          type === "session.created" ||
          type === "session.updated" ||
          type === "session.deleted" ||
          type === "session.moved"
        ) {
          if (type === "session.deleted") {
            // No leaks: drop all per-session state for deleted sessions
            toolBusy.delete(sid)
            lastActivity.delete(sid)
            statusBusy.delete(sid)
            statusRetry.delete(sid)
            statusKnown.delete(sid)
            retryMark.delete(sid)
          }
          // New/deleted/moved sessions or model switch -> refresh session->model map
          schedule(MAP_REFRESH_DEBOUNCE_MS)
        }
      }
    }

    void (async () => {
      while (!sse.signal.aborted) {
        try {
          const fs = await import("node:fs")
          const os = await import("node:os")
          const path = await import("node:path")
          let url = ""
          let password = ""
          for (const p of [
            path.join(os.homedir(), ".local", "state", "opencode", "service.json"),
            path.join(os.homedir(), ".config", "opencode", "service.json"),
          ]) {
            try {
              const j = JSON.parse(fs.readFileSync(p, "utf8")) as { url?: string; password?: string }
              if (!url && j.url) url = j.url
              if (!password && j.password) password = j.password
            } catch {}
          }
          if (!url || !password) throw new Error("service.json discovery failed")
          const auth = "Basic " + Buffer.from("opencode:" + password).toString("base64")
          const res = await fetch(`${url}/api/event`, {
            headers: { Authorization: auth },
            signal: sse.signal,
          })
          if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`)
          dbg("sse connected")
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          let buf = ""
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let nl: number
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim()
              buf = buf.slice(nl + 1)
              if (line.startsWith("data:")) handleEvent(line.slice(5).trim())
            }
          }
          if (!sse.signal.aborted) dbg("sse stream ended")
        } catch (e) {
          if (sse.signal.aborted) return
          dbg(`sse error: ${e}`)
        }
        await new Promise((r) => setTimeout(r, RECONNECT_MS))
      }
    })()

    return () => {
      sse.abort()
      clearInterval(safety)
      if (timer) clearTimeout(timer)
    }
  },
})
