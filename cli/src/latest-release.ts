// The newest release of a harness, as its users get it. Most harnesses
// publish releases on GitHub, whose latest release is the answer: a repo can
// carry tags for prereleases, a next major nobody is meant to install yet, or
// old numbers from before a reset (fx's v0.4.5 came before its v0.0.1). So
// when GitHub cannot be asked, there is no answer; only a repo with no
// releases at all is read from its tags.
// A harness that publishes elsewhere names its own channel (latestRelease in
// its definition): a URL answering JSON with a "version", and the tag that
// version is released as. Anything else falls back to the newest release tag,
// leaving out prereleases such as 1.2.0-rc.1.
import { $ } from "bun"

export type ReleaseSource = { repo: string; releaseTagPattern?: string; latestRelease?: { url: string; tag: string } }

export async function latestRelease(h: ReleaseSource, newer: (a: string, b: string) => boolean, api = "https://api.github.com"): Promise<string> {
  if (h.latestRelease) {
    const res = await fetch(h.latestRelease.url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`${h.latestRelease.url} answered ${res.status}`)
    const version = ((await res.json()) as { version?: unknown }).version
    if (typeof version !== "string" || !/^[\w.+-]+$/.test(version)) throw new Error(`${h.latestRelease.url} gave no version`)
    return h.latestRelease.tag.replace("{version}", version)
  }
  const gh = h.repo.match(/github\.com\/([^/]+)\/([^/.]+)/)
  if (gh) {
    const res = await fetch(`${api}/repos/${gh[1]}/${gh[2]}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    })
    if (res.ok) {
      const tag = ((await res.json()) as { tag_name?: string }).tag_name
      if (tag) return tag
      throw new Error("GitHub's latest release has no tag")
    }
    // 404: the repo publishes no releases, so its tags are the releases.
    if (res.status !== 404) throw new Error(`GitHub answered ${res.status} when asked for the latest release`)
  }
  const out = await $`git ls-remote --tags --refs ${h.repo} ${"refs/tags/" + (h.releaseTagPattern ?? "*")}`.text()
  const tags = out
    .split("\n")
    .map((l) => l.split("\t")[1]?.replace("refs/tags/", ""))
    .filter((t): t is string => !!t && /\d/.test(t) && !/\d-/.test(t))
  return tags.reduce((a, b) => (newer(b, a) ? b : a), tags[0] ?? "")
}
