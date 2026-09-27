#!/usr/bin/env bun
// Release watch, the registry's reaction to a harness release.
//
//   plan   [--harness <id>] [--ref <tag>]    what to check against which release (JSON)
//   apply  <results-dir> [--recipe <json>] [--issues]
//                                            bump the mods that passed, mark the ones
//                                            that failed, hold a harness whose recipe
//                                            changed, open or update issues
//   verify <harness> <ref>                   record that a person built the harness at
//                                            <ref> after its recipe changed: lifts the hold
//
// Nothing here builds a harness. For each harness with a new release, `plan`
// first compares the lines our build recipe depends on (the harness's
// `recipe` list: its build script, toolchain pin, and so on) between the last
// release it was checked at and the new one. If any changed, the harness is
// held: no mod is checked or bumped, and one issue asks a person to run the
// manual harness build. If none changed, `plan` lists the mods not yet on the
// new release, CI applies and typechecks each one (`openmods check
// --typecheck --json`), and `apply` bumps the ones that pass and marks the
// ones that fail, which the site shows in yellow.
//
// A check that could not tell (the release or the dependencies could not be
// fetched, or the check crashed and left no result) is the mod's fault as
// little as it is anyone's: nothing is recorded against it and it is tried
// again the next hour. After three such runs in a row, one issue asks the
// registry's maintainers to look.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { latestRelease } from "../cli/src/latest-release"

const args = process.argv.slice(2)
const flag = (k: string) => {
  const i = args.indexOf(`--${k}`)
  return i === -1 ? undefined : args[i + 1]
}
const has = (k: string) => args.includes(`--${k}`)
const root = path.resolve(flag("registry") ?? path.resolve(import.meta.dir, ".."))

const rel = (ref: string) => ref.replace(/^[^0-9]*/, "")
const releaseKey = (ref: string) => ref.replace(/^[^0-9]*/, "").split(/[.+-]/).map((x) => Number(x) || 0)
const newer = (a: string, b: string) => {
  const [x, y] = [releaseKey(a), releaseKey(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

const harnesses = () =>
  readdirSync(path.join(root, "harnesses"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(root, "harnesses", f), "utf8")))
    .filter((h) => !flag("harness") || h.id === flag("harness"))

// A mod on one harness is the folder mods/<owner>/<name>/<harness>, holding
// support.json (the release it is for, its patches) and status.json.
const modDirs = (harness: string) => {
  const base = path.join(root, "mods")
  const dirs = (p: string) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [])
  return dirs(base).flatMap((owner) =>
    dirs(path.join(base, owner))
      .map((name) => path.join(base, owner, name, harness))
      .filter((d) => existsSync(path.join(d, "support.json"))),
  )
}

// support.json lists a mod's versions, one per release it has worked on. The
// newest is what a new release is checked against; older ones stay, for users
// whose other mods are still on those releases.
type Version = { ref: string; commit: string; patches: string[]; update?: number; note?: string }
const byRelease = (a: Version, b: Version) => (newer(a.ref, b.ref) ? -1 : newer(b.ref, a.ref) ? 1 : 0)
const newestOf = (support: { versions: Version[] }) => support.versions.slice().sort(byRelease)[0]!

// What a set of patches changes, without line numbers or context: the same
// code rebased onto another release compares equal. The same rule as
// openmods pack uses to number updates.
const codeOf = (texts: string[]) =>
  texts
    .flatMap((t) => t.split("\n").filter((l) => /^[-+]/.test(l) && !/^(\+\+\+|---)( |$)/.test(l)))
    .join("\n")

const readJson = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined)
// A check's result, or nothing when the check left none that can be read.
const readResult = (file: string) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}
const UNCHECKED_RUNS = 3
const writeJson = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data, null, 2) + "\n")

type RecipeEntry = { file: string; lines?: string }
type RecipeCheck = { harness: string; name: string; from: string; to: string; state: "unchanged" | "changed" | "held"; changes: string[] }

const statusFile = (harness: string) => path.join(root, "status", `${harness}.json`)

