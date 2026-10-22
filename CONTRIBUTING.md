# Contributing to opencode-model-badges

Thanks for your interest! This is a small, single-file plugin (`index.ts`), so it's easy to get started.

## Ground rules

- **Zero-RAM footprint.** Never buffer entire files in memory, never spawn child processes, never write config. State stays on disk (SQLite) or in-process ephemeral state only.
- **No Python.** The whole repo is TypeScript + Node. No `pip`, no `venv`.
- **Svelte/Tailwind are not relevant here** — this repo is the plugin only, not the desktop app.
- Keep changes focused. One PR = one concern.

## Getting set up

1. Fork & clone:
   ```bash
   git clone https://github.com/<you>/opencode-model-badges.git
   cd opencode-model-badges
   ```
2. Install OpenCode locally (see the [OpenCode docs](https://opencode.ai)).
3. Copy the plugin into your OpenCode plugins folder so you can test live:
   ```powershell
   # Windows
   Copy-Item index.ts, package.json "$env:USERPROFILE\.config\opencode\plugins\model-badges\"
   ```
   ```bash
   # macOS / Linux
   cp index.ts package.json ~/.config/opencode/plugins/model-badges/
   ```
4. Touch `opencode.jsonc` to reload and watch `debug.log`.

## Running checks

`npm test` runs the dependency-free Node built-in suite (badge stripping, badge selection, running/retry/exhausted counting). Node 22.6+ is all you need — no install step:

```bash
npm test
```

- Keep TypeScript strict; `npx tsc --noEmit` needs the OpenCode plugin types in scope.
- Manual smoke test: run 2 sessions on the same model → expect `● [2]`; a rate-limited session shows `↻`; after retries are exhausted the model keeps `✕` until the provider's reset.

## Submitting a PR

1. Create a branch: `git checkout -b feat/short-description`.
2. Make your change + update the README if behavior changes.
3. Commit with a clear message (Conventional Commits preferred: `feat:`, `fix:`, `docs:`, `chore:`).
4. Push and open a PR against `main`. Fill in the PR template (what / why / how tested).
5. Be patient — this is a hobby project maintained in spare time.

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) (or just open an issue). Please include:
- OpenCode version
- OS + terminal
- Relevant lines from `debug.log`
- Steps to reproduce

## Code style

- 2-space indentation, single quotes not required, semicolons yes.
- Prefer `const`/`let`, arrow functions, early returns.
- Comment the *why*, not the *what* — the code already says what.
- Keep `index.ts` readable: it's the whole product.

## License

By contributing you agree your changes are licensed under the [MIT License](LICENSE).
