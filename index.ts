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
import { createAutoBg } from "./autobg.ts"

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
// OpenCode v2 moved execution state out of session.status entirely:
//   session.retry.scheduled { at, attempt, error } — rate-limit back-off
//   session.execution.started|succeeded|failed|interrupted — turn lifecycle
// Both ship `created` stamps and durable envelopes that can REPLAY after a
// reconnect, so liveness marks are gated on arrival freshness.
const V2_RETRY_RE = /^session\.retry\.scheduled$/
const V2_EXEC_RE = /^session\.execution\.(started|succeeded|failed|interrupted)$/
// Frames stamped older than this relative to the current connection are
// history, never liveness (ghost ● guard for replayed session.step.*).
const REPLAY_GATE_MS = 2_000
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
    // Hoist node built-ins ONCE at the very top: NO dynamic import() may ever
    // run inside a timer or event callback — under node 22's mocked event
    // loop an import() issued from a timer callback never resolves (stalls),
    // and in production the per-fire Promise.all just wastes microtasks.
    const [fs, os, path] = await Promise.all([
      import("node:fs"),
      import("node:os"),
      import("node:path"),
    ])
    // Optional debug log (disabled silently if the directory can't be written)
    try {
      debugPath = path.join(os.homedir(), ".config", "opencode", "plugins", "model-badges", "debug.log")
    } catch {}
    const dbg = (msg: string) => {
      if (!debugPath) return
      try {
        fs.appendFileSync(debugPath, `${new Date().toISOString()} ${msg}\n`)
      } catch {}
    }
    try {
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
    // Wall-clock of the last successful SSE connection: durable v2 payloads
    // can replay after a reconnect, so `created` < connectEpoch = history.
    let connectEpoch = Date.now()
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
          // Subagent sessions are children of the conversation you see — they
          // run on the same model and would inflate the count one per child
          // (#12). The parent's badge owns the slot; children never map.
          if (typeof (s as { parentID?: unknown }).parentID === "string") continue
          const key = `${s.model.providerID}/${s.model.id}`
          sessionModels.set(s.id, key)
          seen.add(s.id)
          // v2 Session.Info carries execution state on the wire — seed the
          // authoritative busy set from it so a badge never flickers off
          // while the SSE stream catches up after a reconnect.
          const ti = (s as { time?: { busy?: unknown; idle?: unknown } }).time
          if (typeof ti?.busy === "number" && (typeof ti.idle !== "number" || ti.busy > ti.idle)) {
            statusKnown.add(s.id)
            statusBusy.add(s.id)
            statusRetry.delete(s.id)
          }
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
    // A v2 back-off whose follow-up execution event was missed (restart,
    // reconnect) must not hold ↻ forever — drop it once its terminal mark expires.
    const sweeper = setInterval(() => {
      const now = Date.now()
      let stale = false
      for (const sid of [...statusRetry]) {
        if ((retryMark.get(sid) ?? 0) <= now) {
          statusRetry.delete(sid)
          stale = true
        }
      }
      if (stale) recomputeRunning()
    }, 60_000)

    // service.json discovery candidates — computed once with the hoisted
    // built-ins; OPENCODE_SERVICE_JSON (first entry) overrides the standard
    // locations, e.g. for machines running more than one opencode instance.
    const serviceCandidatePaths = [
      ...(process.env.OPENCODE_SERVICE_JSON ? [process.env.OPENCODE_SERVICE_JSON] : []),
      path.join(os.homedir(), ".local", "state", "opencode", "service.json"),
      path.join(os.homedir(), ".config", "opencode", "service.json"),
    ]
    // ---- AutoBG: auto-move sessions whose tool runs cross 1 minute ----
    // Countdown UX is toast checkpoints (engine owns the statusbar hint line,
    // so "AutoBG: Ns left" INSIDE that hint would need an engine PR).
    //   T-15s: toast once;  T=0: POST /api/session/{id}/background + toast.
    // Model-chat-only runs never fire (no open tool call => no tracker entry).
    // One-time shape probe — where does THIS build hide its toast API? The
    // keys land in debug.log so a future build's route is wired without
    // re-reading engine sources.
    const client = (ctx as { client?: Record<string, unknown> }).client
    if (client && typeof client === "object") {
      try {
        dbg(`autobg client keys: ${Object.keys(client).join(",")}`)
        const tuiShape = client.tui as Record<string, unknown> | undefined
        if (tuiShape && typeof tuiShape === "object") {
          dbg(`autobg client.tui keys: ${Object.keys(tuiShape).join(",")}`)
        }
      } catch {}
    }
    const bgToast = async (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
      // Duck across builds: SDKs have moved this route around (a live engine
      // answered POST /tui/toast with 405, /api/tui/toast with 404) — try
      // every known call-shape; when none exists the background move still
      // happens and only the visual skips silently.
      const c = ctx as {
        client?: {
          tui?: { showToast?: unknown; toast?: unknown; toastShow?: unknown }
          toast?: unknown
        }
      }
      const payload = { body: { message, variant, title: "AutoBG" } }
      for (const fn of [c.client?.tui?.showToast, c.client?.tui?.toast, c.client?.tui?.toastShow, c.client?.toast]) {
        if (typeof fn === "function") {
          try {
            await (fn as (b: object) => Promise<unknown>)(payload)
            return
          } catch {}
        }
      }
      dbg(`autobg toast unavailable (${variant}): ${message}`)
    }
    // Cross-process fire lock: this machine often runs 6+ OpenCode processes,
    // and every one of them watches the same SSE stream — without a lock each
    // process fires its own POST. An "wx" exclusive create is atomic on NTFS:
    // the first process wins, the rest stand down while the lock is fresh
    // (<10s, plenty for one fire window). Locks are never hand-cleaned — the
    // age check ages them out.
    const AUTOBG_LOCK_MS = 10_000
    const acquireFireLock = (sid: string): boolean => {
      const lockFile = path.join(os.homedir(), ".config", "opencode", "plugins", "model-badges", `.autobg-fire-${sid}.lock`)
      try {
        const fd = fs.openSync(lockFile, "wx")
        fs.writeSync(fd, String(Date.now()))
        fs.closeSync(fd)
        dbg(`autobg lock acquired sid=${sid.slice(0, 12)}`)
        return true
      } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST") {
          // missing/unwritable dir — the move must never depend on the lock
          dbg(`autobg lock unavailable (${(e as { code?: string }).code ?? String(e)}) — firing anyway`)
          return true
        }
        try {
          const age = Date.now() - fs.statSync(lockFile).mtimeMs
          if (age < AUTOBG_LOCK_MS) {
            dbg(`autobg lock held (age=${Math.round(age / 1000)}s) — another process fired first sid=${sid.slice(0, 12)}`)
            return false
          }
          fs.writeFileSync(lockFile, String(Date.now())) // stale lock: take over
          dbg(`autobg lock stale (age=${Math.round(age / 1000)}s) — took over sid=${sid.slice(0, 12)}`)
          return true
        } catch {
          dbg("autobg lock stat failed — firing anyway")
          return true
        }
      }
    }
    const postBackground = async (sid: string) => {
      // Lock first: a thrown "held" error keeps the success-toast silent —
      // this process did NOT move the session, another one did.
      if (!acquireFireLock(sid)) throw new Error("fire lock held by another process")
      const c = ctx as { client?: { session?: { background?: (b: object) => Promise<unknown> } } }
      if (typeof c.client?.session?.background === "function") {
        return c.client.session.background({ sessionID: sid })
      }
      // Raw v2 route — the exact operation behind Ctrl+B:
      // POST /api/session/{id}/background -> 204 (promise/generated/client.ts)
      // IMPORT-FREE at fire time (built-ins are hoisted at setup — see
      // serviceCandidatePaths): node 22's mocked event loop stalls an
      // import() issued from inside a timer callback forever; production
      // also saves the microtasks on every fire.
      let url = ""
      let password = ""
      for (const p of serviceCandidatePaths) {
        try {
          const j = JSON.parse(fs.readFileSync(p, "utf8")) as { url?: string; password?: string }
          if (!url && j.url) url = j.url
          if (!password && j.password) password = j.password
        } catch {}
      }
      if (!url || !password) throw new Error("service.json discovery failed")
      const auth = "Basic " + Buffer.from("opencode:" + password).toString("base64")
      const res = await fetch(`${url}/api/session/${encodeURIComponent(sid)}/background`, {
        method: "POST",
        headers: { Authorization: auth },
      })
      if (!res.ok) throw new Error(`background HTTP ${res.status}`)
    }
    const autoBg = createAutoBg({ toast: bgToast, background: postBackground, dbg })
    // (test hook) lets the integration tests probe the tracker state directly
    ;(ctx as { autoBgStats?: unknown }).autoBgStats = autoBg.stats
    // 1s granularity keeps the "15s left" checkpoint honest
    const autoBgPoll = setInterval(() => autoBg.poll(), 1_000)

    // ---- session bookkeeping helpers (shared by v1 and v2 event paths) ----
    // No leaks: drop all per-session state for deleted sessions.
    const forgetSession = (sid: string) => {
      toolBusy.delete(sid)
      lastActivity.delete(sid)
      statusBusy.delete(sid)
      statusRetry.delete(sid)
      statusKnown.delete(sid)
      retryMark.delete(sid)
      autoBg.clear(sid)
    }
    // session.model.* — v1 frame: data.model{providerID, id}; v2 frame:
    // session.model.selected { model, previous }. One matcher covers both,
    // and the badge moves the instant the event lands.
    const applyModelEvent = (sid: string, data: Record<string, unknown>) => {
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
    }

    // ---- SSE event stream (auto-reconnects forever) ----
    const sse = new AbortController()

    const handleEvent = (line: string) => {
      let payload: { type?: string; data?: Record<string, unknown>; created?: unknown } | undefined
      try {
        payload = JSON.parse(line)
      } catch {
        return
      }
      const type = payload?.type
      if (typeof type !== "string") return
      const data = (payload.data ?? payload) as Record<string, unknown>
      const created = typeof payload.created === "number" ? payload.created : Number.NaN
      const sid = data.sessionID
      if (typeof sid === "string") {
        // Durable history replay (v2): frames stamped before this connection
        // may still fix bookkeeping (model map, deletions) but must NEVER
        // produce liveness, retry, or busy state — a replayed session.step.*
        // would otherwise paint a ghost ● on a session that idled days ago.
        if (Number.isFinite(created) && connectEpoch - created > REPLAY_GATE_MS) {
          if (type.startsWith("session.model")) {
            applyModelEvent(sid, data)
            return
          }
          if (type === "session.deleted") forgetSession(sid)
          if (type === "session.created" || type === "session.moved") schedule(MAP_REFRESH_DEBOUNCE_MS)
          return
        }
        // ---- tool lifecycle (BEFORE GEN_RE: session.tool.* matches both) ----
        // v1 frames name the call `toolCallID`; v2's ToolBase names it `id`.
        // Resolving both here keeps the v2 dedupe (called + input.started of
        // one call collapse onto one key) and feeds AutoBG the same identity.
        if (TOOL_END_RE.test(type)) {
          const tcid = typeof data.toolCallID === "string" ? data.toolCallID : typeof data.id === "string" ? data.id : undefined
          const open = toolBusy.get(sid)
          if (open) {
            if (typeof tcid === "string") open.delete(tcid)
            else if (open.size > 0) open.delete([...open.keys()][open.size - 1])
          }
          autoBg.end(sid, tcid)
          lastActivity.set(sid, Date.now())
          dbg(`toolEv end ${type} sid=${sid} open=${open?.size ?? 0}`)
          recomputeRunning()
          schedule(STATUS_DEBOUNCE_MS)
          return
        }
        if (TOOL_START_RE.test(type)) {
          const tcid = typeof data.toolCallID === "string" ? data.toolCallID : typeof data.id === "string" ? data.id : undefined
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
          // AutoBG only touches sessions visible in the model map: parentID
          // children are never mapped (#12 — backgrounding a child would
          // detach it from the parent's stream) and a session born seconds
          // ago is skipped for this one call — later tool calls catch up.
          if (sessionModels.has(sid)) {
            autoBg.start(sid, key, data.name ?? data.tool)
          } else {
            // subagent child or a session not yet mapped (#12 guard). This
            // dbg line is the evidence trail for "it didn't fire" reports:
            // a real foreground session should NEVER show up here more than
            // for its first tool call.
            dbg(`autobg skip unmapped sid=${sid.slice(0, 12)} (child or pre-map session)`)
          }
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
            autoBg.clear(sid) // turn over — a fresh long run may fire again
          }
          dbg(`statusEv ${type} sid=${sid} st=${stType} next=${next ?? "-"}`)
          recomputeRunning()
          schedule(STATUS_DEBOUNCE_MS)
          return
        }
        if (V2_RETRY_RE.test(type)) {
          // v2 rate-limit back-off: the same ↻ semantics the v1 retry status
          // carried. `at` is the provider's own resume epoch — the seat of
          // the ✕ window if this back-off chain dies later.
          const now = Date.now()
          const at = typeof data.at === "number" ? data.at : Number.NaN
          const until = Number.isFinite(at) && at > now && at <= now + RETRY_MARK_MAX_MS
            ? Math.max(retryMark.get(sid) ?? 0, at)
            : Math.max(retryMark.get(sid) ?? 0, now + RETRY_MARK_DEFAULT_MS)
          retryMark.set(sid, until)
          statusKnown.add(sid)
          statusRetry.add(sid)
          statusBusy.delete(sid)
          dbg(`v2 retry sid=${sid} until=${until}`)
          recomputeRunning()
          schedule(STATUS_DEBOUNCE_MS)
          return
        }
        if (V2_EXEC_RE.test(type)) {
          if (type.endsWith("started")) {
            statusKnown.add(sid)
            statusBusy.add(sid)
            statusRetry.delete(sid)
          } else {
            // ended / failed / interrupted: not running. The ✕ mark survives
            // exactly like v1 (retryMark epoch). A failure WITHOUT any
            // back-off event in the chain earns no ✕ at all (#10).
            statusKnown.add(sid)
            statusBusy.delete(sid)
            statusRetry.delete(sid)
            autoBg.clear(sid) // turn over — a fresh long run may fire again
          }
          dbg(`v2 execution ${type.slice(18)} sid=${sid}`)
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
          applyModelEvent(sid, data)
          return
        }
        if (
          type === "session.created" ||
          type === "session.updated" ||
          type === "session.deleted" ||
          type === "session.moved"
        ) {
          if (type === "session.deleted") forgetSession(sid)
          // New/deleted/moved sessions or model switch -> refresh session->model map
          schedule(MAP_REFRESH_DEBOUNCE_MS)
        }
      }
    }

    void (async () => {
      while (!sse.signal.aborted) {
        try {
          // IMPORT-FREE reconnection: built-ins + candidate paths come from
          // the hoisted setup consts (no import() inside this loop — the
          // same node 22 mocked-timer stall that hit the AutoBG fire).
          let url = ""
          let password = ""
          for (const p of serviceCandidatePaths) {
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
          connectEpoch = Date.now()
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
      clearInterval(sweeper)
      clearInterval(autoBgPoll)
      if (timer) clearTimeout(timer)
    }
  },
})
