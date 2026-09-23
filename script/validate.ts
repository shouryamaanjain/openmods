#!/usr/bin/env bun
// Registry lint: every mod.json and harness json matches its schema-level
// invariants, every listed patch exists, every commit is 40 hex chars, and
// names match folders. Runs in CI on every PR; `openmods check` does the
// expensive apply-and-build step per mod.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

// The registry to check: this checkout, or another with --registry <dir>.
const at = process.argv.indexOf("--registry")
const root = path.resolve(at === -1 ? path.join(import.meta.dir, "..") : process.argv[at + 1]!)
const errors: string[] = []
const harnesses = new Set(
  readdirSync(path.join(root, "harnesses"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, "")),
)

for (const id of harnesses) {
  const h = JSON.parse(readFileSync(path.join(root, "harnesses", `${id}.json`), "utf8"))
  if (h.id !== id) errors.push(`harnesses/${id}.json: id "${h.id}" does not match file name`)
  for (const k of ["name", "repo", "binary", "install", "build", "artifact"]) {
    if (typeof h[k] !== "string" || !h[k]) errors.push(`harnesses/${id}.json: missing "${k}"`)
  }
  // Offered to users who install a mod without having the harness.
  if (h.installer !== undefined) {
    if (typeof h.installer?.command !== "string" || !h.installer.command) errors.push(`harnesses/${id}.json: installer needs a "command"`)
    if (h.installer?.paths !== undefined && (!Array.isArray(h.installer.paths) || h.installer.paths.some((p: unknown) => typeof p !== "string")))
      errors.push(`harnesses/${id}.json: installer.paths must be a list of folders`)
  }
}

