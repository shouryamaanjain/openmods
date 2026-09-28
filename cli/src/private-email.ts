// A patch's header is published with the mod, on GitHub and on openmods.dev.
// The addresses git puts in it are replaced with GitHub's private address for
// the author's handle, so publishing a mod never publishes an email: the one
// in the From line, and those of trailers such as Signed-off-by and
// Co-authored-by. Whatever the address looks like, the <...> of those lines
// is replaced. The rest of the commit message, like the diff, is the author's
// own text and is left as written.

const PRIVATE = /@users\.noreply\.github\.com$/i
// "From: Name <address>", and trailers: "Signed-off-by:", "Co-authored-by:",
// "Reviewed-by:", "Cc:" and the like, each "Name <address>".
const ADDRESSED = /^(From|Cc|[A-Za-z][A-Za-z-]*-[Bb]y): (.*?)<([^<>\n]*)>[ \t]*$/gm

/** GitHub's private address for a handle. */
export const noreply = (handle: string) => `${handle}@users.noreply.github.com`

/**
 * A patch split into its header and its diff, at the first "diff --git"
 * line: a "---" in the commit message does not end the header.
 */
export function headerAndDiff(text: string): [string, string] {
  const at = text.search(/^diff --git /m)
  return at < 0 ? [text, ""] : [text.slice(0, at), text.slice(at)]
}

/** The patch with the addresses in its From line and trailers replaced by the handle's private address. */
export function withPrivateEmails(text: string, handle: string): string {
  const [head, diff] = headerAndDiff(text)
  return head.replace(ADDRESSED, (line, key: string, name: string, address: string) => (PRIVATE.test(address.trim()) ? line : `${key}: ${name}<${noreply(handle)}>`)) + diff
}

/** The addresses in a patch's From line and trailers that are not private ones. */
export function emailsIn(text: string): string[] {
  const [head] = headerAndDiff(text)
  return [...new Set([...head.matchAll(ADDRESSED)].map((m) => m[3]!.trim()).filter((a) => a && !PRIVATE.test(a)))]
}

/**
 * What a set of patches changes, without line numbers, context or commit
 * messages: the same code rebased onto another release, or with a reworded
 * or scrubbed message, compares equal. Numbers updates (pack) and guards the
 * release watch's rebases.
 */
export const codeOf = (texts: string[]) =>
  texts
    .flatMap((t) => headerAndDiff(t)[1].split("\n").filter((l) => /^[-+]/.test(l) && !/^(\+\+\+|---)( |$)/.test(l)))
    .join("\n")
