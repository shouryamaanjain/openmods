// A patch's header (the From line, the commit message and its trailers, such
// as Signed-off-by) is published with the mod, on GitHub and on openmods.dev.
// Email addresses in it are replaced with GitHub's private address for the
// author's handle, so publishing a mod never publishes an email. The diff
// itself is left alone.

const PRIVATE = /@users\.noreply\.github\.com$/i
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g

/** GitHub's private address for a handle. */
export const noreply = (handle: string) => `${handle}@users.noreply.github.com`

// The header ends at the "---" line before the diff (or, without one, at the
// first diff).
function split(text: string): [string, string] {
  const end = text.search(/^---$|^diff --git /m)
  return end < 0 ? [text, ""] : [text.slice(0, end), text.slice(end)]
}

/** The patch with every email in its header replaced by the handle's private address. */
export function withPrivateEmails(text: string, handle: string): string {
  const [head, rest] = split(text)
  return head.replace(EMAIL, (e) => (PRIVATE.test(e) ? e : noreply(handle))) + rest
}

/** The emails in a patch's header that are not private addresses. */
export function emailsIn(text: string): string[] {
  const [head] = split(text)
  return [...new Set((head.match(EMAIL) ?? []).filter((e) => !PRIVATE.test(e)))]
}
