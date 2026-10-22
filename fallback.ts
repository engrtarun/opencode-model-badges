// ---------------------------------------------------------------------------
// fallback — all-in-one model fallback engine for OpenCode (single file)
// ---------------------------------------------------------------------------
//
// What it does:
//   A model hits a rate limit / quota / usage wall while the session is
//   running? This plugin aborts the stuck turn, remembers the failure on a
//   per-model cooldown, and transparently re-sends the work on the next
//   healthy model from the configured chain. When the original model
//   recovers, the session automatically goes back to it.
//
// Feature set (distilled from the community fallback plugins on GitHub):
//   - error classification: immediate-fallback classes (usage/quota/limit)
//     vs transient classes (rate limit / 5xx) that first let OpenCode's own
//     retry policy max out (configurable `maxRetries`)
//   - ordered fallback chain per provider/model, cycle or stop mode
//   - per-model cooldown that DOUBLES on consecutive failures (capped)
//   - cooldown persistence across restarts (~/.local/share/opencode/)
//   - fresh-fail replays the last user message; mid-run failures send a
//     configurable continue message instead
//   - optional revert of the incomplete assistant turn to keep history clean
//   - toast notifications on every switch; activity-gated auto-recovery
//
// Not implemented (deliberate): TTFT stall timeout, multi-account OAuth
// rotation, and autonomous continue-loops. These live in the TODO list.
//
// Config: ~/.config/opencode/fallback.json  (see fallback.example.json)
// If the file is missing the plugin stays passive — it only logs once and
// never touches sessions.
//
// License: MIT
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ---- tunables ------------------------------------------------------------
const CONFIG_PATHS = [
  process.env.T9_FALLBACK_CONFIG,
  join(homedir(), ".config", "opencode", "fallback.json"),
].filter(Boolean)

const STATE_DIR = join(homedir(), ".local", "share", "opencode")
const STATE_FILE = join(STATE_DIR, "model-fallback-state.json")
const LOG_FILE = join(homedir(), ".config", "opencode", "plugins", "fallback.log")

// Vocabulary classes, assembled from the failure strings OpenCode surfaces.
// IMMEDIATE = the account/subscription wall — extra retries on the same
// model are pointless, switch now.
const IMMEDIATE_RE =
  /usage limit reached|usage-limit|quota(?:\s+exceed|\s+exhausted)?|limit will reset|reached your .* limit|free usage|FreeUsageLimitError|GoUsageLimitError|subscription_sharing|RESOURCE_EXHAUSTED|insufficient (?:credits?|balance)|payment required|account.*(limit|quota)/i
// TRANSIENT = worth letting OpenCode's own retry policy take a few swings first.
const TRANSIENT_RE =
  /rate.?limit|too many requests|429|overloaded|temporar|timeout|timed out|connection|network|5\d\d|server error|gateway/i
// IMMEDIATE classification from status codes alone (billing-class walls).
const IMMEDIATE_CODES = new Set([402, 403])
const TRANSIENT_CODES = new Set([408, 425, 429, 500, 502, 503, 504])

const PROMPT_DELAY_MS = 400
const ABORT_SETTLE_MS = 250

const DEFAULTS = {
  enabled: true,
  // transient failures are retried by OpenCode itself; fall back only after
  // this many retry attempts have already burned through
  maxRetries: 2,
  // base cooldown for a failed model; doubles on each consecutive failure
  cooldownMs: 60_000,
  cooldownCapMs: 60 * 60_000,
  // "cycle" -> wrap around the chain and retry; "stop" -> give up with a toast
  fallbackMode: "cycle",
  // when the original model's cooldown expires and a new prompt starts,
  // put the session back on its original model
  resetOnPrompt: true,
  // try to revert the failed (partial) assistant turn before re-sending
  revertOnFallback: true,
  // sent instead of replaying the user message when the failure happened
  // mid-run (the assistant had already produced output)
  continueMessage: "Continue from where you left off.",
  // ordered chain, entries "provider/model" or { providerID, modelID }
  fallbackModels: [],
}

