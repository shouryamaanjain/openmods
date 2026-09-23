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

- Only a mod's owner, or a maintainer the owner listed, can change it; a new mod lives under its author's GitHub handle. The **standards** check enforces this, along with a README that discloses what the mod does with the network, files, commands and the agent's instructions, and patches that are readable source.
- Every pull request applies and typechecks the mod in CI against the release it names. The author builds it; CI does not.
- Greptile reviews the code the patches add, for correctness and for security: anything malicious, and anything the README does not disclose. For an update, a comment shows what it changes compared with the published update, as plain code.
- A registry maintainer reads the diff and the README and approves every change before it is merged.
- The hourly job that moves mods to new releases never changes a mod's code: if a rebase would change the reviewed lines, the mod waits for its maintainer instead.
- When the harness ships a new release, the hourly check applies and typechecks every mod against it, so a mod cannot silently drift, and holds every mod if the release changed how the harness builds.
- Your machine builds everything you install, from the release and the patches.
- Every modded build carries the OpenMods base patch, which sends feedback and crash reports to OpenMods rather than to the upstream project. Report problems with a modded build here, after checking whether they also happen with `openmods off`.

These are checks on the process, not a guarantee about intent. A malicious patch can pass all of them. Reading the diff is what protects you.

## The launcher and updates

`openmods` never rebuilds or installs anything without a yes. The launcher checks for updates in the background but only asks at an interactive terminal, and `OPENMODS_NO_PROMPT=1` or `OPENMODS_NO_CHECK=1` turn that off. Updates only ever move a mod to a release that CI has verified it builds on.

## Reporting a problem

Open an issue on the registry, or email the maintainer listed in the mod's `mod.json` for a problem with one mod. If a published mod is doing something harmful, say so in the issue title; it will be removed from the registry first and discussed after.
