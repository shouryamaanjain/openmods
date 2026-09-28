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

describe("repacking a mod packed before this", () => {
  test("keeps its update number: a scrubbed message is not new code", async () => {
    const dir = path.join(sb.reg, "mods", "t", "contact", "fake", "v1.0.0")
    const file = path.join(dir, readdirSync(dir)[0]!)
    // As an older openmods wrote it: the real email, and a message bullet with one.
    writeFileSync(file, readFileSync(file, "utf8").replace("From: Real <t@users.noreply.github.com>", "From: Real <real.person@example.com>").replace("feat: contact\n", "feat: contact\n\n- Contact alice@example.com\n"))
    const r = await cli(sb, "pack", work(), "--name", "contact", "--owner", "t", "--harness", "fake", "--force")
    expect(r.code, r.all).toBe(0)
    const support = JSON.parse(readFileSync(path.join(sb.reg, "mods", "t", "contact", "fake", "support.json"), "utf8"))
    expect(support.versions[0].update).toBe(1)
  })
})

describe("the scrubbing", () => {
  test("replaces the From line's and trailers' addresses, whatever they look like, up to the diff", () => {
    const patch = [
      "From: A <alice@1example.com>",
      "Subject: x",
      "",
      "notes",
      "---",
      "more",
      "",
      "Signed-off-by: A <alice@intranet>",
      "Co-authored-by: B <bob@bücher.de>",
      "Reviewed-by: C <c@9.9.9.9>",
      "Cc: D <d@users.noreply.github.com>",
      "Cc: Eve <eve@example.com>, Fay <fay@example.com>",
      "Signed-off-by: gus@example.com",
      "Reviewed-by: CI <https://ci.example/run/7>",
      "Cc: https://user@host.example/path <https://u@h.example/p>",
      "Acked-by: Jane @jane@mastodon.social <jane@example.org>",
      "Signed-off-by: Team <alice/team@example.org>",
      "Cc: git@github.com:org/repo",
      "---",
      "diff --git a/f b/f",
      "+alice@example.com",
      "",
    ].join("\n")
    expect(emailsIn(patch)).toEqual(["alice@1example.com", "alice@intranet", "bob@bücher.de", "c@9.9.9.9", "eve@example.com", "fay@example.com", "gus@example.com", "jane@example.org", "alice/team@example.org"])
    const clean = withPrivateEmails(patch, "t")
    expect(emailsIn(clean)).toEqual([])
    expect(clean).toContain("From: A <t@users.noreply.github.com>")
    expect(clean).toContain("Cc: D <d@users.noreply.github.com>")
    expect(clean).toContain("+alice@example.com")
    expect(clean).toContain("Cc: Eve <t@users.noreply.github.com>, Fay <t@users.noreply.github.com>")
    expect(clean).toContain("Signed-off-by: t@users.noreply.github.com")
    expect(clean).toContain("Reviewed-by: CI <https://ci.example/run/7>")
    expect(clean).toContain("Cc: https://user@host.example/path <https://u@h.example/p>")
    expect(clean).toContain("Cc: git@github.com:org/repo")
    expect(clean).toContain("Acked-by: Jane @jane@mastodon.social <t@users.noreply.github.com>")
  })
  test("leaves the rest of the message as written: links and versions are the author's text", () => {
    const patch = "From: A <me@users.noreply.github.com>\nSubject: bump pkg@1.2.3-rc1\n\nSee <https://x.dev/u/alice@example.com?y@users.noreply.github.com> and <pkg@1.2.3-rc1>.\n---\ndiff --git a/f b/f\n"
    expect(withPrivateEmails(patch, "t")).toBe(patch)
    expect(emailsIn(patch)).toEqual([])
  })
})
