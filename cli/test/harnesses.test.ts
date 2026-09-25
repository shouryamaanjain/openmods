// Picking the harness for a mod. A mod is owner/mod, and one that supports
// several harnesses is installed on the one named with --<harness>, or on the
// one picked in the selector. A harness the user does not have is marked as
// such, and installing a mod for it offers the harness's official installer
// first. Here Fake is installed and Other, a second harness, is not.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, createMod, greeting, registerHarness, run, sandbox, setGreeting, stockInstaller } from "./harness"

const sb = sandbox("harnesses")
const hello = async () => (await $`sh ${path.join(sb.om, "bin", "hello")}`.env({ OPENMODS_NO_CHECK: "1", OPENMODS_NO_PROMPT: "1" }).text()).trim()
const otherInstalled = () => existsSync(path.join(sb.home, ".hello", "bin", "hello"))

beforeAll(async () => {
  await createHarness(sb)
  registerHarness(sb, { id: "other", name: "Other", binary: "hello" })
  await createMod(sb, "solo", setGreeting("hello from solo"))
  await createMod(sb, "lonely", setGreeting("hello from lonely"), { harness: "other" })
  await createMod(sb, "both", setGreeting("hello from both on fake"))
  await createMod(sb, "both", setGreeting("hello from both on other"), { harness: "other" })
})

describe("a mod for one harness", () => {
  test("that is installed: installs there without a flag or a question", async () => {
    const r = await cli(sb, "install", "t/solo")
    expect(r.code, r.all).toBe(0)
    expect(await greeting(sb)).toBe("hello from solo")
  })
  test("refuses a harness it does not support, and says which it does", async () => {
    const r = await cli(sb, "install", "t/solo", "--other")
    expect(r.code).toBe(1)
    expect(r.err).toContain("does not support Other. It supports Fake (--fake)")
  })
  test("that is not installed: says so and shows the official installer", async () => {
    const r = await cli(sb, "install", "t/lonely")
    expect(r.code).toBe(1)
    expect(r.out).toContain("Notice: t/lonely only supports Other, and Other is not installed on this system.")
    expect(r.out).toContain(stockInstaller("hello"))
    expect(otherInstalled()).toBe(false)
  })
  test("answering no installs nothing", async () => {
    const r = await run(sb, { answer: "n\n" }, "install", "t/lonely")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("Install Other now? [y/N]")
    expect(r.out).toContain("Nothing installed.")
    expect(otherInstalled()).toBe(false)
    expect(existsSync(path.join(sb.om, "bin", "hello"))).toBe(false)
  })
})

describe("a mod for two harnesses", () => {
  test("is listed once, with both", async () => {
    const out = (await cli(sb, "list")).out
    const line = out.split("\n").find((l) => l.includes("t/both"))!
    expect(line).toContain("fake")
    expect(line).toContain("other")
  })
  test("without a flag and without a terminal, says how to choose and what is missing", async () => {
    const r = await cli(sb, "install", "t/both")
    expect(r.code).toBe(1)
    expect(r.err).toContain("Other (not installed here)")
    expect(r.err).toContain("choose with --fake or --other")
  })
  test("on a harness that is not installed: yes runs its installer, then installs the mod", async () => {
    const r = await run(sb, { answer: "y\n" }, "install", "t/both", "--other")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("Other 1.0.0 is installed at ~/.hello/bin/hello")
    expect(r.out).toContain("now runs Other 1.0.0 + t/both")
    expect(otherInstalled()).toBe(true)
    expect(await hello()).toBe("hello from both on other")
    expect(await greeting(sb)).toBe("hello from solo")
  })
  test("uninstalls from the only harness it is installed on without a flag", async () => {
    const r = await cli(sb, "uninstall", "t/both")
    expect(r.code, r.all).toBe(0)
    expect(await greeting(sb)).toBe("hello from solo")
  })
  test("once the harness is installed, installs without asking", async () => {
    const r = await cli(sb, "install", "t/lonely")
    expect(r.code, r.all).toBe(0)
    expect(r.out).not.toContain("not installed")
    expect(await hello()).toBe("hello from lonely")
  })
})

describe("PATH", () => {
  test("a harness installer's later PATH line is moved behind openmods", async () => {
    const rc = path.join(sb.home, ".zshrc")
    const ours = `\n# openmods: modded builds go first; \`openmods off\` steps aside\nexport PATH="${sb.om}/bin:$PATH"  # openmods\n`
    writeFileSync(rc, `alias ll='ls -l'\n${ours}\nexport PATH=$HOME/.hello/bin:$PATH\n`)
    const r = await run(sb, { path: true, env: { SHELL: "/bin/zsh" } }, "on")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("Moved the openmods line")
    const lines = readFileSync(rc, "utf8").trim().split("\n")
    expect(lines.at(-1)).toContain("# openmods")
    expect(lines.filter((l) => l.includes("# openmods")).length).toBe(2)
    expect(lines).toContain("export PATH=$HOME/.hello/bin:$PATH")
    expect(lines[0]).toBe("alias ll='ls -l'")
    const again = await run(sb, { path: true, env: { SHELL: "/bin/zsh" } }, "on")
    expect(again.out).not.toContain("Moved the openmods line")
  })
})

describe("mistakes", () => {
  test("the old harness/mod form points to the new one", async () => {
    const r = await cli(sb, "install", "fake/solo")
    expect(r.code).toBe(1)
    expect(r.err).toContain("openmods install t/solo --fake")
  })
  test("updating a harness with no mods installed says so, and changes nothing", async () => {
    registerHarness(sb, { id: "unused", name: "Unused", binary: "unused" })
    const r = await cli(sb, "update", "unused")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("No mods are installed for Unused; nothing to update.")
    expect(existsSync(path.join(sb.om, "bin", "unused"))).toBe(false)
  })
  test("a misspelled harness flag is refused", async () => {
    const r = await cli(sb, "install", "t/both", "--othr")
    expect(r.code).toBe(1)
    expect(r.err).toContain("unknown option --othr")
  })
})
