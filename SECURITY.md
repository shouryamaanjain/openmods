# Security

## What a mod can do

A mod is source code compiled into the harness you run. Once installed it can do anything the harness can: read and write your files, run commands, make network requests, and change what the agent is told. There is no sandbox, because there is no boundary to put one on. That is the trade for being able to change anything.

Treat installing a mod the way you treat building any program from source: read it first.

## Reading a mod before you install it

- `openmods info <owner>/<mod>` lists every file the mod touches, per harness.
- The mod's page on the site shows the full diff. So does `mods/<owner>/<mod>/<harness>/<release>/` in the registry, one folder per version.
- A mod that adds network calls, reads files outside the project, or changes the agent's instructions should say so in its README. If the diff does something the README does not mention, do not install it, and open an issue.

The registry only carries patches. Nothing is prebuilt: your machine compiles the harness from its release plus the mod's patches, so what you read is what you run.

## What the registry checks

- Only a mod's owner, a maintainer the owner listed, or a registry maintainer can change it; a new mod lives under its author's GitHub handle. The **standards** check enforces this, along with a README that discloses what the mod does with the network, files, commands and the agent's instructions, and patches that are readable source.
- CI applies and typechecks each version of a mod that a pull request changes, on top of the OpenMods base patch as users build it, against the release it names; a failure blocks the merge. The author builds it; CI does not.
- Greptile reviews the code the patches add, for correctness and for security: anything malicious, and anything the README does not disclose. For an update, a comment shows what it changes compared with the published update, as plain code.
- A registry maintainer reads the diff and the README and approves every pull request before it is merged. The release bot's own commits go straight to main: they only add versions CI has checked on a new release, and record the results.
- The hourly job that moves mods to new releases never changes a mod's code: if a rebase would change the reviewed lines, the mod waits for its maintainer instead.
- When the harness ships a new release, the hourly check applies and typechecks every mod against it, so a mod cannot silently drift, and holds every mod if the release changed how the harness builds.
- Your machine builds everything you install, from the release and the patches.
- Modded builds carry the OpenMods base patch, for each release it has a version for. It adds no network access: it points feedback and crash reports at OpenMods rather than the upstream project, and for Codex turns off Codex's own update notice and its shared background server. Report problems with a modded build here, after checking whether they also happen with `openmods off`.

These are checks on the process, not a guarantee about intent. A malicious patch can pass all of them. Reading the diff is what protects you.

## The launcher and updates

`openmods` never rebuilds or installs anything without a yes. The launcher checks for updates in the background but only asks at an interactive terminal. `OPENMODS_NO_PROMPT=1` turns the question off, and `OPENMODS_NO_CHECK=1` the background check. Updates only ever move a mod to a release where CI has checked that it applies and typechecks.

## Reporting a problem

Report a vulnerability in OpenMods, or in a mod, privately: use **Report a vulnerability** on the repository's Security tab, so it can be fixed before it is public.

If a published mod is doing something harmful, open an issue instead, so users see it: start the title with "Harmful mod:" and name the mod. A maintainer labels it `harmful mod`, revokes the mod first, and discusses it after.

Other problems with a mod go in an issue that names it; its maintainers are listed in its `mod.json`.

## Revoked mods

A maintainer revokes a mod, or some of its updates, by listing it in `revoked.json` in the registry with the reason. From then on:

- `openmods install`, `on` and `update` refuse to build it.
- On machines that already have it, the daily update check, or `openmods update`, replaces the launcher: every launch says the mod was removed and why, and starts the stock harness instead of the modded build. `openmods on` refuses to switch the build back on.
- `openmods uninstall <owner>/<mod>` removes it, even after the mod's folder is gone from the registry.

A problem with a modded build that does not happen in your stock harness (`openmods off`) belongs here too, not with the harness's own project.