// The lines of the harness's recipe files that differ between two releases.
// A recipe entry watches a whole file, or only its lines matching `lines`
// (a regex): package.json changes every release, its packageManager line
// almost never. Only trees and the few watched files are fetched.
async function recipeChanges(h: { id: string; repo: string; recipe?: RecipeEntry[] }, from: string, to: string): Promise<string[]> {
  if (!h.recipe?.length || from === to) return []
  const dir = path.join((process.env.RUNNER_TEMP ?? "/tmp"), `openmods-recipe-${h.id}-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  await $`git -C ${dir} init -q`.quiet()
  await $`git -C ${dir} remote add origin ${h.repo}`.quiet()
  await $`git -C ${dir} config remote.origin.promisor true`.quiet()
  await $`git -C ${dir} config remote.origin.partialclonefilter blob:none`.quiet()
  await $`git -C ${dir} fetch -q --no-tags --depth 1 --filter=blob:none origin ${"refs/tags/" + from + ":refs/tags/" + from} ${"refs/tags/" + to + ":refs/tags/" + to}`.quiet()
  const changes: string[] = []
  const show = async (ref: string, file: string) => {
    const r = await $`git -C ${dir} show ${ref + ":" + file}`.nothrow().quiet()
    return r.exitCode === 0 ? r.stdout.toString() : null
  }
  for (const entry of h.recipe) {
    if (!entry.lines) {
      // A whole file: any changed line counts, and so does the file going away.
      const diff = await $`git -C ${dir} diff -U0 ${from} ${to} -- ${entry.file}`.nothrow().quiet().text()
      for (const line of diff.split("\n")) if (/^[-+]/.test(line) && !/^(---|\+\+\+) /.test(line)) changes.push(`${entry.file}: ${line}`)
      continue
    }
    // Only the matching lines, compared by what they say: whitespace and a
    // trailing comma (a JSON key added after this one) do not count.
    const match = new RegExp(entry.lines)
    const pick = (text: string | null) =>
      (text ?? "").split("\n").filter((l) => match.test(l)).map((l) => l.trim().replace(/,$/, ""))
    const [a, b] = [pick(await show(from, entry.file)), pick(await show(to, entry.file))]
    if (a.join("\n") === b.join("\n")) continue
    for (const l of a.filter((x) => !b.includes(x))) changes.push(`${entry.file}: -${l}`)
    for (const l of b.filter((x) => !a.includes(x))) changes.push(`${entry.file}: +${l}`)
  }
  rmSync(dir, { recursive: true, force: true })
  return changes
}

// Closes the conflict issues a fix has resolved: "<mod> does not support
// <harness> <release>" once the mod has a version for that release or a newer
// one, or is gone from the registry.
async function closeFixed() {
  const repo = process.env.GITHUB_REPOSITORY
  if (!has("issues") || !repo) return
  const list = (await $`gh issue list --repo ${repo} --state open --label conflict --json number,title`.nothrow().text()).trim()
  for (const issue of list ? (JSON.parse(list) as { number: number; title: string }[]) : []) {
    const m = /^([a-z0-9-]+\/[a-z0-9-]+) does not support (.+) (\d\S*)$/.exec(issue.title)
    if (!m) continue
    const [, id, name, release] = m as unknown as [string, string, string, string]
    const h = harnesses().find((x) => x.name === name)
    if (!h) continue
    const support = readJson(path.join(root, "mods", ...id.split("/"), h.id, "support.json"))
    const fixed = support?.versions?.find((v: Version) => rel(v.ref) === release || newer(v.ref, release))
    if (support && !fixed) continue
    const why = support ? `${id} now supports ${name} ${rel(fixed.ref)}.` : `${id} is no longer in the registry.`
    const closed = await $`gh issue close ${String(issue.number)} --repo ${repo} --comment ${why}`.nothrow().quiet()
    console.error(closed.exitCode === 0 ? `closed #${issue.number}: ${why}` : `could not close #${issue.number}: ${closed.stderr.toString().trim()}`)
  }
  // And the "could not check" ones, once a check of that mod has told or the
  // mod is gone. Every hour, so a close that failed is tried again.
  const watch = (await $`gh issue list --repo ${repo} --state open --label ${"release watch"} --json number,title`.nothrow().text()).trim()
  for (const issue of watch ? (JSON.parse(watch) as { number: number; title: string }[]) : []) {
    const m = /^The release watch could not check ([a-z0-9-]+\/[a-z0-9-]+) on (.+) (\d\S*)$/.exec(issue.title)
    if (!m) continue
    const [, id, name, release] = m as unknown as [string, string, string, string]
    const h = harnesses().find((x) => x.name === name)
    if (!h) continue
    const dir = path.join(root, "mods", ...id.split("/"), h.id)
    const status = readJson(path.join(dir, "status.json"))
    // It stands while this release is the one that cannot be checked, or,
    // when a newer one is, until a check told at this release or later.
    const told = status?.tested && !newer(release, status.tested)
    if (existsSync(dir) && status?.unchecked && (rel(status.unchecked.ref) === release || !told)) continue
    const why = existsSync(dir) ? "A check got through, so this is settled." : `${id} is no longer in the registry.`
    const closed = await $`gh issue close ${String(issue.number)} --repo ${repo} --comment ${why}`.nothrow().quiet()
    console.error(closed.exitCode === 0 ? `closed #${issue.number}: ${why}` : `could not close #${issue.number}: ${closed.stderr.toString().trim()}`)
  }
}

