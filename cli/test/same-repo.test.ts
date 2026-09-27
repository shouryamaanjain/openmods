// When a check workspace's origin counts as the harness's repository
// (cli/src/same-repo.ts).
import { describe, expect, test } from "bun:test"
import { sameRepo } from "../src/same-repo"

const codex = "https://github.com/openai/codex"

describe("sameRepo", () => {
  test("one repository at its usual addresses", () => {
    for (const u of [
      "https://github.com/openai/codex.git",
      "https://github.com/openai/codex/",
      "https://github.com:443/openai/codex",
      "https://GitHub.com/OpenAI/Codex",
      "git@github.com:openai/codex.git",
      "ssh://git@github.com/openai/codex",
      "ssh://git@github.com:22/openai/codex.git",
    ])
      expect(sameRepo(u, codex), u).toBe(true)
    expect(sameRepo("/tmp/fake-harness/", "file:///tmp/fake-harness")).toBe(true)
  })
  test("another repository, host or port is not it", () => {
    for (const u of ["https://github.com/openai/codex-fork", "https://gitlab.com/openai/codex", "https://github.com:8443/openai/codex", "", "https://github.com/other/codex"])
      expect(sameRepo(u, codex), u).toBe(false)
  })
  test("a plain http:// or git:// address matches only itself", () => {
    for (const u of ["http://github.com/openai/codex", "http://github.com:80/openai/codex", "git://github.com/openai/codex"]) {
      expect(sameRepo(u, codex), u).toBe(false)
      expect(sameRepo(u, u)).toBe(true)
    }
  })
})
