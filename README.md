# ✅ opencode-model-badges

> **Live session badges on every model name — right inside the OpenCode model picker.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-7c3aed.svg)](https://opencode.ai)
[![Version](https://img.shields.io/badge/version-0.1.0-green.svg)](https://github.com/engrtarun/opencode-model-badges/releases)
[![Zero-child-process](https://img.shields.io/badge/child%20processes-0-brightgreen.svg)](#-how-it-works)
[![SSE](https://img.shields.io/badge/events-SSE%20stream-orange.svg)](#-how-it-works)

Kya aapke paas bhi ek saath **5 chat sessions** chalte hain — aur aapko pata hi nahi chalta kaun sa model kabhi busy hai aur kaun sa kab se mara pada hai? Yeh plugin har model name ke peeche **live badge** laga deta hai:

```
┌─ model picker ────────────────────────────────┐
│  MiMo-V2.6-Flash Free ✔️ [3]   ← 3 sessions   │
│  DeepSeek V4.1 Flash Free ✅   ← 1 session    │
│  GLM-5.3 Flash Free              ← idle       │
│  Big Pickle ✅                  ← 1 session   │
└───────────────────────────────────────────────┘
```

| Badge | Matlab |
| :---- | :----- |
| *(kuch nahi)* | Us model pe koi session **nahi chal raha** |
| `✅` **green tick** | Exactly **1 chat session** abhi chal raha hai |
| `✔️ [N]` **blue tick + count** | **N (2+) sessions** ek saath chal rahe hain |

> **Sirf live sessions count hote hain — history kabhi nahi.** Jo model abhi kaam kar rahi hai wahi badge paati hai.

---

## 📦 Install

**Option A — plugins folder (recommended):**

```powershell
# Windows
mkdir "$env:USERPROFILE\.config\opencode\plugins\model-badges" -Force
copy index.ts, package.json "$env:USERPROFILE\.config\opencode\plugins\model-badges\"
```

```bash
# macOS / Linux
mkdir -p ~/.config/opencode/plugins/model-badges
cp index.ts package.json ~/.config/opencode/plugins/model-badges/
```

**Option B — config reference** (apne `opencode.jsonc` me):

```jsonc
{
  "plugin": ["C:/path/to/opencode-model-badges/index.ts"]
}
```

**Reload:** bas `opencode.jsonc` ka `LastWriteTime` touch karo (ya OpenCode restart) — plugin turant load ho jaata hai:

```powershell
(Get-Item "$env:USERPROFILE\.config\opencode\opencode.jsonc").LastWriteTime = Get-Date
```

**Uninstall:** `plugins\model-badges` folder delete — done. Koi config entry, koi registry, koi service nahi.

---

## 🚀 Use cases

- **Multi-agent papad** — aapke 5-7 agents alag models pe parallel chalte hain; picker kholte hi dikhta hai kiska load kitna hai.
- **Free-model rotation** — ek free model rate-limit me gaya? Turant pata chalega (uska badge hatta hai) — doosre pe shift ho jao.
- **Stuck session detection** — koi session 10 minute se build chala raha hai? Uska `✅` usi model pe bana rehta hai (tool-call aware).
- **Fair model choice** — jab tum naya session kholo, dekh lo kaun sa model already overloaded hai, kaun sa khali hai.
- **Kid-safe dashboard** — model picker hi ban jaata hai ek live status board; alag monitoring tool ki zaroorat nahi.

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

- **Events:** server ka SSE endpoint (`/api/event`) seedhe `fetch()` se padha jaata hai — **koi child process nahi**, koi terminal flash nahi, koi external dependency nahi.
- **Liveness logic (teen layer, ek saath):**
  1. **Authoritative** — `session.status` (`busy`/`retry`/`idle`) events.
  2. **Activity TTL** — generation-stream events (`.delta`, `session.step.*`, `session.tool.*`, `usage.updated`) → 15 second tak badge zinda.
  3. **Tool-call tracking** — lambi build/script ke dauran model chup ho jaata hai; `toolCallID` based open-call tracking badge ko tab tak bachata hai (max 10 min safety cap).
- **Accuracy safety:** stale "idle" marks ko fresh activity override karti hai, deleted sessions ka saara state clean hota hai, aur 10 min ka safety refresh missed events ko bhi pakad leta hai.
- **Badge hygiene:** naam har baar bare name se dobara banta hai (purana suffix strip → naya suffix) — kabhi double-badge ya stuck-badge mumkin nahi.
- **Tuning:** `index.ts` ke top pe constants — `ACTIVITY_TTL_MS`, `STATUS_DEBOUNCE_MS`, `TOOL_MAX_MS`, `MIN_MULTI`.

---

## ❓ FAQ

**Q. Badge turant kyo nahi dikhta?**
Updates ~0.5s debounce ke baad push hote hain. Isse pehle har token pe reload hota aur picker flicker karta — yehi sweet spot hai.

**Q. Green aur blue tick ka farq?**
Green `✅` = solo session. Blue `✔️ [N]` = ek hi model pe N parallel chats (Windows Segoe UI Emoji me U+2714 blue render hota hai — free ka design).

**Q. History count?**
Nahi — sirf *abhi chal rahe* sessions count hote hain. Purane sessions badge nahi banate.

**Q. Debug kaise karun?**
`~/.config/opencode/plugins/model-badges/debug.log` me `map: running=[...]` lines aati hain — wahin live state dekh sakte ho.

**Q. Mera provider/ model list supported hai?**
Haan — plugin kisi bhi provider ke models pe kaam karta hai, kyunki wo sirf model *names* transform karta hai.

---

## 🤝 Contributing

Issues aur PRs welcome! `index.ts` ek hi file hai — samajhna easy hai. Badges/UX ideas ke liye issue kholo.

## 📄 License

[MIT](LICENSE) © [engrtarun](https://github.com/engrtarun)

---

Made with ❤️ for OpenCode power users. Star ⭐ if it saved you a "kaun sa model busy hai?" wali confusion!