async function plan() {
  await closeFixed()
  const latest: Record<string, string> = {}
  const matrix: { mod: string; harness: string; ref: string }[] = []
  const recipe: RecipeCheck[] = []
  for (const h of harnesses()) {
    // A harness whose release channel cannot be reached this time is skipped;
    // the others are still checked, and it is tried again next hour.
    const ref =
      flag("ref") ??
      (await latestRelease(h, newer).catch((e) => {
        console.error(`${h.id}: could not tell its newest release: ${e instanceof Error ? e.message : e}`)
        return ""
      }))
    if (!ref) continue
    latest[h.id] = ref
    const mods = modDirs(h.id).map((dir) => ({ dir, mod: readJson(path.join(dir, "support.json")), status: readJson(path.join(dir, "status.json")) }))
    const pending = mods.filter(
      ({ mod, status }) => !mod.versions.some((v: Version) => v.ref === ref) && newer(ref, newestOf(mod).ref) && (status?.tested !== ref || has("retest")),
    )
    if (!pending.length) continue
    // Where the recipe was last known to work: the last release this harness
    // was checked at, else the newest release any of its mods is on.
    const st = readJson(statusFile(h.id))
    if (st?.tested === ref && st.recipe === "changed") {
      const held: RecipeCheck = { harness: h.id, name: h.name, from: st.from, to: ref, state: "held", changes: st.changes ?? [] }
      recipe.push(held)
      await askAboutRecipe(held)
      continue
    }
    // While held, a newer release is compared with the release the recipe last
    // worked at, not the held one, so the change that held it is not skipped.
    const known = st?.recipe === "changed" ? st.from : st?.tested
    const from = known && known !== ref ? known : mods.map(({ mod }) => newestOf(mod).ref).reduce((a, b) => (newer(b, a) ? b : a))
    const changes = st?.tested === ref ? [] : await recipeChanges(h, from, ref)
    recipe.push({ harness: h.id, name: h.name, from, to: ref, state: changes.length ? "changed" : "unchanged", changes })
    if (changes.length) continue
    for (const { dir } of pending) matrix.push({ mod: path.relative(root, dir), harness: h.id, ref })
  }
  const out = { latest, matrix, recipe }
  console.log(JSON.stringify(out, null, 2))
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\nrecipe=${JSON.stringify(recipe.filter((r) => r.state !== "held"))}\nlatest=${JSON.stringify(latest)}\n`, { flag: "a" })
  }
}

function maintainersOf(mod: any): string[] {
  const list: string[] = mod.maintainers ?? (mod.author?.github ? [mod.author.github] : [])
  return list.map((m) => (m.startsWith("@") ? m : `@${m}`))
}

async function issueFor(id: string, harnessId: string, meta: any, support: any, ref: string, error: string) {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) return
  const harness = readJson(path.join(root, "harnesses", `${harnessId}.json`))
  const title = `${id} does not support ${harness.name} ${rel(ref)}`
  const who = maintainersOf(meta).join(" ")
  const body = [
    `${who} ${harness.name} ${rel(ref)} (tag \`${ref}\`) is out and \`${id}\` no longer applies or typechecks on it. Its newest version stays ${harness.name} ${rel(newestOf(support).ref)} until this is fixed.`,
    "",
    "To fix it, restore the mod from the registry, move it onto the new release, and open a pull request. This works on any machine: the registry has the mod's commits, messages included. Run it with a clone of the harness and your fork of this registry, cloned as `openmods`, side by side:",
    "",
    "```sh",
    `git clone ${harness.repo} && cd ${path.basename(harness.repo)}   # or cd into your clone and run: git fetch --tags`,
    `git checkout -b ${id.split("/")[1]} ${newestOf(support).ref}`,
    `git am ../openmods/mods/${id}/${harnessId}/${newestOf(support).ref}/*.patch   # the mod as it last worked`,
    `git rebase --onto ${ref} ${newestOf(support).ref} ${id.split("/")[1]}   # resolve conflicts, then git rebase --continue`,
    `openmods install . --owner ${id.split("/")[0]}   # try it on ${harness.name} ${rel(ref)}`,
    `openmods pack . --name ${id.split("/")[1]} --owner ${id.split("/")[0]} --registry ../openmods --note "works on ${harness.name} ${rel(ref)}"`,
    "```",
    "",
    "This issue closes itself once the mod has a version for this release.",
    "",
    "What CI saw:",
    "",
    "```",
    error.split("\n").slice(0, 40).join("\n"),
    "```",
  ].join("\n")
  const existing = (await $`gh issue list --repo ${repo} --state open --search ${JSON.stringify(title) + " in:title"} --json number,title`.nothrow().text()).trim()
  const open = existing ? (JSON.parse(existing) as { number: number; title: string }[]).find((i) => i.title === title) : undefined
  if (open) {
    await $`gh issue comment ${String(open.number)} --repo ${repo} --body ${`Still failing on ${rel(ref)} as of ${new Date().toISOString().slice(0, 10)}.`}`.nothrow()
    return `#${open.number} (already open)`
  }
  const url = (await $`gh issue create --repo ${repo} --title ${title} --body ${body} --label conflict`.nothrow().text()).trim()
  return url
}

