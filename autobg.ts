// ---------------------------------------------------------------------------
// autobg — AutoBG: auto-move long-running sessions to background (Ctrl+B)
// ---------------------------------------------------------------------------
//
// What it does:
//   A session whose TOOL calls keep it blocked for longer than 2 minutes would
//   normally occupy the foreground until the user presses Ctrl+B. This module
//   automates exactly that:
//
//     T-30s  toast "AutoBG: 30s — `bash` will move to background"   (once)
//      T=0   POST /api/session/{sid}/background  (the Ctrl+B operation)
//            toast "AutoBG: moved to background (ran 2m01s)"          (once)
//
// What it NEVER touches:
//   - Model-chat-only runs (no open tool call => no tracker entry => no fire).
//   - Sessions that finished their tool call before the threshold, or were
//     backgrounded already (one request per session turn, cleared at the
//     turn's end: session.execution.* / idle / deleted).
//
// Engine wiring (probes + sources, 2026-10):
//   - Backgrounding does NOT kill tools: v2 keeps shells/subagents running
//     outside the blocking view (app/src/session/requests/background.ts).
//   - The operation is POST /api/session/{id}/background -> 204
//     (client/src/promise/generated/client.ts L930-934).
//   - Tool lifecycle (schema/src/session-event.ts):
//       session.tool.input.started { sessionID, id, name }   // clock starts
//       session.tool.called { sessionID, id }                // deduped by id
//       session.tool.success | session.tool.failed           // clock stops
//
// Design:
//   - Pure state machine. IO (toast / background / clock) is injected by
//     index.ts, so the trigger logic is unit-testable with fake timers.
//   - The OLDEST open tool call drives the countdown: one long build while
//     short tools interleave still reaches the threshold; three consecutive
//     60s calls never will (each call's own clock resets on its end event).

const THRESHOLD_MS = 120_000
const WARN_BEFORE_MS = 30_000
// A tool that never reported its end after this long is considered a missed
// event (the engine kills tools eventually); stop threatening and drop it.
const CAP_MS = 10 * 60_000

export interface AutoBgDeps {
  now?: () => number
  toast?: (message: string, variant: "info" | "success" | "warning" | "error", title?: string) => unknown
  background?: (sessionID: string) => Promise<unknown>
  dbg?: (msg: string) => void
}

type OpenCall = { name: string; startedAt: number }

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`
}

export function createAutoBg(deps: AutoBgDeps = {}) {
  const now = deps.now ?? (() => Date.now())
  const background = deps.background ?? (async () => {})
  const dbg = deps.dbg ?? (() => {})
  const toast = deps.toast ?? (async () => {})

  // sessionID -> ordered callID -> open call (insertion order = v1 "last" fallback)
  const open = new Map<string, Map<string, OpenCall>>()
  // one warn toast + one background request per session turn
  const warned = new Set<string>()
  const requested = new Set<string>()

  const start = (sid: string, callID: unknown, name: unknown) => {
    if (!sid) return
    let map = open.get(sid)
    if (!map) {
      map = new Map()
      open.set(sid, map)
    }
    // session.tool.called re-fires input.started's call — dedupe by key
    // (mirrors index.ts's toolBusy Map semantics)
    const key = typeof callID === "string" && callID ? callID : `anon:${now()}:${map.size}`
    if (map.has(key)) return
    map.set(key, {
      name: typeof name === "string" && name ? name : "tool",
      startedAt: now(),
    })
    dbg(`autobg start sid=${sid.slice(0, 12)} call=${key.slice(0, 10)} open=${map.size}`)
  }

  const end = (sid: string, callID: unknown) => {
    const map = open.get(sid)
    if (!map) return
    if (typeof callID === "string" && callID) map.delete(callID)
    else if (map.size > 0) map.delete([...map.keys()][map.size - 1])
    if (map.size === 0) {
      open.delete(sid)
      warned.delete(sid)
      requested.delete(sid) // every open call ended — re-arm for the next turn
      dbg(`autobg clear-open sid=${sid.slice(0, 12)}`)
    }
  }

  const clear = (sid: string) => {
    const had = open.delete(sid)
    warned.delete(sid)
    requested.delete(sid) // turn ended — a new long run may fire again
    if (had) dbg(`autobg reset sid=${sid.slice(0, 12)}`)
  }

  // Drives the countdown; index.ts polls this every second.
  const poll = (t: number = now()): string[] => {
    const fired: string[] = []
    for (const [sid, map] of open) {
      if (map.size === 0) {
        open.delete(sid)
        continue
      }
      let oldest: OpenCall | undefined
      for (const c of map.values()) if (!oldest || c.startedAt < oldest.startedAt) oldest = c
      if (!oldest) continue
      const age = t - oldest.startedAt

      if (age > CAP_MS) {
        // missed end event: stand down, never background on a zombie clock
        map.clear()
        open.delete(sid)
        warned.delete(sid)
        dbg(`autobg cap sid=${sid.slice(0, 12)} age=${Math.round(age / 1000)}s`)
        continue
      }
      if (age >= THRESHOLD_MS) {
        if (requested.has(sid)) continue
        requested.add(sid)
        fired.push(sid)
        dbg(`autobg fire sid=${sid.slice(0, 12)} age=${fmt(age)}`)
        void Promise.resolve()
          .then(() => background(sid))
          .then(
            () => void toast(`AutoBG: moved to background (ran ${fmt(age)})`, "success"),
            (e) => dbg(`autobg background failed: ${e}`),
          )
        continue
      }
      const left = THRESHOLD_MS - age
      if (left <= WARN_BEFORE_MS && !warned.has(sid)) {
        warned.add(sid)
        dbg(`autobg warn sid=${sid.slice(0, 12)} left=${Math.round(left / 1000)}s`)
        void toast(`AutoBG: ${Math.round(left / 1000)}s — "${oldest.name}" moves to background automatically`, "info")
      }
    }
    return fired
  }

  return {
    start,
    end,
    clear,
    poll,
    stats: () => ({ open: open.size, warned: warned.size, requested: requested.size }),
  }
}

export const AUTOBG = { THRESHOLD_MS, WARN_BEFORE_MS, CAP_MS }
