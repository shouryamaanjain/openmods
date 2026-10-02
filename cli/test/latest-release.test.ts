// How a harness's newest release is found (cli/src/latest-release.ts): its
// own release channel when its definition names one, else the newest release
// tag, never a prerelease.
import { afterAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { latestRelease } from "../src/latest-release"

const newer = (a: string, b: string) => Bun.semver.order(a.replace(/^v/, ""), b.replace(/^v/, "")) > 0
const dir = mkdtempSync(path.join(tmpdir(), "openmods-latest-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function repoWithTags(tags: string[]) {
  const repo = path.join(dir, `repo-${tags.length}`)
  mkdirSync(repo)
  await $`git -C ${repo} init -q && git -C ${repo} -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`.quiet()
  for (const t of tags) await $`git -C ${repo} tag ${t}`.quiet()
  return `file://${repo}`
}

describe("the newest release", () => {
  test("is the one the harness's own channel names", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ version: "2.0.18" }) })
    try {
      const repo = await repoWithTags(["v1.18.32"])
      expect(await latestRelease({ repo, latestRelease: { url: `http://127.0.0.1:${server.port}/`, tag: "v{version}" } }, newer)).toBe("v2.0.18")
    } finally {
      server.stop(true)
    }
  })
  test("a channel that fails says so, so the release watch can skip that harness", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("down", { status: 503 }) })
    try {
      const repo = await repoWithTags(["v1.0.0", "v1.1.0"])
      await expect(latestRelease({ repo, latestRelease: { url: `http://127.0.0.1:${server.port}/`, tag: "v{version}" } }, newer)).rejects.toThrow("answered 503")
    } finally {
      server.stop(true)
    }
  })
  test("on GitHub, is its latest release, even when an older tag has a higher number", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ tag_name: "v0.0.12" }) })
    try {
      expect(await latestRelease({ repo: "https://github.com/vercel-labs/fx", releaseTagPattern: "v[0-9]*" }, newer, `http://127.0.0.1:${server.port}`)).toBe("v0.0.12")
    } finally {
      server.stop(true)
    }
  })
  test("on GitHub, when it cannot be asked, there is no answer rather than the highest tag", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("rate limited", { status: 403 }) })
    try {
      await expect(latestRelease({ repo: "https://github.com/vercel-labs/fx", releaseTagPattern: "v[0-9]*" }, newer, `http://127.0.0.1:${server.port}`)).rejects.toThrow("GitHub answered 403")
    } finally {
      server.stop(true)
    }
  })
  test("without a channel or GitHub releases, is the newest release tag, never a prerelease", async () => {
    const repo = await repoWithTags(["v1.0.0", "v1.1.0", "v1.2.0-rc.1"])
    expect(await latestRelease({ repo, releaseTagPattern: "v*" }, newer)).toBe("v1.1.0")
  })
})