// Whether the issue is open now, found or created.
async function recipeIssue(r: RecipeCheck) {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) return false
  const title = `${r.name} ${rel(r.to)} changed the OpenMods build recipe`
  const body = [
    `${r.name} ${rel(r.to)} (tag \`${r.to}\`) changed lines our build recipe for it depends on, since ${rel(r.from)}. Mods for ${r.name} are held on the releases they are on until someone confirms the recipe still works.`,
    "",
    "What changed:",
    "",
    "```diff",
    ...r.changes.slice(0, 60),
    "```",
    "",
    `To confirm, run the **harness build** workflow with harness \`${r.harness}\` and ref \`${r.to}\`. If it builds, it records that and the next hourly check picks the mods up. If not, fix \`harnesses/${r.harness}.json\` first.`,
  ].join("\n")
  const existing = await $`gh issue list --repo ${repo} --state open --search ${JSON.stringify(title) + " in:title"} --json number,title`.nothrow().quiet()
  if (existing.exitCode !== 0) return false
  const found = existing.stdout.toString().trim()
  if (found && (JSON.parse(found) as { title: string }[]).some((i) => i.title === title)) return true
  return (await $`gh issue create --repo ${repo} --title ${title} --body ${body} --label "build recipe"`.nothrow().quiet()).exitCode === 0
}

// Closes open issues with one of these titles, or starting with `prefix`. A
// close that fails is tried again by the next plan (closeFixed).
async function closeIssues(titles: string[], comment: string, label?: string, prefix?: string) {
  const repo = process.env.GITHUB_REPOSITORY
  if (!has("issues") || !repo || (!titles.length && !prefix)) return
  const list = (await $`gh issue list --repo ${repo} --state open ${label ? ["--label", label] : []} --json number,title --limit 200`.nothrow().text()).trim()
  for (const issue of list ? (JSON.parse(list) as { number: number; title: string }[]) : []) {
    if (!titles.includes(issue.title) && !(prefix && issue.title.startsWith(prefix))) continue
    const closed = await $`gh issue close ${String(issue.number)} --repo ${repo} --comment ${comment}`.nothrow().quiet()
    if (closed.exitCode !== 0) console.error(`could not close #${issue.number}, tried again next run: ${closed.stderr.toString().trim()}`)
  }
}

// Opens (or finds) the issue for a release that changed the recipe; older
// releases' issues close only once it is open to replace them. The plan asks
// again every hour while the harness is held, so an issue GitHub would not
// take is tried again.
async function askAboutRecipe(r: RecipeCheck) {
  if (has("issues") && (await recipeIssue(r)))
    await closeOtherRecipeIssues(r.name, r.to, `${r.name} ${rel(r.to)} is out and changed the recipe too; its issue, which covers this one's changes, replaces this one.`)
}

