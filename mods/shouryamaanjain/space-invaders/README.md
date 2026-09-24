# space-invaders

Adds a `/invaders` slash command (also `/space-invaders`) that opens Space Invaders in the right half of the session screen, in place of the sidebar. The conversation keeps the left half and the agent keeps working while you play; its messages rewrap to fit.

## How to play

| key | while the game is open |
| --- | --- |
| `←` `→` | move |
| `space` | fire (hold it to keep firing), or play again after game over |
| `p` | pause and resume |
| `esc` | close the game; it pauses, and `/invaders` brings it back where it left off |

Five rows of invaders march across and down, faster as they thin out, and drop bombs. You can have three shots in the air at once. A mystery ship crosses the top now and then for bonus points. You start with three lives and earn another every 1500 points, up to five; clear a wave and the next starts lower. The field fits whatever half of the screen it gets, and starts the current wave again if you resize the terminal.

While the game is open, the prompt stays in view but does not take keys, so playing never types into it.

## Permissions

- Network: none
- Files: none
- Commands: none
- Agent instructions: unchanged

## What it changes

| file | change |
| --- | --- |
| `packages/tui/src/component/invaders.tsx` | New. The game and its panel. |
| `packages/tui/src/app.tsx` | Registers the `/invaders` command. |
| `packages/tui/src/routes/session/index.tsx` | Gives the right half of the session screen to the game while it is open. |

## Install

```sh
openmods install shouryamaanjain/space-invaders --opencode
```
