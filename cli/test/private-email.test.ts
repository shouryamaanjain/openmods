// Publishing a mod never publishes its author's email: pack puts GitHub's
// private address in each patch's header (From, trailers), check does the
// same for the patches the release watch saves, and the diff is left alone.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, sandbox } from "./harness"
import { emailsIn, withPrivateEmails } from "../src/private-email"

const sb = sandbox("private-email")
const work = () => path.join(sb.T, "work")

beforeAll(async () => {
  await createHarness(sb)
  await $`git clone -q ${sb.harness} ${work()}`.quiet()
  await $`git -C ${work()} checkout -q v1.0.0`.quiet()
  // A change whose own text holds an email: that is code, and stays.
  writeFileSync(path.join(work(), "CONTACT.md"), "Write to help@example.org\n")
  await $`git -C ${work()} add -A`.quiet()
  await $`git -C ${work()} -c user.name=Real -c user.email=real.person@example.com commit -qm ${"feat: contact\n\nSigned-off-by: Real <real.person@example.com>\nCo-authored-by: Pal <pal@example.net>"}`.quiet()
})

describe("a packed mod", () => {
  test("has GitHub's private address in its header, and its diff as it was", async () => {
    const r = await cli(sb, "pack", work(), "--name", "contact", "--owner", "t", "--harness", "fake")
    expect(r.code, r.all).toBe(0)
    const dir = path.join(sb.reg, "mods", "t", "contact", "fake", "v1.0.0")
    const text = readFileSync(path.join(dir, readdirSync(dir)[0]!), "utf8")
    expect(text).not.toContain("real.person@example.com")
    expect(text).not.toContain("pal@example.net")
    expect(text).toContain("From: Real <t@users.noreply.github.com>")
    expect(text).toContain("Signed-off-by: Real <t@users.noreply.github.com>")
    expect(text).toContain("+Write to help@example.org")
    expect(emailsIn(text)).toEqual([])
  })
  test("check's patches, which the release watch saves, carry none either", async () => {
    const r = await cli(sb, "check", path.join(sb.reg, "mods", "t", "contact", "fake"), "--json")
    expect(r.code, r.all).toBe(0)
    for (const p of JSON.parse(r.out).patches) expect(emailsIn(p.text)).toEqual([])
  })
})

describe("the scrubbing", () => {
  test("leaves private addresses and everything after the header alone", () => {
    const patch = "From: A <me@users.noreply.github.com>\nSubject: x\n\nsee me@site.io\n---\ndiff --git a/f b/f\n+me@site.io\n"
    expect(withPrivateEmails(patch, "t")).toBe("From: A <me@users.noreply.github.com>\nSubject: x\n\nsee t@users.noreply.github.com\n---\ndiff --git a/f b/f\n+me@site.io\n")
  })
})