// Recipe issues for other releases of this harness: a newer release's check
// now says whether the recipe works, or a newer release's issue, whose diff
// covers theirs, asks the same question.
async function closeOtherRecipeIssues(name: string, ref: string, comment: string) {
  const repo = process.env.GITHUB_REPOSITORY
  if (!has("issues") || !repo) return
  const list = (await $`gh issue list --repo ${repo} --state open --label "build recipe" --json number,title`.nothrow().text()).trim()
  // Only older releases': a manual run at an older release leaves newer ones.
  const suffix = " changed the OpenMods build recipe"
  // A prerelease (1.2.0-rc1) is older than its release (1.2.0).
  const older = (t: string) => newer(ref, t) || (!newer(t, ref) && t.includes("-") && !rel(ref).includes("-"))
  for (const issue of list ? (JSON.parse(list) as { number: number; title: string }[]) : [])
    if (issue.title.startsWith(`${name} `) && issue.title.endsWith(suffix) && older(issue.title.slice(name.length + 1, -suffix.length)))
      await $`gh issue close ${String(issue.number)} --repo ${repo} --comment ${comment}`.nothrow()
}

const uncheckedTitle = (id: string, name: string, ref: string) => `The release watch could not check ${id} on ${name} ${rel(ref)}`

// Whether the issue is open now, found or created.
async function uncheckedIssue(id: string, name: string, ref: string, error: string) {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) return false
  const title = uncheckedTitle(id, name, ref)
  const owner = repo.split("/")[0]
  const body = [
    `@${owner} The hourly release watch has not been able to check \`${id}\` against ${name} ${rel(ref)} (tag \`${ref}\`) for ${UNCHECKED_RUNS} runs in a row. This is not a verdict on the mod: the check could not run to the end, for example because the release or its dependencies could not be fetched, or the check crashed.`,
    "",
    "Nothing is recorded against the mod, and the watch keeps trying every hour. This issue closes itself once a check gets through.",
    "",
    "What the last run saw:",
    "",
    "```",
    error.split("\n").slice(0, 40).join("\n"),
    "```",
  ].join("\n")
  await $`gh label create ${"release watch"} --repo ${repo} --color ededed --description ${"The release watch needs a person"} --force`.nothrow().quiet()
  const existing = await $`gh issue list --repo ${repo} --state open --search ${JSON.stringify(title) + " in:title"} --json number,title`.nothrow().quiet()
  if (existing.exitCode !== 0) return false
  const found = existing.stdout.toString().trim()
  if (found && (JSON.parse(found) as { title: string }[]).some((i) => i.title === title)) return true
  return (await $`gh issue create --repo ${repo} --title ${title} --body ${body} --label ${"release watch"}`.nothrow().quiet()).exitCode === 0
}

