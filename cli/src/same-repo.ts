// Whether two addresses are one repository: https, ssh and scp-style ones
// compare equal with or without .git, a trailing slash or the default port.
// A plain http:// or git:// address, which anyone on the way can change,
// only ever matches itself.
export function sameRepo(a: string, b: string) {
  const insecure = (u: string) => /^(?:http|git):\/\//i.test(u.trim())
  if (insecure(a) || insecure(b)) return a.trim() === b.trim()
  const norm = (u: string) =>
    u
      .trim()
      .toLowerCase()
      .replace(/^(?:https|ssh|git\+ssh|file):\/\/(?:[^@/]+@)?/, "")
      .replace(/^[^@/]+@([^:/]+):/, "$1/")
      .replace(/^([^/:]+):(?:443|22)\//, "$1/")
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
  return norm(a) === norm(b)
}
