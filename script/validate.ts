#!/usr/bin/env bun
// Registry lint: every mod.json and harness json matches its schema-level
// invariants, every listed patch exists, every commit is 40 hex chars, and
// names match folders. Runs in CI on every PR; `open-mods check` does the
// expensive apply-and-build step per mod.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
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
// harness with support.json and its patches.
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const modsRoot = path.join(root, "mods")
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
      if (!/^[0-9a-f]{40}$/.test(sup.upstream?.commit ?? "")) errors.push(`${hrel}: upstream.commit must be a full sha`)
      if (!sup.upstream?.ref) errors.push(`${hrel}: missing upstream.ref`)
      if (!Array.isArray(sup.patches) || sup.patches.length === 0) errors.push(`${hrel}: patches must be a non-empty list`)
      for (const p of sup.patches ?? []) {
        if (!/^patches\/\d{4}-[A-Za-z0-9._-]+\.patch$/.test(p)) errors.push(`${hrel}: bad patch path "${p}"`)
        else if (!existsSync(path.join(dir, h, p))) errors.push(`${hrel}: ${p} does not exist`)
        else if (/^index [0-9a-f]{1,39}\.\./m.test(readFileSync(path.join(dir, h, p), "utf8")))
          errors.push(`${hrel}: ${p} has short blob ids; regenerate it with open-mods pack (git format-patch --full-index)`)
      }
      const onDisk = existsSync(path.join(dir, h, "patches")) ? readdirSync(path.join(dir, h, "patches")).filter((f) => f.endsWith(".patch")) : []
      for (const f of onDisk) if (!sup.patches?.includes(`patches/${f}`)) errors.push(`${hrel}: patches/${f} is not listed in support.json`)
      for (const c of sup.conflicts ?? []) if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(c)) errors.push(`${hrel}: conflicts entry "${c}" must be owner/mod`)
    }
  }
}

if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`)
  process.exit(1)
}
console.log("registry ok")