async function apply() {
  const dir = args[1] ?? "results"
  const recipe: RecipeCheck[] = JSON.parse(flag("recipe") ?? process.env.RECIPE ?? "[]")
  // What the plan asked to check, so a check that left no result is known.
  const planned: { mod: string; harness: string; ref: string }[] = JSON.parse(flag("matrix") ?? process.env.MATRIX ?? "[]")
  mkdirSync(path.join(root, "status"), { recursive: true })
  // What happened, per harness, for the commit message.
  const report = new Map<string, { ref: string; bumped: string[]; broken: string[]; unchecked: string[]; recipe?: string }>()
  const of = (name: string, ref: string) => report.get(name) ?? report.set(name, { ref, bumped: [], broken: [], unchecked: [] }).get(name)!
  for (const r of recipe) {
    const checked = new Date().toISOString()
    if (r.state === "changed") {
      writeJson(statusFile(r.harness), { tested: r.to, from: r.from, recipe: "changed", changes: r.changes, checked })
      await askAboutRecipe(r)
      of(r.name, r.to).recipe = `${r.name} ${rel(r.to)} changed the build recipe; its mods are held until someone runs the harness build`
    } else if (r.state === "unchanged") {
      writeJson(statusFile(r.harness), { tested: r.to, from: r.from, recipe: "unchanged", checked })
    }
    if (r.state === "unchanged") await closeOtherRecipeIssues(r.name, r.to, `${r.name} ${rel(r.to)} is out and was checked; this release's recipe question is settled by that one.`)
  }
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : []
  const results = planned.length
    ? planned.map((p) => ({ mod: p.mod, harness: p.harness, ref: p.ref, r: readResult(path.join(dir, `${p.mod.replaceAll("/", "_")}.json`)) }))
    : files.map((f) => {
        // Without the plan, an unreadable result is known by its file name:
        // mods_<owner>_<name>_<harness>.json.
        const r = readResult(path.join(dir, f))
        const named = f.replace(/\.json$/, "").split("_")
        const guess = named.length === 4 && named[0] === "mods" ? named.join("/") : ""
        return { mod: r?.mod ? `mods/${r.mod}/${r.harness}` : guess, harness: r?.harness ?? named[3], ref: r?.ref, r }
      })
  let lost = 0
  for (const { mod: modPath, harness, ref: plannedRef, r } of results) {
    if (!modPath) {
      console.error("a result could not be read, and its file name does not say which mod it is for")
      lost++
      continue
    }
    if (r?.stock) continue
    const modDir = path.join(root, modPath)
    const modFile = path.join(modDir, "support.json")
    if (!existsSync(modFile)) continue
    const id = modPath.split("/").slice(1, 3).join("/")
    const mod = readJson(modFile)
    const meta = readJson(path.join(modDir, "..", "mod.json")) ?? {}
    const h = readJson(path.join(root, "harnesses", `${harness}.json`))
    const harnessName = h?.name ?? harness
    const ref = (r?.ref as string | undefined) ?? plannedRef ?? ""
    const line = of(harnessName, ref)
    const statusPath = path.join(modDir, "status.json")
    const checked = new Date().toISOString()
    // Not checked: nothing is recorded against the mod, and the next run
    // tries again. The runs are counted, and after a few, a person is asked.
    if (!r || r.unchecked || r.applies === undefined) {
      const error = String(r?.error ?? r?.unchecked ?? "the check left no result: it crashed or was stopped before it wrote one")
      // Without the plan, a result that cannot be read does not say which
      // release it was for: it is only reported.
      if (!ref) {
        line.unchecked.push(`${id} (its result could not be read)`)
        continue
      }
      const prev = readJson(statusPath) ?? {}
      const before = prev.unchecked?.ref === ref ? prev.unchecked : undefined
      const runs = Math.min((before?.runs ?? 0) + 1, UNCHECKED_RUNS)
      // Asked until the issue is there; once it is, nothing more is written,
      // so a mod that keeps failing to check does not commit every hour.
      const issued = before?.issued === true || (runs === UNCHECKED_RUNS && has("issues") && (await uncheckedIssue(id, harnessName, ref, error)))
      if (!before || before.runs !== runs || (before.issued === true) !== issued)
        writeJson(statusPath, { ...prev, unchecked: { ref, runs, error: error.split("\n").slice(0, 40).join("\n"), checked, ...(issued ? { issued } : {}) } })
      line.unchecked.push(id)
      continue
    }
    // A verdict: the mod's "could not check" issues, for any release, are settled.
    await closeIssues([], "A check got through, so this is settled.", "release watch", `The release watch could not check ${id} on ${harnessName} `)
    // Nothing the bot commits changes a mod's code: the new release's patches
    // must change exactly the lines a person reviewed. If a rebase changed
    // them, the mod is held like one that failed, for its maintainer.
    const reviewedCode = codeOf(newestOf(mod).patches.map((p) => readFileSync(path.join(modDir, p), "utf8")))
    const rebasedCode = Array.isArray(r.patches) && r.patches.length ? codeOf((r.patches as { text: string }[]).map((p) => p.text)) : reviewedCode
    if (r.applies === true && rebasedCode !== reviewedCode) {
      r.applies = false
      r.error = "The patches apply, but the rebased patches change different lines than the reviewed ones, so a maintainer has to rebase this mod and have it reviewed."
    }
    const ok = r.applies === true && (r.builds === true || r.typechecks === true)
    if (ok) {
      // A new version for the new release, next to the others: the patches as
      // they apply to it, when CI sent them, else the newest version's as they are.
      const folder = path.join(modDir, r.ref)
      rmSync(folder, { recursive: true, force: true })
      mkdirSync(folder, { recursive: true })
      const sent = Array.isArray(r.patches) && r.patches.length ? (r.patches as { name: string; text: string }[]) : undefined
      const patchFiles = sent ?? newestOf(mod).patches.map((p) => ({ name: path.basename(p), text: readFileSync(path.join(modDir, p), "utf8") }))
      for (const patch of patchFiles) writeFileSync(path.join(folder, patch.name), patch.text)
      // Same code on a new release: the same update, and its note.
      const from = newestOf(mod)
      const version: Version = { ref: r.ref, commit: r.commit, patches: patchFiles.map((patch) => `${r.ref}/${patch.name}`), update: from.update ?? 1, ...(from.note ? { note: from.note } : {}) }
      mod.versions = [version, ...(mod.versions as Version[]).filter((v) => v.ref !== r.ref)].sort(byRelease)
      writeJson(modFile, mod)
      writeJson(statusPath, { tested: r.ref, supports: r.ref, ok: true, checked })
      line.bumped.push(id)
    } else {
      const error = String(r.error ?? (r.applies ? "typecheck failed" : "patches do not apply"))
      writeJson(statusPath, { tested: r.ref, supports: newestOf(mod).ref, ok: false, error: error.split("\n").slice(0, 40).join("\n"), checked })
      const issue = has("issues") ? await issueFor(id, harness, meta, mod, r.ref, error) : undefined
      line.broken.push(`${id}${issue ? ` (${issue})` : ""}`)
    }
  }
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`
  const titles: string[] = []
  const body: string[] = []
  for (const [name, x] of report) {
    const parts: string[] = []
    if (x.bumped.length || x.broken.length) parts.push(`${n(x.bumped.length, "mod")} now support${x.bumped.length === 1 ? "s" : ""} it, ${x.broken.length} ${x.broken.length === 1 ? "does" : "do"} not`)
    if (x.unchecked.length) parts.push(`${n(x.unchecked.length, "mod")} not checked yet`)
    if (x.recipe) parts.push("build recipe changed, mods held")
    if (!parts.length) continue
    titles.push(`${name} ${rel(x.ref)}: ${parts.join("; ")}`)
    if (x.bumped.length) body.push(`${name}: supports it: ${x.bumped.join(", ")}`)
    if (x.broken.length) body.push(`${name}: needs a maintainer: ${x.broken.join(", ")}`)
    if (x.unchecked.length) body.push(`${name}: could not be checked this time, tried again next hour: ${x.unchecked.join(", ")}`)
    if (x.recipe) body.push(x.recipe)
  }
  const title = titles.join("; ") || "Release watch: nothing to record"
  const summary = `${title}\n${body.join("\n").replace(/^/gm, "  ")}`
  console.log(summary)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "COMMIT_MSG"), `${title}\n\n${body.join("\n")}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + summary + "\n```\n", { flag: "a" })
  // What was recorded stands; the run still fails, so a lost check is seen.
  if (lost) process.exit(1)
}

