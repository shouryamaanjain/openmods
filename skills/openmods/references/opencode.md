# OpenCode mods

OpenCode 2 (github.com/anomalyco/opencode, tags `v2.x.y`) is TypeScript on Bun, with the terminal UI in SolidJS on @opentui. Paths below are from v2.0.22; check them against the release you mod.

## Contents
- Setup and checks
- Where things live
- Adding things
- UI basics
- Shared with stock OpenCode
- Worked example: space-invaders

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
**As a built-in plugin:** a new file, registered in `packages/tui/src/plugin/builtins.ts` with an import and a list entry. Inside a plugin, use the plugin context, not the app's hooks:
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

**Directly in the app:** add an entry to the `appCommands` memo in `packages/tui/src/app.tsx` (around line 695):
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
The plugin slots, claimed from a built-in plugin:

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
Copy `feature-plugins/sidebar/context.tsx` (about 50 lines). For full control of the layout (exact widths, taking the keyboard), edit `component/session-frame.tsx` directly, as space-invaders does.

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

## Shared with stock OpenCode

- **The session database.** When stock OpenCode is the same release as the modded build, they share the user's sessions. A mod that changes database tables or migrations (`*.sql.ts`, `core/src/database/migration/`) gets a database of its own from OpenMods instead, so it doesn't share history with stock. For a mod's own state, `useStorage().store(key)` (TUI) or the core `KV` service need no migration.
- **The background service** (`opencode service`, `serve --service`) belongs to stock; modded OpenCode runs on its own private server next to it, and those commands start stock OpenCode.
- **Server routes** need `bun run generate` in `packages/client`, which rewrites the generated client; commit what it generates.

## Worked example: space-invaders

`mods/shouryamaanjain/space-invaders/opencode/` in the registry: one patch, three files, all TUI.

1. `packages/tui/src/component/invaders.tsx` (new, about 440 lines): the game. State lives in a module-level `createRoot`, so reopening resumes; a 50 ms interval runs only while open and not paused; keys come from a `Keymap.createLayer` with priority 20 that's enabled only while the game is open; the field is sized from `onSizeChange`; colours are theme tokens.
2. `packages/tui/src/app.tsx` (+15): an `appCommands` entry with `slash: { name: "invaders", aliases: ["space-invaders"] }` that toggles the game.
3. `packages/tui/src/component/session-frame.tsx` (+67/−34): gives the right pane, half the width, to the game and moves the keyboard focus to it.