// mods/<owner>/<name>/mod.json, README.md, and one folder per supported
// harness with support.json and one folder of patches per version.
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const modsRoot = path.join(root, "mods")
const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
const dirs = (p: string) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [])
for (const owner of dirs(modsRoot)) {
  if (!ID.test(owner)) errors.push(`mods/${owner}: owner must be lowercase letters, digits and hyphens`)
  for (const name of dirs(path.join(modsRoot, owner))) {
    const dir = path.join(modsRoot, owner, name)
    const rel = `mods/${owner}/${name}`
    const file = path.join(dir, "mod.json")
    if (!ID.test(name)) errors.push(`${rel}: name must be lowercase letters, digits and hyphens`)
    if (!existsSync(file)) {
      errors.push(`${rel}: missing mod.json`)
      continue
    }
    const m = JSON.parse(readFileSync(file, "utf8"))
    if (m.owner !== owner) errors.push(`${rel}: owner "${m.owner}" does not match folder`)
    if (m.name !== name) errors.push(`${rel}: name "${m.name}" does not match folder`)
    if ("version" in m) errors.push(`${rel}: drop "version"; a mod is versioned by the harness release it supports`)
    if (typeof m.description !== "string" || m.description.length === 0 || m.description.length > 200 || m.description.startsWith("TODO"))
      errors.push(`${rel}: description must be 1-200 characters and not a TODO`)
    if (!m.license) errors.push(`${rel}: missing license`)
    if (!existsSync(path.join(dir, "README.md"))) errors.push(`${rel}: missing README.md`)
    // A mod's folder holds only what OpenMods reads: its metadata, its README,
    // and per harness its support.json, patches, and the status CI writes.
    // Anything else would be published without being reviewed as code.
    for (const f of walk(dir).map((f) => path.relative(dir, f).replaceAll("\\", "/")))
      if (!/^(mod\.json|README\.md|[^/]+\/(support|status)\.json|[^/]+\/[^/]+\/\d{4}-[A-Za-z0-9._-]+\.patch)$/.test(f))
        errors.push(`${rel}: ${f} is not a file a mod may contain (mod.json, README.md, and per harness support.json and patches)`)
    const supported = dirs(dir)
    if (supported.length === 0) errors.push(`${rel}: supports no harness; add a <harness>/support.json`)
    for (const h of supported) {
      const hrel = `${rel}/${h}`
      if (!harnesses.has(h)) errors.push(`${hrel}: no harnesses/${h}.json`)
      const sfile = path.join(dir, h, "support.json")
      if (!existsSync(sfile)) {
        errors.push(`${hrel}: missing support.json`)
        continue
      }
      const sup = JSON.parse(readFileSync(sfile, "utf8"))
      if ("upstream" in sup || "patches" in sup) errors.push(`${hrel}: support.json lists "versions" now, one per release; repack with openmods pack`)
      const versions: { ref?: string; commit?: string; patches?: string[]; update?: unknown; note?: unknown }[] = Array.isArray(sup.versions) ? sup.versions : []
      if (versions.length === 0) errors.push(`${hrel}: versions must be a non-empty list`)
      const refs = versions.map((v) => v.ref)
      if (new Set(refs).size !== refs.length) errors.push(`${hrel}: more than one version for the same release`)
      const listed = new Set<string>()
      for (const v of versions) {
        const vrel = `${hrel} ${v.ref ?? "(no ref)"}`
        if (!v.ref) errors.push(`${vrel}: missing ref`)
        if (!/^[0-9a-f]{40}$/.test(v.commit ?? "")) errors.push(`${vrel}: commit must be a full sha`)
        if (!Array.isArray(v.patches) || v.patches.length === 0) errors.push(`${vrel}: patches must be a non-empty list`)
        if (!Number.isInteger(v.update) || (v.update as number) < 1) errors.push(`${vrel}: update must be a whole number from 1; openmods pack sets it`)
        if (v.note !== undefined && (typeof v.note !== "string" || v.note.length === 0 || v.note.length > 200)) errors.push(`${vrel}: note must be 1-200 characters`)
        for (const p of v.patches ?? []) {
          listed.add(p)
          // Each version's patches live in a folder named after its release tag.
          if (!p.startsWith(`${v.ref}/`) || !/\/\d{4}-[A-Za-z0-9._-]+\.patch$/.test(p)) errors.push(`${vrel}: bad patch path "${p}"; patches go in ${v.ref}/`)
          else if (!existsSync(path.join(dir, h, p))) errors.push(`${vrel}: ${p} does not exist`)
          else if (/^index [0-9a-f]{1,39}\.\./m.test(readFileSync(path.join(dir, h, p), "utf8")))
            errors.push(`${vrel}: ${p} has short blob ids; regenerate it with openmods pack (git format-patch --full-index)`)
        }
      }
      // Every patch file belongs to a version, so nothing stale is left behind.
      for (const f of walk(path.join(dir, h)).map((f) => path.relative(path.join(dir, h), f)))
        if (f.endsWith(".patch") && !listed.has(f)) errors.push(`${hrel}: ${f} is not listed in support.json`)
      for (const c of sup.conflicts ?? []) if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(c)) errors.push(`${hrel}: conflicts entry "${c}" must be owner/mod`)
    }
  }
}

// revoked.json: mods, or some of their updates, removed from the registry
// for doing harm. The CLI refuses to build them and stops running them.
const revokedFile = path.join(root, "revoked.json")
if (existsSync(revokedFile)) {
  const r = JSON.parse(readFileSync(revokedFile, "utf8"))
  if (!Array.isArray(r.revoked)) errors.push(`revoked.json: "revoked" must be a list`)
  for (const [i, e] of (Array.isArray(r.revoked) ? r.revoked : []).entries()) {
    if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(e?.id ?? "")) errors.push(`revoked.json entry ${i + 1}: "id" must be owner/mod`)
    if (typeof e?.reason !== "string" || !e.reason.trim()) errors.push(`revoked.json entry ${i + 1}: needs a "reason" users will read`)
    if (e?.updates !== undefined && (!Array.isArray(e.updates) || e.updates.some((u: unknown) => !Number.isInteger(u) || (u as number) < 1)))
      errors.push(`revoked.json entry ${i + 1}: "updates" must be a list of update numbers; leave it out to revoke every update`)
  }
}

if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`)
  process.exit(1)
}
console.log("registry ok")