// A person ran the harness build at `ref` and it worked: the recipe is
// confirmed for that release and the hold is lifted.
async function verify() {
  const [harness, ref] = [args[1], args[2]]
  if (!harness || !ref) throw new Error("usage: release-watch verify <harness> <ref> [--issues]")
  mkdirSync(path.join(root, "status"), { recursive: true })
  const prev = readJson(statusFile(harness))
  writeJson(statusFile(harness), { tested: ref, from: prev?.from, recipe: "verified", checked: new Date().toISOString() })
  console.log(`${harness} ${rel(ref)}: recipe verified by a build`)
  // Close the issue that asked for this build.
  const repo = process.env.GITHUB_REPOSITORY
  if (!has("issues") || !repo) return
  const name = readJson(path.join(root, "harnesses", `${harness}.json`))?.name ?? harness
  const title = `${name} ${rel(ref)} changed the OpenMods build recipe`
  const list = (await $`gh issue list --repo ${repo} --state open --label "build recipe" --json number,title`.nothrow().text()).trim()
  for (const issue of list ? (JSON.parse(list) as { number: number; title: string }[]) : [])
    if (issue.title === title)
      await $`gh issue close ${String(issue.number)} --repo ${repo} --comment ${`A harness build at ${rel(ref)} succeeded, so the recipe still works. Mods are checked again on the next hourly run.`}`.nothrow()
}

const cmd = args[0]
if (cmd === "plan") await plan()
else if (cmd === "apply") await apply()
else if (cmd === "verify") await verify()
else {
  console.error("usage: release-watch plan [--harness <id>] [--ref <tag>] [--retest] | apply <results-dir> [--recipe <json>] [--issues] | verify <harness> <ref>   (--registry <dir> to run against another checkout)")
  process.exit(1)
}
