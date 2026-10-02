# OpenCode mods

OpenCode 2 (github.com/anomalyco/opencode, tags `v2.x.y`) is TypeScript on Bun, with the terminal UI in SolidJS on @opentui. Paths below are from v2.0.22; check them against the release you mod.

## Contents
- First: does it need to be a mod?
- Setup and checks
- Where things live
- Adding things (least invasive hook first)
- UI basics
- What not to touch
- Worked example: space-invaders

## First: does it need to be a mod?

OpenCode 2 loads TUI plugins from outside its source: a folder per plugin in `~/.config/opencode/plugins/<name>/` or a project's `.opencode/plugins/<name>/`, and packages listed under `plugins` in `~/.config/opencode/cli.json`. They use the same `Plugin.define` API as the built-in plugins (slots, key layers, slash commands, toasts, dialogs, storage), and core-side plugins can add tools and agents.

So a feature that only *adds* something through that API (a slash command, a panel in a slot, a keybinding, a toast) should be a plugin, not a mod; tell the user, and offer the plugin instead. A mod is for what plugins can't reach: changing existing behavior or layout, the agent loop, built-in tools, the prompt, the CLI. If the user wants a mod anyway (to bundle it, or as a starting point for deeper changes), the built-in-plugin pattern below keeps it to a new file and two lines.

## Setup and checks

- **Bun:** use exactly the version in the root `package.json` `packageManager` field (`bun@1.4.2` for v2.0.22). `openmods dev` and builds fetch it for you; for your own commands, install it with `curl -fsSL https://bun.sh/install | bash -s bun-v<version>`.
- `bun install` at the repo root, once.
- **Typecheck** the packages you touch (this is what CI runs on your mod):
  ```sh
  bun turbo typecheck --filter=@opencode/tui
  bun turbo typecheck --filter=@opencode/cli
  bun turbo typecheck --filter=@opencode/core
  ```
- **Tests:** `bun test` inside a package. The root deliberately refuses to run tests. A few tests can fail on a stock release on some machines (timeouts, Node ESM reloads); if something fails, check whether it also fails without your change (`git stash`) before chasing it.
- **Run from source** without OpenMods: `bun dev [dir]`, or `bun dev --standalone` for a private server. `openmods dev` does the same through the `opencode` command.
- A source run uses its own channel: its own background server and its own database (`opencode-local.db`), so it never touches your real sessions. Core or server changes take effect after the service restarts (`/restart`), or with `--standalone`.

## Where things live

| Package | What it is |
|---|---|
| `packages/tui` | The whole terminal UI. Most mods live here. |
| `packages/cli` | The `opencode` entry point and CLI commands. |
| `packages/core` | The agent runtime: tools, agents, sessions, config, database. Runs in the server process. |
| `packages/server`, `packages/protocol` | HTTP handlers and endpoint contracts. |
| `packages/schema` | Wire and config schemas (server config `Info` in `src/config.ts`). |
| `packages/client` | Generated client. Never hand-edit `src/*/generated`. |
| `packages/plugin` | The plugin API types (`SlotMap`, `KeymapCommand`) in `src/tui/context.ts`. |

There is no `packages/opencode` in v2. `app`, `desktop`, `web`, `console` and the rest are not the terminal UI.

## Adding things

### A slash command
**Smallest patch:** a built-in plugin in a new file, registered in `packages/tui/src/plugin/builtins.ts` with one import and one list entry (placed next to a related plugin, not at either end of the list). Inside a plugin, use the plugin context, not the app's hooks:
```tsx
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "opencode.hello",
  setup(context) {
    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "opencode.hello",
            title: "Say hello",
            slash: { name: "hello" },
            run: () => context.ui.toast.show({ message: "Hello from my mod", variant: "info" }),
          }],
        }))
        return null
      },
    })
  },
})
```
Check the import path and context methods against `packages/plugin/src/tui/context.ts` for your release; copy `feature-plugins/prompt/btw.tsx` (arguments, a dialog, keys) or `feature-plugins/system/notifications.ts`. A command id needs an entry in `config/keybind.ts` only if users should be able to rebind it.

**Direct:** add an entry to the `appCommands` memo in `packages/tui/src/app.tsx` (around line 695), next to a command it's related to. Avoid the obvious spots (first, last, just before `app.exit`): mods that insert at the same spot overlap and can't be installed together.
```ts
{
  name: "opencode.mything",
  title: "Do my thing",
  slash: { name: "mything", aliases: ["mt"] },
  run: () => { dialog.clear(); /* … */ },
  category: "System",
},
```
`slash: { arguments: true }` passes the text after the command to `run`. The full command shape is `KeymapCommand` in `packages/plugin/src/tui/context.ts`.

Server-side prompt commands are different (`packages/core/src/plugin/command.ts`), and users can define those in config without a mod.

### A keybinding
- Configurable: add `"my.cmd": keybind("<leader>z", "Description")` to `Definitions` in `packages/tui/src/config/keybind.ts` (config parsing throws on unknown names, so it must be listed), then give the command that id, or list it in `appBindingCommands` in `app.tsx`.
- Local to your feature: an inline command `{ bind: "left", title, run }` inside `Keymap.createLayer(() => ({ priority, enabled, mode, commands }))`. The leader key is `ctrl+x` by default.

### A dialog
`const dialog = useDialog()` (`packages/tui/src/ui/dialog.tsx`), then `dialog.replace(() => <MyDialog/>)` and `dialog.clear()`. Copy `ui/dialog-alert.tsx`, `ui/dialog-confirm.tsx`, `ui/dialog-select.tsx` or `ui/dialog-prompt.tsx`. Keys inside a dialog use a layer with `mode: "modal"`.

