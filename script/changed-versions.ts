#!/usr/bin/env bun
// Which mod versions a change needs checked, for CI: each as a mod's harness
// folder and the release of the version to check.
//
//   - a version whose patches, or whose entry in support.json, changed
//   - a mod's newest version, when its shared files (mod.json, README) changed
//   - for a changed version of the OpenMods base patch, every other mod's
//     version for that release, since they are checked on top of it
//   - every mod's newest version when the CLI changed, and every newest
//     version on a harness whose definition changed
//
//   bun script/changed-versions.ts --base <sha> [--registry <dir>]
//   → [{"mod":"mods/<owner>/<name>/<harness>","at":"<release>"}, ...]
import { $ } from "bun"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const flag = (k: string) => {
  const i = args.indexOf(`--${k}`)
  return i === -1 ? undefined : args[i + 1]
}
const root = path.resolve(flag("registry") ?? path.join(import.meta.dir, ".."))
const base = flag("base") ?? (console.error("usage: bun script/changed-versions.ts --base <sha> [--registry <dir>]"), process.exit(2))

type Version = { ref: string }
const changed = (await $`git -C ${root} diff --name-only ${base} HEAD`.text()).split("\n").filter(Boolean)
const folders = (dir: string) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()) : [])
const dirs = folders(path.join(root, "mods")).flatMap(({ name: owner }) =>
  readdirSync(path.join(root, "mods", owner), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((mod) =>
      readdirSync(path.join(root, "mods", owner, mod.name), { withFileTypes: true })
        .filter((h) => h.isDirectory() && existsSync(path.join(root, "mods", owner, mod.name, h.name, "support.json")))
        .map((h) => `mods/${owner}/${mod.name}/${h.name}`),
    ),
)
const versions = (dir: string): Version[] => JSON.parse(readFileSync(path.join(root, dir, "support.json"), "utf8")).versions ?? []
const before = async (dir: string): Promise<Record<string, string>> => {
  const r = await $`git -C ${root} show ${`${base}:${dir}/support.json`}`.nothrow().quiet()
  if (r.exitCode !== 0) return {}
  return Object.fromEntries((JSON.parse(r.stdout.toString()).versions ?? []).map((v: Version) => [v.ref, JSON.stringify(v)]))
}

const out = new Map<string, Set<string>>()
const add = (dir: string, ref: string | undefined) => {
  if (ref && versions(dir).some((v) => v.ref === ref)) out.set(dir, (out.get(dir) ?? new Set()).add(ref))
}
const cli = changed.some((f) => f.startsWith("cli/"))
for (const dir of dirs) {
  const harness = path.basename(dir)
  const shared = changed.some((f) => path.dirname(f) === path.dirname(dir))
  if (cli || shared || changed.includes(`harnesses/${harness}.json`)) add(dir, versions(dir)[0]?.ref)
  for (const f of changed.filter((f) => f.startsWith(`${dir}/`))) {
    const parts = f.slice(dir.length + 1).split("/")
    if (parts.length === 2 && parts[1]!.endsWith(".patch")) add(dir, parts[0])
  }
  if (changed.includes(`${dir}/support.json`)) {
    const was = await before(dir)
    for (const v of versions(dir)) if (was[v.ref] !== JSON.stringify(v)) add(dir, v.ref)
  }
}
// Mods are checked on top of the base patch, so a change to it checks them too.
for (const [dir, refs] of [...out].filter(([d]) => d.startsWith("mods/openmods/base/")))
  for (const other of dirs.filter((d) => path.basename(d) === path.basename(dir) && !d.startsWith("mods/openmods/base/")))
    for (const ref of refs) add(other, ref)

console.log(JSON.stringify([...out].flatMap(([mod, refs]) => [...refs].map((at) => ({ mod, at })))))
