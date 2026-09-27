// The newest release of a harness, as its users get it. Most harnesses
// publish releases on GitHub, whose latest release is the answer: a repo can
// carry tags for prereleases or a next major nobody is meant to install yet.
// A harness that publishes elsewhere names its own channel (latestRelease in
// its definition): a URL answering JSON with a "version", and the tag that
// version is released as. Anything else falls back to the newest tag.
import { $ } from "bun"

export type ReleaseSource = { repo: string; releaseTagPattern?: string; latestRelease?: { url: string; tag: string } }

export async function latestRelease(h: ReleaseSource, newer: (a: string, b: string) => boolean): Promise<string> {
  if (h.latestRelease) {
    const res = await fetch(h.latestRelease.url, { headers: { accept: "application/json" } })
    if (!res.ok) throw new Error(`${h.latestRelease.url} answered ${res.status}`)
    const version = ((await res.json()) as { version?: unknown }).version
    if (typeof version !== "string" || !/^[\w.+-]+$/.test(version)) throw new Error(`${h.latestRelease.url} gave no version`)
    return h.latestRelease.tag.replace("{version}", version)
  }
  const gh = h.repo.match(/github\.com\/([^/]+)\/([^/.]+)/)
  if (gh) {
    const res = await fetch(`https://api.github.com/repos/${gh[1]}/${gh[2]}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) },
    })
    if (res.ok) {
      const tag = ((await res.json()) as { tag_name?: string }).tag_name
      if (tag) return tag
    }
  }
  const out = await $`git ls-remote --tags --refs ${h.repo} ${"refs/tags/" + (h.releaseTagPattern ?? "*")}`.text()
  const tags = out
    .split("\n")
    .map((l) => l.split("\t")[1]?.replace("refs/tags/", ""))
    .filter((t): t is string => !!t && /\d/.test(t))
  return tags.reduce((a, b) => (newer(b, a) ? b : a), tags[0] ?? "")
}
