// ---------------------------------------------------------------------------
// upstream-check — silent watcher for the repositories whose feature set
// feeds model-badges. No submodules, no clones, no Watch required: a cron
// job compares each repo's HEAD sha against the snapshot recorded in
// upstream.json and opens ONE issue (per changed repo) in this repository
// when upstream moves. To upgrade, update the sha in upstream.json.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs"
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
for (const entry of manifest.repositories) {
  const { repo, sha: snapshot } = entry
  try {
    const head = await gh(`/repos/${repo}/commits/HEAD`)
    const current = head.sha.slice(0, 10)
    entry.lastSeen = current
    entry.lastSeenDate = head.commit.committer.date
    if (snapshot && current !== snapshot) {
      changed.push({ repo, from: snapshot, to: current, url: head.html_url })
      entry.sha = current // ahead of the issue body so the manifest stays fresh
    } else if (!snapshot) {
      entry.sha = current // first run records the baseline silently
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

console.log(
  `tracking ${manifest.repositories.length} repos — ` +
    `${changed.length} changed: ${changed.map((c) => c.repo).join(", ") || "none"}`,
)
