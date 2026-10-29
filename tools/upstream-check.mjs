// ---------------------------------------------------------------------------
// upstream-check — silent watcher for the repositories whose feature set
// feeds model-badges. No submodules, no clones, no Watch required: a cron
// job compares each repo's HEAD sha against the snapshot recorded in
// upstream.json and opens ONE issue (per changed repo) in this repository
// when upstream moves. To upgrade, update the sha in upstream.json.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, "..", "upstream.json"), "utf8"))

const API = "https://api.github.com"
const OWNER = process.env.GITHUB_REPOSITORY_OWNER ?? "engrtarun"
const THIS_REPO = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "opencode-model-badges"
const TOKEN =
  process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ""

const gh = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "User-Agent": "model-badges-upstream-check",
      Accept: "application/vnd.github+json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> HTTP ${res.status}`)
  return res.json()
}

const changed = []
const silent = []
for (const entry of manifest.repositories) {
  const { repo, sha: snapshot } = entry
  try {
    const head = await gh(`/repos/${repo}/commits/HEAD`)
    const current = head.sha.slice(0, 10)
    entry.lastSeen = current
    entry.lastSeenDate = head.commit.committer.date
    if (!snapshot) {
      entry.sha = current // first run records the baseline silently
      continue
    }
    if (current === snapshot) continue
    // A sha change alone is NOT proof of content: repositories that rebase or
    // force-push (CI-stamped sha daily churn) look "moved" while the tree is
    // identical. Confirm with a real compare — issues are only for actual
    // fast-forward content; same-sha rewrites are recorded silently.
    try {
      const cmp = await gh(`/repos/${repo}/compare/${snapshot}...HEAD`)
      if (cmp.ahead_by > 0 || (cmp.files ?? []).length > 0) {
        changed.push({ repo, from: snapshot, to: current, url: head.html_url })
        entry.sha = current // ahead of the issue body so the manifest stays fresh
      } else {
        silent.push({ repo, from: snapshot, to: current })
        entry.sha = current
      }
    } catch {
      // compare unavailable (renamed repo, deleted branch) — fall back to the
      // historical behaviour so a real move never slips through unnoticed
      changed.push({ repo, from: snapshot, to: current, url: head.html_url })
      entry.sha = current
    }
  } catch (e) {
    console.error(`check failed for ${repo}: ${e.message}`)
  }
}

// only issues that are still OPEN block duplicates; closed ones mean a human
// reviewed the last change, so a new movement deserves a fresh issue
const openIssues = await gh(
  `/repos/${OWNER}/${THIS_REPO}/issues?state=open&per_page=100`,
).catch(() => [])

for (const c of changed) {
  const marker = `[upstream] ${c.repo} moved`
  if (openIssues.some((i) => (i.title ?? "").startsWith(marker))) {
    console.log(`issue already open for ${c.repo} — skipping`)
    continue
  }
  try {
    const issue = await gh(`/repos/${OWNER}/${THIS_REPO}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: marker,
        labels: ["upstream", "enhancement"],
        body:
          `Upstream moved ahead of our recorded snapshot.\n\n` +
          `| | |\n|---|---|\n| repo | \`${c.repo}\` |\n| snapshot | \`${c.from}\` |\n| current | \`${c.to}\` |\n| diff | ${c.url} |\n\n` +
          manifest.repositories.find((r) => r.repo === c.repo)?.adopted?.join(", ") +
          `\n\n**After review:** update the \`sha\` for \`${c.repo}\` in \`upstream.json\`, adopt anything useful, and close this issue.`,
      }),
    })
    console.log(`opened issue #${issue.number} for ${c.repo}: ${issue.html_url}`)
  } catch (e) {
    console.error(`failed to open issue for ${c.repo}: ${e.message}`)
  }
}

// ---- persist snapshot writes ----
// Silent bumps (force-push churn with an identical tree) and real moves both
// update the manifest here, so tomorrow's run compares against the truth
// instead of re-alarming on the same reflog noise.
try {
  const root = join(here, "..")
  writeFileSync(join(root, "upstream.json"), JSON.stringify(manifest, null, 2) + "\n")
  const dirty = execFileSync("git", ["status", "--porcelain", "upstream.json"], { cwd: root }).toString().trim()
  if (dirty) {
    const names = [...changed, ...silent].map((c) => `${c.repo.split("/")[0]}→${c.to.slice(0, 7)}`).join(", ")
    execFileSync("git", ["config", "user.name", "upstream-watch-bot"], { cwd: root })
    execFileSync("git", ["config", "user.email", "actions@users.noreply.github.com"], { cwd: root })
    execFileSync("git", ["add", "upstream.json"], { cwd: root })
    execFileSync("git", ["commit", "-m", `upstream: snapshot refresh (${names || "no-change"}) [skip ci]`], { cwd: root })
    execFileSync("git", ["push"], { cwd: root })
    console.log(`snapshot committed: ${names}`)
  }
} catch (e) {
  console.error(`snapshot persist skipped: ${e.message}`)
}

console.log(
  `tracking ${manifest.repositories.length} repos — ` +
    `${changed.length} changed: ${changed.map((c) => c.repo).join(", ") || "none"}`,
)
