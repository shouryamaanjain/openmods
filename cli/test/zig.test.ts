// A harness release that pins a Zig (build.zig.zon's minimum_zig_version,
// which its builds use exactly) builds with that version: the one on PATH
// when it is that version, else one OpenMods keeps in ~/.openmods/toolchains.
// Getting it (cli/src/zig.ts): the build ziglang.org's download index names,
// from a community mirror or ziglang.org, checked against the index's sha256.
// Zig's build cache goes in ~/.openmods/cache unless you chose a place.
//
// The index, the mirror list and the downloads are served here, so nothing
// is downloaded.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { getZig, zigPin, zigPlatform } from "../src/zig"
import { cli, createHarness, createMod, release, run, sandbox, setGreeting } from "./harness"

const sb = sandbox("zig")
const seen = path.join(sb.T, "seen")
const platform = zigPlatform()!
let tarball = new Uint8Array()
let shasum = ""
const served: string[] = []
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    served.push(url.pathname + url.search)
    if (url.pathname === "/index.json")
      return Response.json({ "9.9.9": { [platform]: { tarball: `http://localhost:${server.port}/zig.tar.xz`, shasum, size: String(tarball.length) } } })
    if (url.pathname === "/mirrors.txt") return new Response(`https://bad.example.invalid/zig\n`)
    if (url.pathname === "/zig.tar.xz") return new Response(tarball)
    return new Response("no", { status: 404 })
  },
})
afterAll(() => server.stop())
const opts = () => ({ index: `http://localhost:${server.port}/index.json`, mirrors: null })

// A Zig: `zig` answering its version, and the lib folder beside it.
function zigIn(dir: string, version: string) {
  mkdirSync(path.join(dir, "lib"), { recursive: true })
  writeFileSync(path.join(dir, "zig"), `#!/bin/sh\n[ "$1" = version ] && echo ${version}\n`)
  chmodSync(path.join(dir, "zig"), 0o755)
}
// A release like Zig's own: a folder holding one.
async function makeZig(version: string) {
  const top = path.join(sb.T, "zigpkg", `zig-${platform}-9.9.9`)
  rmSync(path.dirname(top), { recursive: true, force: true })
  zigIn(top, version)
  const file = path.join(sb.T, "zig.tar.xz")
  await $`tar -cJf ${file} -C ${path.dirname(top)} ${path.basename(top)}`.quiet()
  tarball = new Uint8Array(readFileSync(file))
  shasum = new Bun.CryptoHasher("sha256").update(tarball).digest("hex")
}
const dest = () => path.join(sb.T, "toolchains", "zig-9.9.9")

describe("getting a Zig", () => {
  test("a download whose sha256 is not the index's is refused, and nothing is kept", async () => {
    await makeZig("9.9.9")
    shasum = "0".repeat(64)
    await expect(getZig("9.9.9", dest(), opts())).rejects.toThrow("the download's sha256 is")
    expect(existsSync(dest())).toBe(false)
  })
  test("a Zig that is not the version it says is refused", async () => {
    await makeZig("1.0.0")
    await expect(getZig("9.9.9", dest(), opts())).rejects.toThrow("does not run on this machine")
    expect(existsSync(path.join(dest(), "bin", "zig"))).toBe(false)
  })
  test("tries the mirrors first, then the index's own address, and keeps the whole release in bin/", async () => {
    await makeZig("9.9.9")
    served.length = 0
    const bin = await getZig("9.9.9", dest(), { index: opts().index, mirrors: `http://localhost:${server.port}/mirrors.txt` })
    expect(bin).toBe(path.join(dest(), "bin"))
    expect(existsSync(path.join(bin, "lib"))).toBe(true)
    expect(served).toContain("/mirrors.txt")
    expect(served).toContain("/zig.tar.xz")
  })
  test("one already there is used as it is; a broken one is replaced", async () => {
    served.length = 0
    await getZig("9.9.9", dest(), opts())
    expect(served).toEqual([])
    rmSync(path.join(dest(), "bin", "lib"), { recursive: true })
    await getZig("9.9.9", dest(), opts())
    expect(served).toContain("/zig.tar.xz")
    expect(existsSync(path.join(dest(), "bin", "lib"))).toBe(true)
  })
  test("two at once: the second never removes the first's", async () => {
    rmSync(dest(), { recursive: true, force: true })
    const [a, b] = await Promise.all([getZig("9.9.9", dest(), opts()), getZig("9.9.9", dest(), opts())])
    expect(a).toBe(b)
    expect((await $`${path.join(a, "zig")} version`.text()).trim()).toBe("9.9.9")
  })
  test("a pin is read from build.zig.zon; one that cannot be read is an error, not no pin", () => {
    const root = path.join(sb.T, "pin")
    mkdirSync(root, { recursive: true })
    expect(zigPin(root)).toBeNull()
    writeFileSync(path.join(root, "build.zig.zon"), '.{ .minimum_zig_version = "0.16.0" }')
    expect(zigPin(root)).toBe("0.16.0")
    rmSync(path.join(root, "build.zig.zon"))
    mkdirSync(path.join(root, "build.zig.zon"))
    expect(() => zigPin(root)).toThrow()
  })
})

