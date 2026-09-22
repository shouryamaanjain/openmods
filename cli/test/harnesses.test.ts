// Picking the harness for a mod: a mod is owner/mod, and one that supports
// several harnesses is installed on the one named with --<harness>, or on
// the one picked in the selector. Here "other" is a second harness.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "node:path"
import { cli, createHarness, createMod, greeting, registerHarness, sandbox, setGreeting } from "./harness"

const sb = sandbox("harnesses")
const hello = async () => (await $`sh ${path.join(sb.om, "bin", "hello")}`.env({ OPEN_MODS_NO_CHECK: "1", OPEN_MODS_NO_PROMPT: "1" }).text()).trim()

beforeAll(async () => {
  await createHarness(sb)
  registerHarness(sb, { id: "other", name: "Other", binary: "hello" })
  await createMod(sb, "solo", setGreeting("hello from solo"))
  await createMod(sb, "both", setGreeting("hello from both on fake"))
  await createMod(sb, "both", setGreeting("hello from both on other"), { harness: "other" })
})

describe("a mod for one harness", () => {
  test("installs there without a flag", async () => {
    const r = await cli(sb, "install", "t/solo")
    expect(r.code, r.all).toBe(0)
    expect(await greeting(sb)).toBe("hello from solo")
  })
  test("refuses a harness it does not support, and says which it does", async () => {
    const r = await cli(sb, "install", "t/solo", "--other")
    expect(r.code).toBe(1)
    expect(r.err).toContain("does not support Other. It supports Fake (--fake)")
  })
})

describe("a mod for two harnesses", () => {
  test("is listed once, with both", async () => {
    const out = (await cli(sb, "list")).out
    const line = out.split("\n").find((l) => l.includes("t/both"))!
    expect(line).toContain("fake")
    expect(line).toContain("other")
  })
  test("without a flag and without a terminal, says how to choose", async () => {
    const r = await cli(sb, "install", "t/both")
    expect(r.code).toBe(1)
    expect(r.err).toContain("choose with --fake or --other")
  })
  test("installs on the harness its flag names", async () => {
    const r = await cli(sb, "install", "t/both", "--other")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("now runs Other 1.0.0 + t/both")
    expect(await hello()).toBe("hello from both on other")
    expect(await greeting(sb)).toBe("hello from solo")
  })
  test("uninstalls from the only harness it is installed on without a flag", async () => {
    const r = await cli(sb, "uninstall", "t/both")
    expect(r.code, r.all).toBe(0)
    expect(await greeting(sb)).toBe("hello from solo")
  })
})

describe("mistakes", () => {
  test("the old harness/mod form points to the new one", async () => {
    const r = await cli(sb, "install", "fake/solo")
    expect(r.code).toBe(1)
    expect(r.err).toContain("open-mods install t/solo --fake")
  })
  test("a misspelled harness flag is refused", async () => {
    const r = await cli(sb, "install", "t/both", "--othr")
    expect(r.code).toBe(1)
    expect(r.err).toContain("unknown option --othr")
  })
})
