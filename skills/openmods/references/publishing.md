# Publishing a mod

Everything from a packed mod to a merged pull request, and how updates work afterwards.

## Contents
- The mod folder
- mod.json
- support.json
- The README
- Checking it
- The pull request: standards and reviews
- Updates and new releases
- Commands for authors

## The mod folder

`openmods pack . --name <mod> --registry <your fork>` writes:

```
mods/<owner>/<mod>/
  mod.json                     shared by every harness
  README.md                    shared by every harness
  <harness>/support.json       one version per release
  <harness>/<release tag>/0001-….patch
```

Nothing else may be in it. `<harness>/status.json` appears later; only CI writes it. Packing from another harness's clone adds that harness's folder next to the first and keeps the shared files as you edited them.

The owner is your GitHub handle in lowercase (`git config github.user`, else the GitHub CLI's login, else `--owner`). A new mod must live under your own handle. The name is lowercase letters, digits and hyphens.

## mod.json

| field | meaning |
|---|---|
| `owner`, `name` | must match the folder |
| `description` | one line for the listing, up to 200 characters; replace pack's TODO |
| `license` | the mod's license; pack starts it as the harness's own (OpenCode MIT, Codex Apache-2.0, fx Apache-2.0), and any other must be compatible with it |
| `tags` | a few words for the listing, e.g. `["tui", "game", "command"]` |
| `author` | your name and handle, filled in by pack |
| `maintainers` | GitHub handles the release bot mentions when a release breaks the mod; defaults to the owner. Only listed maintainers (and registry maintainers) can change the mod later. |

There is no `version` field: a mod is "for OpenCode 2.0.22", and its updates are numbered per version in support.json. Unknown fields are rejected, so typos are caught.

## support.json

pack writes and maintains it; you rarely edit it by hand.

- `versions`, newest first, one per release: `ref` (the tag), `commit` (that tag's commit; it must be the release's own, which the registry and `openmods` both check), `patches` (in order), `update` (which update of the mod's code this is) and `note` (what that update changed, up to 200 characters).
- `conflicts` (optional, hand-written): other mods, as `owner/name`, that break this one on this harness *without* touching the same lines, such as two mods that bind the same key in different files. Mods that change the same lines are found automatically; don't list those.

Older versions stay when a new one is added, so users whose other mods are still on an older release can build yours with them.

## The README

It's the mod's page on openmods.dev and in `openmods info`: what users read before they build it. pack writes a stub; fill in every TODO.

```markdown
# <mod>

What the mod changes and why, in a sentence or two. How to use it: the command,
the keys, where it appears. A screenshot or recording if it changes what you see.

## Permissions

- Network: none
- Files: none
- Commands: none
- Agent instructions: unchanged

## What it changes

| file | change |
| --- | --- |
| `packages/tui/src/component/thing.tsx` | New. The feature. |
| `packages/tui/src/plugin/builtins.ts` | Registers it. |

## Install

    openmods install <owner>/<mod>
```

**Permissions is checked.** It must cover network, files, commands and agent instructions, with no TODO left. Write "none" or "unchanged" where the mod does nothing, and otherwise say exactly what: which hosts it contacts and why, which files outside the harness's usual ones it reads or writes, which commands it runs, what it adds to what the agent is told. Greptile compares this section with the code, and an undisclosed behavior gets the mod rejected.

A per-harness "What it changes" table helps reviewers and users; `openmods info` lists the touched files from the patches either way.

## Checking it

```sh
openmods check mods/<owner>/<mod>/<harness> --build        # full build, as users get it
openmods check mods/<owner>/<mod>/<harness> --typecheck    # what CI runs
openmods check mods/<owner>/<mod>/<harness> --at <tag> --build   # an older version
openmods check <owner>/<mod> --<harness> --build           # a published mod
```

It clones the harness into a reusable workspace in your temp folder, checks out the release, applies the patches as an install does, and typechecks or builds. Run `--build` before opening the PR: CI typechecks every changed version, and builds OpenCode and fx mods, but never builds Codex mods (too slow), so the author's build is the one that counts there.

Also install it with your other mods (`openmods install .` from the harness clone, which does a full release build), and use it.

**A local mod shadows the registry's.** `openmods install .` packs the mod into `~/.openmods/local/<owner>/<mod>`, and while that exists, `openmods info` and `install` use it instead of the copy in your fork (it shows as "local, unpublished", with pack's TODO description). Your edits to the fork's copy aren't lost. Delete the local folder once the mod is published.

Run the registry's own checks from the fork too: `bun script/validate.ts` (the registry lint, including that each version pins its release's commit) and the standards check below.