describe("a harness release that pins a Zig", () => {
  beforeAll(async () => {
    await createHarness(sb)
    await release(sb, "v1.1.0", (dir) => writeFileSync(path.join(dir, "build.zig.zon"), '.{\n    .name = .fake,\n    .minimum_zig_version = "9.9.9",\n}\n'))
    const def = path.join(sb.reg, "harnesses", "fake.json")
    const install = `echo "zig=$(zig version) cache=$ZIG_GLOBAL_CACHE_DIR" > ${seen}`
    writeFileSync(def, JSON.stringify({ ...JSON.parse(readFileSync(def, "utf8")), install }))
    await createMod(sb, "friendly", setGreeting("hello from friendly"), { base: "v1.1.0" })
    // As if fetched before: a good Zig of that version in ~/.openmods/toolchains.
    zigIn(path.join(sb.om, "toolchains", "zig-9.9.9", "bin"), "9.9.9")
  })
  const toolchain = () => path.join(sb.om, "toolchains", "zig-9.9.9")

  test("builds with that version, from ~/.openmods/toolchains, with Zig's cache in ~/.openmods/cache", async () => {
    const r = await run(sb, {}, "install", "t/friendly")
    expect(r.code, r.all).toBe(0)
    expect(r.all).not.toContain("Getting Zig")
    expect(readFileSync(seen, "utf8").trim()).toBe(`zig=9.9.9 cache=${path.join(sb.om, "cache", "zig")}`)
  })
  test("is kept by the cleanup while a harness pins it; a Zig nothing pins goes", async () => {
    const stale = path.join(sb.om, "toolchains", "zig-0.0.1")
    mkdirSync(path.join(stale, "bin"), { recursive: true })
    const old = Date.now() / 1000 - 7200
    utimesSync(stale, old, old)
    utimesSync(toolchain(), old, old)
    const r = await run(sb, {}, "update", "--force")
    expect(r.code, r.all).toBe(0)
    expect(existsSync(path.join(toolchain(), "bin", "zig"))).toBe(true)
    expect(existsSync(stale)).toBe(false)
  })
  test("the Zig on PATH is used when it is that version, and your cache stays where you put it", async () => {
    await cli(sb, "uninstall", "t/friendly")
    const kept = path.join(sb.T, "zig-kept")
    rmSync(kept, { recursive: true, force: true })
    await $`mv ${toolchain()} ${kept}`.quiet()
    const bin = path.join(sb.T, "path-zig")
    zigIn(bin, "9.9.9")
    try {
      const r = await run(sb, { env: { PATH: `${bin}:${process.env.PATH}`, ZIG_GLOBAL_CACHE_DIR: "/mine/zig" } }, "install", "t/friendly")
      expect(r.code, r.all).toBe(0)
      expect(r.all).not.toContain("Getting Zig")
      expect(existsSync(toolchain())).toBe(false)
      expect(readFileSync(seen, "utf8").trim()).toBe("zig=9.9.9 cache=/mine/zig")
    } finally {
      await $`mv ${kept} ${toolchain()}`.quiet()
    }
  })
})
