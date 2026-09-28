// A patch's header (the From line, the commit message and its trailers, such
// as Signed-off-by) is published with the mod, on GitHub and on openmods.dev.
// Email addresses in it are replaced with GitHub's private address for the
// author's handle, so publishing a mod never publishes an email. The diff
// itself is left alone.

const PRIVATE = /@users\.noreply\.github\.com$/i
// Any address: a local part, then a domain that starts with a letter, in any
// script, with or without dots (alice@intranet, alice@bücher.de). A version
// such as pkg@1.2.3 is not one.
const EMAIL = /[\p{L}\p{N}._%+-]+@\p{L}[\p{L}\p{N}.-]*/gu

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

/** The patch with every email in its header replaced by the handle's private address. */
export function withPrivateEmails(text: string, handle: string): string {
  const [head, diff] = headerAndDiff(text)
  return head.replace(EMAIL, (e) => (PRIVATE.test(e) ? e : noreply(handle))) + diff
}

/** The emails in a patch's header that are not private addresses. */
export function emailsIn(text: string): string[] {
  const [head] = headerAndDiff(text)
  return [...new Set((head.match(EMAIL) ?? []).filter((e) => !PRIVATE.test(e)))]
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
