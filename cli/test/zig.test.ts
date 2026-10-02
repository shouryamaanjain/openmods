// A harness release that pins a Zig (build.zig.zon's minimum_zig_version,
// which its builds use exactly) builds with that version: the one on PATH
// when it is that version, else one OpenMods puts in ~/.openmods/toolchains
// from ziglang.org's download index, checked against the sha256 the index
// gives. Zig's build cache goes in ~/.openmods/cache unless you chose a place.
//
// The index and the download are served here (OPENMODS_ZIG_INDEX), so
// nothing is downloaded.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, createMod, release, run, sandbox, setGreeting } from "./harness"

const sb = sandbox("zig")
const seen = path.join(sb.T, "seen")
const platform = `${{ arm64: "aarch64", x64: "x86_64" }[process.arch as string]}-${{ darwin: "macos", linux: "linux" }[process.platform as string]}`
let tarball = new Uint8Array()
let shasum = ""
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/index.json")
      return Response.json({ "9.9.9": { [platform]: { tarball: `http://localhost:${server.port}/zig.tar.xz`, shasum, size: String(tarball.length) } } })
    if (url.pathname === "/zig.tar.xz") return new Response(tarball)
    return new Response("no", { status: 404 })
  },
})
afterAll(() => server.stop())

// A release like Zig's own: a folder holding `zig` and its lib folder.
async function makeZig(version: string) {
  const top = path.join(sb.T, "zigpkg", `zig-${platform}-9.9.9`)
  rmSync(path.dirname(top), { recursive: true, force: true })
  mkdirSync(path.join(top, "lib"), { recursive: true })
  writeFileSync(path.join(top, "zig"), `#!/bin/sh\n[ "$1" = version ] && echo ${version}\n`)
  chmodSync(path.join(top, "zig"), 0o755)
  const file = path.join(sb.T, "zig.tar.xz")
  await $`tar -cJf ${file} -C ${path.dirname(top)} ${path.basename(top)}`.quiet()
  tarball = new Uint8Array(readFileSync(file))
  shasum = new Bun.CryptoHasher("sha256").update(tarball).digest("hex")
}

beforeAll(async () => {
  await createHarness(sb)
  await release(sb, "v1.1.0", (dir) => writeFileSync(path.join(dir, "build.zig.zon"), '.{\n    .name = .fake,\n    .minimum_zig_version = "9.9.9",\n}\n'))
  const def = path.join(sb.reg, "harnesses", "fake.json")
  const install = `echo "zig=$(zig version) cache=$ZIG_GLOBAL_CACHE_DIR" > ${seen}`
  writeFileSync(def, JSON.stringify({ ...JSON.parse(readFileSync(def, "utf8")), install }))
  await createMod(sb, "friendly", setGreeting("hello from friendly"), { base: "v1.1.0" })
})

const env = (extra: Record<string, string> = {}) => ({ OPENMODS_ZIG_INDEX: `http://localhost:${server.port}/index.json`, ...extra })
const toolchain = () => path.join(sb.om, "toolchains", "zig-9.9.9")

describe("a harness release that pins a Zig", () => {
  test("a download whose sha256 is not the index's is refused, and nothing is kept", async () => {
    await makeZig("9.9.9")
    shasum = "0".repeat(64)
    const r = await run(sb, { env: env() }, "install", "t/friendly")
    expect(r.code).not.toBe(0)
    expect(r.all).toContain(`could not get Zig 9.9.9: the download's sha256 is`)
    expect(existsSync(toolchain())).toBe(false)
  })
  test("a Zig that is not the version it says is refused", async () => {
    await makeZig("1.0.0")
    const r = await run(sb, { env: env() }, "install", "t/friendly")
    expect(r.code).not.toBe(0)
    expect(r.all).toContain("Zig 9.9.9 (")
    expect(existsSync(path.join(toolchain(), "bin", "zig"))).toBe(false)
  })
  test("builds with that version, from ~/.openmods/toolchains, with Zig's cache in ~/.openmods/cache", async () => {
    await makeZig("9.9.9")
    const r = await run(sb, { env: env() }, "install", "t/friendly")
    expect(r.code, r.all).toBe(0)
    expect(r.all).toContain("Getting Zig 9.9.9, the version this release builds with")
    // The whole release, lib folder included, beside zig.
    expect(existsSync(path.join(toolchain(), "bin", "lib"))).toBe(true)
    expect(readFileSync(seen, "utf8").trim()).toBe(`zig=9.9.9 cache=${path.join(sb.om, "cache", "zig")}`)
  })
  test("is kept by the cleanup while a harness pins it; a Zig nothing pins goes", async () => {
    const stale = path.join(sb.om, "toolchains", "zig-0.0.1")
    mkdirSync(path.join(stale, "bin"), { recursive: true })
    const old = Date.now() / 1000 - 7200
    utimesSync(stale, old, old)
    const r = await run(sb, { env: env() }, "update", "--force")
    expect(r.code, r.all).toBe(0)
    expect(existsSync(path.join(toolchain(), "bin", "zig"))).toBe(true)
    expect(existsSync(stale)).toBe(false)
  })
  test("the Zig on PATH is used when it is that version, and your cache stays where you put it", async () => {
    await cli(sb, "uninstall", "t/friendly")
    rmSync(toolchain(), { recursive: true, force: true })
    const bin = path.join(sb.T, "path-zig")
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(bin, "zig"), "#!/bin/sh\n[ \"$1\" = version ] && echo 9.9.9\n")
    chmodSync(path.join(bin, "zig"), 0o755)
    const r = await run(sb, { env: env({ PATH: `${bin}:${process.env.PATH}`, ZIG_GLOBAL_CACHE_DIR: "/mine/zig" }) }, "install", "t/friendly")
    expect(r.code, r.all).toBe(0)
    expect(r.all).not.toContain("Getting Zig")
    expect(existsSync(toolchain())).toBe(false)
    expect(readFileSync(seen, "utf8").trim()).toBe("zig=9.9.9 cache=/mine/zig")
  })
})