const dbg = (msg: string) => {
  try {
    // append without holding the file handle across plugin processes
    // (build the line first so failures can't half-write)
    void import("node:fs").then((fs) =>
      fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`),
    )
  } catch {}
}

// A turn's worth of useful cookie-cutter helpers ----------------------------

const modelKey = (m: { providerID: string; modelID: string }) => `${m.providerID}/${m.modelID}`

const parseChain = (raw: unknown) => {
  const out: { providerID: string; modelID: string }[] = []
  if (!Array.isArray(raw)) return out
  for (const e of raw) {
    if (typeof e === "string") {
      const i = e.indexOf("/")
      if (i > 0) out.push({ providerID: e.slice(0, i), modelID: e.slice(i + 1) })
    } else if (
      e &&
      typeof e === "object" &&
      typeof (e as { providerID?: unknown }).providerID === "string" &&
      typeof (e as { modelID?: unknown }).modelID === "string"
    ) {
      out.push(e as { providerID: string; modelID: string })
    }
  }
  return out
}

const classify = (message: unknown, statusCode: unknown) => {
  const code = typeof statusCode === "number" ? statusCode : NaN
  if (IMMEDIATE_CODES.has(code)) return "immediate"
  if (TRANSIENT_CODES.has(code)) return "transient"
  const s = typeof message === "string" ? message : ""
  if (!s) return "unknown"
  if (IMMEDIATE_RE.test(s)) return "immediate"
  if (TRANSIENT_RE.test(s)) return "transient"
  return "unknown" // safety net: treated as retryable
}

export const FallbackPlugin = async ({ client }: { client: unknown }) => {
  // ---- config ------------------------------------------------------------
  let config = { ...DEFAULTS };
  ((): void => {
    for (const p of CONFIG_PATHS) {
      try {
        if (p && existsSync(p)) {
          Object.assign(config, JSON.parse(readFileSync(p, "utf8")))
          break
        }
      } catch (e) {
        dbg(`config read failed for ${p}: ${e}`)
      }
    }
  })()
  if (config.enabled === false) {
    dbg("disabled via config — passive")
    return {}
  }
  const chain = parseChain(config.fallbackModels)
  if (chain.length === 0) {
    dbg(`no fallbackModels in ${CONFIG_PATHS.find((p) => p && existsSync(p)) ?? "?"} — passive`)
    return {}
  }
  dbg(`armed: ${chain.map(modelKey).join(" -> ")}`)

  // ---- state ---------------------------------------------------------------
  type Sess = {
    original: string // modelKey the user chose
    current: string // modelKey the turn is actually using
    inFallback: boolean
    transientFails: number
    activity: boolean
    busy: boolean
  }
  const sessions = new Map<string, Sess>()
  // modelKey -> { until, fails }
  const cooldowns = new Map<string, { until: number; fails: number }>()
  const stats = { fallbacks: 0, switched: 0 }
  const switching = new Set<string>() // per-session mutex

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let lastAttemptAt = 0
  const saveState = () => {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      try {
        mkdirSync(STATE_DIR, { recursive: true })
        writeFileSync(
          STATE_FILE,
          JSON.stringify({
            cooldowns: Object.fromEntries(cooldowns),
            stats,
            savedAt: new Date().toISOString(),
          }),
        )
      } catch (e) {
        dbg(`state save failed: ${e}`)
      }
    }, 1500)
  }
  try {
    if (existsSync(STATE_FILE)) {
      const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as {
        cooldowns?: Record<string, { until: number; fails: number }>
        stats?: { fallbacks?: number; switched?: number }
      }
      for (const [k, v] of Object.entries(raw.cooldowns ?? {})) {
        if (v && typeof v.until === "number") cooldowns.set(k, { until: v.until, fails: v.fails ?? 0 })
      }
      stats.fallbacks = raw.stats?.fallbacks ?? 0
      stats.switched = raw.stats?.switched ?? 0
    }
  } catch (e) {
    dbg(`state load failed: ${e}`)
  }

  const info = async (level: "info" | "warn" | "error", message: string) => {
    dbg(`${level}: ${message}`)
    try {
      await (client as { app?: { log?: (b: object) => Promise<unknown> } }).app?.log?.({
        body: { service: "model-fallback", level, message },
      })
    } catch {}
  }

  const toast = async (message: string, variant: "info" | "warning" | "error" = "warning") => {
    try {
      await (client as {
        tui?: { showToast?: (b: object) => Promise<unknown> }
      }).tui?.showToast?.({ body: { message, variant, title: "fallback" } })
    } catch {}
  }

  const cooled = (key: string, now = Date.now()) => {
    const c = cooldowns.get(key)
    return !c ? 0 : c.until > now ? c.until - now : 0
  }

  const punish = (key: string) => {
    const now = Date.now()
    const prev = cooldowns.get(key)
    const fails = (prev?.fails ?? 0) + 1
    const ms = Math.min(config.cooldownCapMs, config.cooldownMs * 2 ** (fails - 1))
    cooldowns.set(key, { until: now + ms, fails })
    saveState()
    return ms
  }

  const forgive = (key: string) => {
    const c = cooldowns.get(key)
    if (c) cooldowns.delete(key)
    saveState()
  }

  // picks the next healthy entry in the chain relative to `current`
  const pickNext = (current: string) => {
    const now = Date.now()
    const idx = chain.findIndex((m) => modelKey(m) === current)
    const order = chain.map((_, i) => (idx + 1 + i) % chain.length)
    for (const i of order) {
      const k = modelKey(chain[i])
      if (k === current) continue
      if (!cooled(k, now)) return chain[i]
    }
    return null
  }

  const getSeverity = (evt: Record<string, unknown>) => {
    const status = (evt.status ?? {}) as { type?: unknown; attempt?: unknown; message?: unknown }
    if (status.type !== "retry") return undefined
    const attempt = typeof status.attempt === "number" ? status.attempt : 1
    const kind = classify(status.message, undefined)
    return { attempt, kind, message: typeof status.message === "string" ? status.message : "" }
  }

  // extract the last user text + whether the assistant had already produced work
  const lastUserTurn = async (sid: string) => {
    const res = await (client as {
      session?: { messages?: (b: object) => Promise<{ data?: unknown }> }
    }).session?.messages?.({ path: { id: sid } })
    const items = ((res as { data?: unknown[] } | undefined)?.data ?? []) as {
      info?: { role?: string }
      parts?: Array<{ type?: string; text?: string }>
    }[]
    if (!items.length) return null
    let lastUser = -1
    for (let i = 0; i < items.length; i++) if (items[i].info?.role === "user") lastUser = i
    if (lastUser < 0) return null
    const texts: string[] = []
    for (const p of items[lastUser].parts ?? []) if (p.type === "text" && p.text) texts.push(p.text)
    const userText = texts.join("\n") || ""
    const midRun = lastUser < items.length - 1 // assistant works exist after the prompt
    return { userText, midRun }
  }

  const revertPartialTurn = async (sid: string) => {
    const c = client as {
      session?: {
        messages?: (b: object) => Promise<{ data?: unknown }>
        revert?: (b: object) => Promise<unknown>
      }
    }
    try {
      const res = await c.session?.messages?.({ path: { id: sid } })
      const items = ((res?.data ?? []) as { info?: { role?: string; id?: string } }[])
      const lastAssistant = [...items].reverse().find((m) => m.info?.role === "assistant")
      if (lastAssistant?.info?.id) {
        await c.session?.revert?.({ path: { id: sid }, body: { messageID: lastAssistant.info.id } })
      }
    } catch (e) {
      dbg(`revert skipped: ${e}`)
    }
  }

  const attemptFallback = async (sid: string, failedKey: string, reason: string) => {
    // one fallback per session at a time; also don't re-fire for the same
    // retry storm
    if (switching.has(sid)) return
    const now = Date.now()
    if (now - lastAttemptAt < 1_500) return
    const sess = sessions.get(sid)
    if (!sess || !sess.busy) return
    // only orchestrate models that are part of the chain — anything else is
    // OpenCode's own retry business
    if (!chain.some((m) => modelKey(m) === failedKey)) return
    switching.add(sid)
    lastAttemptAt = now
    try {
      const target = pickNext(failedKey)
      if (!target) {
        if (config.fallbackMode === "stop") {
          await toast(`fallback chain exhausted (${reason}) — stopping`, "error")
          await info("warn", `chain exhausted for ${sid}: ${reason}`)
          return
        }
        // cycle mode: everything is cooling — punish harder and let core retry
        punish(failedKey)
        await toast(`models cooling down — ${reason}`, "info")
        return
      }
      const ms = punish(failedKey)
      await info("warn", `fallback ${failedKey} -> ${modelKey(target)} (${reason}); ${failedKey} cooling ${Math.round(ms / 1000)}s`)
      // 1. abort the stuck turn
      try {
        await (client as { session?: { abort?: (b: object) => Promise<unknown> } }).session?.abort?.({
          path: { id: sid },
        })
      } catch (e) {
        dbg(`abort: ${e}`)
      }
      await new Promise((r) => setTimeout(r, ABORT_SETTLE_MS))
      // 2. decide what to re-send
      const turn = await lastUserTurn(sid).catch(() => null)
      if (!turn || !turn.userText) {
        await info("error", `${sid}: no user message found to replay`)
        return
      }
      if (config.revertOnFallback) await revertPartialTurn(sid)
      const text = turn.midRun ? config.continueMessage : turn.userText
      // 3. re-send on the fallback model (session follows the new model)
      const send = (client as {
        session?: { prompt?: (b: object) => Promise<unknown> }
      }).session?.prompt?.({
        path: { id: sid },
        body: {
          model: { providerID: target.providerID, modelID: target.modelID },
          parts: [{ type: "text", text }],
        },
      })
      if (send) void send.catch((e: unknown) => dbg(`re-prompt: ${e}`))
      sess.inFallback = true
      sess.current = modelKey(target)
      stats.fallbacks++
      stats.switched++
      saveState()
      await toast(`↻ ${failedKey} -> ${modelKey(target)}`)
    } finally {
      // give the re-sent prompt a beat before allowing the next decision
      setTimeout(() => switching.delete(sid), 2_500)
    }
  }

  const findSessionModel = async (sid: string): Promise<string | null> => {
    const res = await (client as {
      session?: { get?: (b: object) => Promise<{ data?: unknown }> }
    }).session?.get?.({ path: { id: sid } })
    const data = (res?.data ?? {}) as { model?: { providerID?: string; modelID?: string } }
    if (data.model?.providerID && data.model?.modelID) return `${data.model.providerID}/${data.model.modelID}`
    return null
  }

  return {
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      try {
        const p = (event.properties ?? {}) as Record<string, unknown>
        const sid = typeof p.sessionID === "string" ? p.sessionID : undefined
        if (event.type === "session.status" && sid) {
          const st = (p.status ?? {}) as { type?: string }
          if (st.type === "busy") {
            let sess = sessions.get(sid)
            if (!sess || !sess.busy) {
              // a NEW user turn is starting: honour resetOnPrompt and
              // re-anchor the session to its original model when it's healthy
              let key = sess?.current ?? (await findSessionModel(sid)) ?? ""
              if (sess?.inFallback && config.resetOnPrompt) {
                const orig = sess.original
                if (!cooldowns.has(orig) && cooled(orig) === 0) key = orig
              }
              sessions.set(sid, {
                original: sess?.original ?? key,
                current: key,
                inFallback: false,
                transientFails: 0,
                activity: false,
                busy: true,
              })
            }
            return
          }
          if (st.type === "retry") {
            const sev = getSeverity(p)
            if (!sev) return
            const sess = sessions.get(sid)
            const current = sess?.current ?? (await findSessionModel(sid)) ?? ""
            if (!current) return
            if (!sess) {
              sessions.set(sid, {
                original: current,
                current,
                inFallback: false,
                transientFails: 0,
                activity: false,
                busy: false,
              })
            }
            const s = sessions.get(sid)!
            if (sev.kind !== "immediate" && sev.attempt <= config.maxRetries) {
              s.transientFails++
              return // let OpenCode's own policy keep trying
            }
            await attemptFallback(sid, current, `${sev.kind}: ${sev.message.slice(0, 80)}`)
            return
          }
          if (st.type === "idle") {
            const sess = sessions.get(sid)
            if (sess?.busy && sess.inFallback && sess.activity) forgive(sess.current) // it worked
            sessions.delete(sid)
          }
          return
        }
        if (event.type === "session.error" && sid) {
          const err = (p.error ?? {}) as { statusCode?: unknown; message?: unknown }
          const kind = classify(
            typeof err.message === "string" ? err.message : undefined,
            err.statusCode,
          )
          if (kind === "immediate") {
            const sess = sessions.get(sid)
            const current = sess?.current ?? (await findSessionModel(sid)) ?? ""
            if (current) await attemptFallback(sid, current, "session.error immediate")
          }
          return
        }
        if (sid && (event.type === "message.part.updated" || event.type === "message.updated")) {
          const sess = sessions.get(sid)
          if (sess) sess.activity = true
          return
        }
        if (event.type === "session.deleted" && typeof sid === "string") {
          sessions.delete(sid)
        }
      } catch (e) {
        dbg(`event ${event.type}: ${e}`)
      }
    },
  }
}
export default FallbackPlugin
