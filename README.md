# ✅ opencode-model-badges

> **Live session badges on every model name — right inside the OpenCode model picker.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-7c3aed.svg)](https://opencode.ai)
[![Version](https://img.shields.io/badge/version-0.1.0-green.svg)](https://github.com/engrtarun/opencode-model-badges/releases)
[![Zero-child-process](https://img.shields.io/badge/child%20processes-0-brightgreen.svg)](#-how-it-works)
[![SSE](https://img.shields.io/badge/events-SSE%20stream-orange.svg)](#-how-it-works)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Do you run 5-7 chat sessions at once and lose track of which model is busy and which is idle? This plugin appends a **live badge** to every model name in the picker:

```
┌─ model picker ────────────────────────────────┐
│  MiMo-V2.6-Flash Free ✔️ [3]   ← 3 sessions   │
│  DeepSeek V4.1 Flash Free ✅   ← 1 session    │
│  GLM-5.3 Flash Free              ← idle       │
│  Big Pickle ✅                  ← 1 session   │
└───────────────────────────────────────────────┘
```

| Badge | Meaning |
| :---- | :----- |
| *(nothing)* | No session is currently running on that model |
| `✅` green tick | Exactly **1** chat session is running |
| `✔️ [N]` blue tick + count | **N (2+)** sessions are running on the same model in parallel |

> **Only currently running sessions are counted — never history.** A model earns a badge only while it is actively working.

---

## 📦 Install

**Option A — plugins folder (recommended):**

```powershell
# Windows
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.config\opencode\plugins\model-badges" | Out-Null
Copy-Item index.ts, package.json "$env:USERPROFILE\.config\opencode\plugins\model-badges\"
```

```bash
# macOS / Linux
mkdir -p ~/.config/opencode/plugins/model-badges
cp index.ts package.json ~/.config/opencode/plugins/model-badges/
```

**Option B — config reference** (add to your `opencode.jsonc`):

```jsonc
{
  "plugin": ["C:/path/to/opencode-model-badges/index.ts"]
}
```

**Reload:** just touch the `LastWriteTime` of `opencode.jsonc` (or restart OpenCode) — the plugin loads instantly:

```powershell
(Get-Item "$env:USERPROFILE\.config\opencode\opencode.jsonc").LastWriteTime = Get-Date
```

**Uninstall:** delete the `plugins\model-badges` folder — done. No config entries, no registry, no background service.

---

## 🚀 Use cases

- **Multi-agent workflows** — 5-7 agents run on different models in parallel; open the picker and instantly see each model's load.
- **Free-model rotation** — a free model got rate-limited? Its badge disappears — switch to a free one immediately.
- **Stuck session detection** — a session building for 10 minutes keeps its `✅` on the same model (tool-call aware).
- **Fair model choice** — when opening a new session, pick a model that is not already overloaded.
- **Live status board** — the model picker doubles as a dashboard; no separate monitoring tool needed.

---

## ⚙️ How it works

```
┌────────────────────────┐   SSE stream (fetch, localhost)   ┌─────────────────────┐
│  OpenCode server       │ ────────────────────────────────▶ │  model-badges plugin │
│  GET /api/event        │   session.status / *.delta /      │                     │
│                        │   session.tool.* / usage.updated  │  runningCount map   │
└────────────────────────┘                                   └──────────┬──────────┘
                                                                        │ ctx.model.transform()
                                                             ┌──────────▼──────────┐
                                                             │  model name + badge  │
                                                             │  "DeepSeek ✅"       │
                                                             └─────────────────────┘
```

- **Events:** the server's SSE endpoint (`/api/event`) is read with plain `fetch()` — **no child processes, no terminal flash, no external dependencies**.
- **Liveness logic (three layers, combined):**
  1. **Authoritative** — `session.status` events (`busy` / `retry` / `idle`).
  2. **Activity TTL** — generation-stream events (`.delta`, `session.step.*`, `session.tool.*`, `usage.updated`) keep a badge alive for 15 seconds.
  3. **Tool-call tracking** — during a long build/script the model goes silent; open tool calls are tracked by `toolCallID` so the badge survives (max 10-minute safety cap).
- **Accuracy safety:** stale "idle" marks are overridden by fresh activity, deleted sessions have all state cleaned, and a 10-minute safety refresh catches missed events.
- **Badge hygiene:** names are rebuilt from the bare name every transform (old suffix stripped, new suffix appended) — double badges or stuck badges are impossible.
- **Tuning:** constants at the top of `index.ts` — `ACTIVITY_TTL_MS`, `STATUS_DEBOUNCE_MS`, `TOOL_MAX_MS`, `MIN_MULTI`.

---

## ❓ FAQ

**Q. Why isn't the badge instant?**
Updates are pushed after a ~0.5s debounce. Updating per-token would reload the picker constantly and make it flicker — this is the sweet spot.

**Q. What's the difference between the green and blue tick?**
Green `✅` = a single session. Blue `✔️ [N]` = N parallel chats on the same model (U+2714 renders blue in Windows Segoe UI Emoji — free design).

**Q. Does history count?**
No — only *currently running* sessions count. Old sessions never earn a badge.

**Q. How do I debug?**
`~/.config/opencode/plugins/model-badges/debug.log` contains `map: running=[...]` lines showing the live state.

**Q. Does it work with any provider/model?**
Yes — the plugin only transforms model *names*, so any provider is supported.

---

## 🤝 Contributing

Issues and PRs are welcome! `index.ts` is a single file, so it's easy to read. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow. Good-first-issue ideas live on the [Issues page](https://github.com/engrtarun/opencode-model-badges/issues).

## 📄 License

[MIT](LICENSE) © [engrtarun](https://github.com/engrtarun)

---

Made with ❤️ for OpenCode power users. Star ⭐ if it saved you a "which model is busy right now?" moment!
