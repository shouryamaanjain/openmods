#!/usr/bin/env bun
// What an update to a mod actually changes, as a plain code diff.
//
// A mod's pull request changes patch files, so GitHub shows a diff of two
// diffs, which neither people nor review bots read well. For each new update
// this applies the previous published update and the new one to the harness,
// in a scratch index with no checkout, and diffs the results: exactly the code
// the update adds, removes or changes. When the new update is for a newer
// release, the previous one is carried onto that release first, so upstream
// changes between the releases do not show up. The result is posted as one
// pull request comment.
//
// Like the other checks it runs from the base branch and never runs code from
// the pull request; patches are only applied with git.
//
//   PR=<n> HEAD_SHA=<sha> BASE_SHA=<sha> GITHUB_REPOSITORY=<owner/repo> bun script/update-diff.ts [--dry-run] [--registry <dir>]
import { $ } from "bun"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const { PR, HEAD_SHA, BASE_SHA, GITHUB_REPOSITORY: REPO } = process.env
const DRY = process.argv.includes("--dry-run")
const at = process.argv.indexOf("--registry")
const reg = path.resolve(at === -1 ? "." : process.argv[at + 1]!)
if (!HEAD_SHA || !BASE_SHA) throw new Error("HEAD_SHA and BASE_SHA are required")
const MARKER = "<!-- openmods-update-diff -->"
const LIMIT = 60_000 // a GitHub comment holds 65,536 characters

type Version = { ref: string; commit: string; update?: number; note?: string; patches: string[] }
const show = async (sha: string, file: string) => {
  const r = await $`git -C ${reg} show ${`${sha}:${file}`}`.quiet().nothrow()
  return r.exitCode === 0 ? r.stdout.toString() : undefined
}
const versionsAt = async (sha: string, file: string): Promise<Version[]> => JSON.parse((await show(sha, file)) ?? '{"versions":[]}').versions ?? []

const changed = (await $`git -C ${reg} diff --name-only ${BASE_SHA}...${HEAD_SHA}`.quiet().text()).split("\n").filter((f) => f.startsWith("mods/") && f.endsWith("/support.json"))

const sections: string[] = []
for (const file of changed) {
  const [, owner, name, harness] = file.split("/") as [string, string, string, string]
  const was = await versionsAt(BASE_SHA, file)
  const now = await versionsAt(HEAD_SHA, file)
  if (was.length === 0) continue // a new mod: its patches are the whole change
  const previous = was.reduce((a, v) => ((v.update ?? 1) > (a.update ?? 1) ? v : a))
  const def = JSON.parse(readFileSync(path.join(reg, "harnesses", `${harness}.json`), "utf8")) as { repo: string; name: string }
  for (const v of now) {
    if ((v.update ?? 1) <= (previous.update ?? 1)) continue // not a new update: a rebase or a version the release watch added
    const dir = `mods/${owner}/${name}/${harness}`
    const texts = async (sha: string, ver: Version) => Promise.all(ver.patches.map(async (p) => (await show(sha, `${dir}/${p}`)) ?? ""))
    const diff = await codeDiff(def.repo, previous.ref, await texts(BASE_SHA, previous), v.ref, await texts(HEAD_SHA, v))
    const title = `${owner}/${name} on ${def.name}: update ${v.update}${v.note ? ` (${v.note})` : ""}, compared with update ${previous.update ?? 1}${previous.ref === v.ref ? "" : `, carried from ${previous.ref} to ${v.ref}`}`
    sections.push(`#### ${title}\n\n${diff.text.trim() ? "```diff\n" + diff.text.trim() + "\n```" : "No code changes."}${diff.note ? `\n\n${diff.note}` : ""}`)
  }
}

if (sections.length === 0) {
  console.log("No update to compare.")
  process.exit(0)
}
let body = `${MARKER}\n### What the update changes\n\nThe code difference between the published update and this one, as it applies to the harness. The files changed in this pull request are the same change in patch form.\n\n${sections.join("\n\n")}`
if (body.length > LIMIT) body = body.slice(0, LIMIT) + "\n```\n\n(Cut short: the full difference is longer than a comment can hold.)"
if (DRY || !PR || !REPO) console.log(body)
else {
  const mine = (await $`gh api repos/${REPO}/issues/${PR}/comments --paginate --jq ${`.[] | select(.body | contains("${MARKER}")) | .id`}`.quiet().text()).trim().split("\n")[0]
  if (mine) await $`gh api -X PATCH repos/${REPO}/issues/comments/${mine} -f body=${body}`.quiet()
  else await $`gh api repos/${REPO}/issues/${PR}/comments -f body=${body}`.quiet()
  console.log("Posted the update's code difference.")
}

// Applies each patch series to its release in a scratch index of a blobless
// clone (only the files the patches touch are downloaded) and diffs the two
// resulting trees, limited to the files either series touches.
async function codeDiff(repo: string, oldRef: string, oldPatches: string[], newRef: string, newPatches: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "openmods-update-diff-"))
  const git = (...a: string[]) => $`git -C ${dir} ${a}`.quiet().nothrow()
  try {
    await git("init", "-q")
    await git("remote", "add", "origin", repo)
    for (const ref of new Set([oldRef, newRef])) await git("fetch", "-q", "--filter=blob:none", "--depth=1", "origin", `+refs/tags/${ref}:refs/tags/${ref}`)
    const touched = [...new Set([...oldPatches, ...newPatches].flatMap((t) => [...t.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].flatMap((m) => [m[1]!, m[2]!])))]
    // The previous update, on the new update's release when that differs, so
    // the diff holds only the mod's own changes.
    const apply = async (ref: string, patches: string[], threeWay: boolean) => {
      const index = path.join(dir, `index-${Math.random().toString(36).slice(2)}`)
      const env = { ...process.env, GIT_INDEX_FILE: index }
      await $`git -C ${dir} read-tree ${`${ref}^{tree}`}`.env(env).quiet()
      for (const [i, text] of patches.entries()) {
        const file = path.join(dir, `p${i}.patch`)
        writeFileSync(file, text)
        const r = await $`git -C ${dir} apply --cached ${threeWay ? ["--3way"] : []} ${file}`.env(env).quiet().nothrow()
        if (r.exitCode !== 0) return undefined
      }
      return (await $`git -C ${dir} write-tree`.env(env).quiet().text()).trim()
    }
    const after = await apply(newRef, newPatches, false)
    if (!after) return { text: "", note: "The new update's patches do not apply to its release, so no difference could be computed." }
    let before = await apply(newRef, oldPatches, oldRef !== newRef)
    let note = ""
    if (!before) {
      // The previous update does not carry onto the new release: compare
      // against it on its own release instead, which includes upstream changes
      // to the touched files.
      before = await apply(oldRef, oldPatches, false)
      note = `The previous update does not apply to ${newRef}, so this compares it on ${oldRef}; the difference includes upstream changes to these files between the two releases.`
    }
    if (!before) return { text: "", note: "The previous update's patches do not apply, so no difference could be computed." }
    const text = (await git("diff", before, after, "--", ...touched)).stdout.toString()
    return { text, note }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
