const MIN_MULTI = 2

// Strip current badges and legacy suffixes so names never accumulate them.
const SUFFIX_RE = /(?:\s+(?:\u2705(?:\s*\d+x)?|\u2B50|\u2714\uFE0F\s*\[\d+\]|\?\?(?:\s*\[\d+\])?|\?))+\s*$/u

export function stripBadge(name: string): string {
  return name.replace(SUFFIX_RE, "")
}

// Match the current UI; legacy question-mark suffixes are accepted only when stripping.
export function pickBadge(count: number): string {
  if (count === 1) return " \u2705"
  if (count >= MIN_MULTI) return ` \u2714\uFE0F [${count}]`
  return ""
}

type RunningState = {
  sessionModels: ReadonlyMap<string, string>
  statusBusy: ReadonlySet<string>
  statusKnown: ReadonlySet<string>
  lastActivity: ReadonlyMap<string, number>
  toolBusy: ReadonlyMap<string, ReadonlyMap<string, number>>
  now: number
  activityTtlMs: number
  toolMaxMs: number
}

// A session may have both a busy status and fresh activity. Count session IDs
// once before reducing them to model keys, or one chat can show a multi badge.
export function countRunningModels({
  sessionModels,
  statusBusy,
  statusKnown,
  lastActivity,
  toolBusy,
  now,
  activityTtlMs,
  toolMaxMs,
}: RunningState): Map<string, number> {
  const activeSessions = new Set(statusBusy)

  for (const [id, timestamp] of lastActivity) {
    if (statusKnown.has(id)) continue
    const open = toolBusy.get(id)
    const oldest = open && open.size > 0 ? Math.min(...open.values()) : Infinity
    const toolOpen = open !== undefined && open.size > 0 && now - oldest < toolMaxMs
    if (!toolOpen && now - timestamp > activityTtlMs) continue
    activeSessions.add(id)
  }

  // Sessions whose only signal is an open tool (no activity entry yet).
  for (const [id, open] of toolBusy) {
    if (open.size === 0 || lastActivity.has(id) || statusKnown.has(id)) continue
    if (now - Math.min(...open.values()) >= toolMaxMs) continue
    activeSessions.add(id)
  }

  const counts = new Map<string, number>()
  for (const id of activeSessions) {
    const model = sessionModels.get(id)
    if (model) counts.set(model, (counts.get(model) ?? 0) + 1)
  }
  return counts
}