## The pull request: standards and reviews

Commit only `mods/<owner>/<mod>/` in your fork and open a pull request to `shouryamaanjain/openmods`. Describe what the mod does; add a screenshot or recording if it changes what you see.

The **standards** check enforces:
- one mod per pull request, and nothing outside its folder;
- ownership: a new mod under your handle; an existing one only by its owner or a listed maintainer (a PR can't add its own author to `maintainers`);
- the README's Permissions section, complete and without TODO;
- a `note` on every update after the first (`openmods pack --note "…"`); a brand-new mod doesn't need one;
- readable patches: no binary files, no line over 1,000 characters, no patch over 1 MB;
- no email addresses in patch headers other than GitHub's private ones (pack writes `<you>@users.noreply.github.com` into `From:` and trailers; the rest of each commit message is published as written);
- only the allowed files in the folder; no `status.json`.

Changes to the harness's dependencies or build files are allowed but listed for reviewers and labelled `build files`.

Run it yourself before pushing, from the fork with the mod committed, against the registry's current `main` (a stale one hides an existing mod's earlier updates): `git fetch https://github.com/shouryamaanjain/openmods main && bun script/pr-check.ts --base FETCH_HEAD --head HEAD --author <you>`.

Then:
1. **Apply and typecheck:** CI applies each changed version to its release and typechecks (and builds OpenCode and fx mods). A failure blocks the merge.
2. **Greptile** reviews the code for correctness, fit with the harness, and security: anything malicious, and anything Permissions doesn't disclose.
3. **For an update,** a comment shows what changed compared with the published update.
4. **A maintainer** reads it all and approves. Every PR needs this.

Labels say what kind of change it is: `mod: new`, `mod: update`, `build files`.

## Updates and new releases

- **Automatic:** every hour a job checks each harness's newest release. If a mod's newest version still applies and typechecks there, and the rebased patches change exactly the lines a maintainer reviewed, the bot adds a version for the new release with the same update number and note. Only the newest release is checked, so a skipped release gets no version of its own.
- **When it fails:** an issue labelled `conflict`, titled "<owner>/<mod> does not support <Harness> <release>", mentions the maintainers with the rebase commands filled in. The mod stays on its last working release (and still installs there) until a new version is merged; the issue closes itself then.
- **Rebase by hand** (in the harness clone):
  ```sh
  git fetch --tags
  git checkout -b <mod> <last-supported-tag>
  git am ../openmods/mods/<owner>/<mod>/<harness>/<last-supported-tag>/*.patch
  git rebase --onto <new-tag> <last-supported-tag> <mod>
  openmods install . --owner <owner>
  openmods pack . --name <mod> --owner <owner> --registry ../openmods --note "works on <Harness> <new release>"
  ```
  If only the rebase changed, pack keeps the same update number; if the code changed, it's the next update.
- **Shipping a fix or feature:** change the commits, `openmods pack . --name <mod> --owner <owner> --registry ../openmods --force --note "what changed"` (`--force` replaces the version for that release). Users are offered the update once, with the note.
- **Removed mods:** a mod found to do harm is listed in the registry's `revoked.json`; every user's build that contains it stops running (the launcher starts the stock harness instead) until they uninstall it.

## Commands for authors

| command | what it does |
|---|---|
| `openmods dev [clone]` / `--stop` | the harness command runs your clone from source |
| `openmods install .` | pack as a local mod (`~/.openmods/local`, never published) and build it |
| `openmods pack . --name <mod> --registry <fork>` | write the mod into your registry fork (`--local`, `--owner`, `--note`, `--force`, `--base <tag>`) |
| `openmods check <folder> --typecheck \| --build` | apply and check against the release (`--at`, `--ref`, `--workspace`, `--json`) |
| `openmods info <owner>/<mod>` | what a mod touches, and which mods it can't be installed with |

`openmods help <command>` has the details.
