# Publicity drafts — v0.4.3 (copy-paste ready)

## 1) X / Twitter post (one in-280-chars punchy)

your opencode session's 5-min build hijacks the whole UI?

🛰️ AutoBG moves it itself:
• tool > 1min → auto Ctrl+B
• "15s left" toast before the move
• your tool keeps running
• multi-agent safe (6 processes → 1 move)

zero deps · 35 tests · MIT
https://github.com/engrtarun/opencode-model-badges

## 2) Discord (opencode #show-and-tell / plugins channel)

🛰️ **model-badges v0.4.3 — sessions now background themselves**

Ever lost the foreground to a shell tool that ran 6 minutes? AutoBG moves the session to background automatically — the exact operation Ctrl+B runs:

• tool call runs > 1 min → auto move (`POST /api/session/{id}/background`)
• T-15s toast: `AutoBG: 15s — "bash" moves to background automatically`
• your tool **keeps running** — backgrounding never kills tools (engine's own contract)
• tools-only scope: model thinking/writing is never touched
• multi-agent safe: NTFS-atomic fire lock → 6 OpenCode processes, exactly 1 move
• subagent children are never detached (#12 guard), 10-min zombie cap
• 35 tests green on node 22 + node 24, **zero dependencies**

To my knowledge the first OpenCode plugin that auto-backgrounds sessions (checked: zenobi-us/opencode-background = manual process mgmt, Mte90/opencode-auto-resume = stall recovery only) 🙏

Install = copy 4 files + restart: https://github.com/engrtarun/opencode-model-badges

## 3) Pin steps (web-UI only — GitHub API has no discussion-pin mutation)

1. https://github.com/engrtarun/opencode-model-badges/discussions/14 kholo
2. Right sidebar (Scroll down) → **Pin discussion** click
3. Done — repo home page pe pinned list me chala jayega

(.opencode plugins discussion #14 hai — "Model badges / multi-agent liveness" wala)
