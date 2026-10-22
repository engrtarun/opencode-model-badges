// ---------------------------------------------------------------------------
// lib — pure helpers for the badge system, extracted from the plugin so they
// can be exercised by `npm test` without loading the OpenCode runtime.
//
// The v0.1.x suffix regex was double-escaped and never stripped
// already-rendered badges, and a single session could be double-counted when
// its busy status and a fresh activity event overlapped — both found
// independently by @xmejl (PR #5). Ported here to the v0.2.x system:
// ● (running), ● [N] (multi), ↻ (rate-limited), ✕ (limit exhausted).
//
// License: MIT
// ---------------------------------------------------------------------------

const MIN_MULTI = 2

// Strips every badge we may have appended, so names can never accumulate:
// "X ● [3] ✅ ✔️ [4] ↻ ✕" is impossible. (Legacy ✅/✔️/⭐ kept so an old
// build's names get cleaned up by a newer one on the first transform.)
export const SUFFIX_RE =
  /(?:\s+(?:✅(?:\s*\d+x)?|⭐|✔️\s*\[\d+\]|●(?:\s*\[\d+\])?|↻|✕))+\s*$/u

export function stripBadge(name: string): string {
  return name.replace(SUFFIX_RE, "")
}

// Badge priority: actually running wins, then rate-limited, then exhausted.
export function pickBadge(running: number, retrying = 0, exhausted = false): string {
  if (running >= MIN_MULTI) return ` ● [${running}]`
  if (running === 1) return " ●"
  if (retrying > 0) return " ↻"
  if (exhausted) return " ✕"
  return ""
}

export type CountState = {
  sessionModels: Map<string, string>
  statusBusy: ReadonlySet<string>
  statusRetry: ReadonlySet<string>
  statusKnown: ReadonlySet<string>
  // mutated: expired retry marks are pruned in place, mirroring the live plugin
  retryMark: Map<string, number>
  lastActivity: ReadonlyMap<string, number>
  toolBusy: ReadonlyMap<string, ReadonlyMap<string, number>>
  now: number
  activityTtlMs: number
  toolMaxMs: number
}

// Count session IDs before reducing them to model keys — a session with both
// an authoritative busy status and fresh generation activity must never
// become two counts.
export function countRunningModels({
  sessionModels,
  statusBusy,
  statusRetry,
  statusKnown,
  retryMark,
  lastActivity,
  toolBusy,
  now,
  activityTtlMs,
  toolMaxMs,
}: CountState): {
  running: Map<string, number>
  retrying: Map<string, number>
  exhausted: Set<string>
} {
  const running = new Map<string, number>()
  const retrying = new Map<string, number>()
  const exhausted = new Set<string>()
  const bump = (m: Map<string, number>, k: string | undefined) => {
    if (!k) return
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  for (const id of statusBusy) bump(running, sessionModels.get(id))
  // Fallback: fresh generation events OR an open (long-running) tool call
  for (const [id, ts] of lastActivity) {
    if (statusKnown.has(id)) continue // authoritative status exists — trust only it
    const open = toolBusy.get(id)
    const oldest = open && open.size > 0 ? Math.min(...open.values()) : Infinity
    const toolOpen = open !== undefined && open.size > 0 && now - oldest < toolMaxMs
    if (!toolOpen && now - ts > activityTtlMs) continue
    bump(running, sessionModels.get(id))
  }
  // Sessions whose ONLY signal is an open tool (no activity entry yet)
  for (const [id, open] of toolBusy) {
    if (open.size === 0) continue
    if (lastActivity.has(id) || statusKnown.has(id)) continue
    if (now - Math.min(...open.values()) >= toolMaxMs) continue
    bump(running, sessionModels.get(id))
  }
  // Retry sessions: rate-limited, backing off — shown as ↻ on the model
  for (const id of statusRetry) {
    const k = sessionModels.get(id)
    if (!k) continue
    retrying.set(k, (retrying.get(k) ?? 0) + 1)
  }
  // Exhausted marks: the mark survives until `until`; it is suppressed
  // wherever the model is actually running or still retrying.
  for (const [id, until] of retryMark) {
    if (now >= until) {
      retryMark.delete(id)
      continue
    }
    const k = sessionModels.get(id)
    if (!k || running.has(k) || retrying.has(k)) continue
    exhausted.add(k)
  }
  return { running, retrying, exhausted }
}