### A panel (sidebar, right pane, above the prompt, footer)
Use the plugin slots; a claim in a built-in plugin is a new file plus one line in `builtins.ts`:

| Slot | Where |
|---|---|
| `"sidebar.content"`, `"sidebar.footer"` | the session sidebar |
| `"session.composer.top"` | above the prompt |
| `"session.panel"` | the right pane; open with `ctx.ui.panel.open(name)` |
| `"prompt.footer"`, `"prompt.footer.status"`, `"prompt.footer.file"` | the prompt footer |
| `"home.footer"` | the home screen |
| `"app"` | app-level, for hooks with nothing to draw |

```ts
export default Plugin.define({ id: "opencode.sidebar.mine", setup(ctx) {
  ctx.ui.slot({ append: "sidebar.content", render: (props) => <Mine sessionID={props.sessionID} /> })
}})
```
Copy `feature-plugins/sidebar/context.tsx` (about 50 lines). Edit `component/session-frame.tsx` directly only if a slot can't do what you need (exact widths, taking the keyboard); that file is large and changes often, so expect conflicts.

### A theme
Usually no mod: users drop `<name>.json` into `~/.config/opencode/themes/`. To build one in, add the JSON to `packages/tui/src/theme/assets/` and to `DEFAULT_THEMES` in `packages/tui/src/theme/v1.ts`. Components pick theme tokens by role (`theme.text.feedback.error.base`, `theme.border.base`), not raw colours.

### A tool the agent can call
Create `packages/core/src/tool/plugin/<name>.ts` (copy `glob.ts`) and add it to the `pre` array in `packages/core/src/plugin/internal.ts`. Follow `packages/core/src/tool/AGENTS.md`: call `permission.assert` for anything that touches the system, and return `ToolFailure` for expected errors. The tool's `description` is where the agent learns about it. Disclose what it does in the mod's Permissions.

### An agent or mode
`ctx.agent.transform` with `editor.update(Agent.ID.make("name"), item => { … })`; see `packages/core/src/plugin/agent.ts` and `plugin/plan.ts`. Users can also define agents in `opencode.json` without a mod.

### A config key
- Server and agent side: a field on `Info` in `packages/schema/src/config.ts`, read with `Config.latest(entries, "key")` (pattern in `core/src/config/plugin/tool-output.ts`).
- TUI side: a field on `Info` in `packages/tui/src/config/index.tsx` (stored in `~/.config/opencode/cli.json`), read with `useConfig().data.x`.
- Prefix mod keys so they can't collide with a future upstream key.

### A CLI subcommand
Add `Spec.make("name", { description, params })` to `packages/cli/src/commands/commands.ts`, a handler in `packages/cli/src/commands/handlers/<name>.ts` (copy `reload.ts` or `debug/paths.ts`), and its lazy import in the `Runtime.handlers(...)` map in `packages/cli/src/index.ts`.

## UI basics

- JSX elements: `<box>` (flexbox: `flexDirection`, `flexGrow`, `width`, `border`, `borderStyle="rounded"`, padding, `onSizeChange`), `<text fg wrapMode="none">`, `<span style={{ fg }}>`, `<scrollbox>`, `<markdown>`.
- Signals re-render automatically. Terminal size: `useTerminalDimensions()` from `@opentui/solid`; your own box's size: `onSizeChange={function () { this.width; this.height }}`.
- Keys: in app components, `Keymap.createLayer` (respects modals and focus); in a plugin, `context.keymap.layer`. Raw keys: `useKeyboard((e) => …)`.
- Hooks: `useTheme()`, `useRoute()`, `useToast().show({ message, variant })`, `useDialog()`, `useConfig()`.
- Small components to copy: `component/spinner.tsx`, `shimmer-text.tsx`, `logo.tsx`, `ui/link.tsx`.

## What not to touch

- **Database tables and migrations** (`*.sql.ts`, `core/src/database/migration/`). When stock OpenCode is the same release as the modded build, they share the user's session database, and a migration can't be undone when the mod is uninstalled. OpenMods keeps a mod that changes these files on its own database, so its users lose shared history. Keep state in `useStorage().store(key)` (TUI) or the core `KV` service instead.
- **Server routes** need `bun run generate` in `packages/client`, which rewrites many generated files: a noisy patch that conflicts on every release. Avoid them if you can.
- **`bun.lock` and `package.json` dependencies.**
- **The background service** (`opencode service`, `serve --service`): stock owns it. Modded OpenCode runs on its own private server next to it.

## Worked example: space-invaders

`mods/shouryamaanjain/space-invaders/opencode/` in the registry: one patch, three files, all TUI.

1. `packages/tui/src/component/invaders.tsx` (new, about 440 lines): the game. State lives in a module-level `createRoot`, so reopening resumes; a 50 ms interval runs only while open and not paused; keys come from a `Keymap.createLayer` with priority 20 that's enabled only while the game is open; the field is sized from `onSizeChange`; colours are theme tokens.
2. `packages/tui/src/app.tsx` (+15): an `appCommands` entry (just before `app.exit`, the spot a second mod would most likely pick too) with `slash: { name: "invaders", aliases: ["space-invaders"] }` that toggles the game.
3. `packages/tui/src/component/session-frame.tsx` (+67/−34): gives the right pane, half the width, to the game and moves focus to it. This is the large, fragile part; a `session.panel` slot claim would have been smaller, at the cost of the exact half split and full keyboard capture.
