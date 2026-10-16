---
name: launch-copse
description: >-
  Launch a branch build of Copse (copse-panel) from an agent session so a real
  window appears beside the live app. Use when asked to run, start, open, or
  look at the app — instead of `make run`, `pnpm start`, `pnpm run dev`, or
  `open`, which cannot reach the macOS window server from an agent sandbox.
---

# Launch Copse from a Copse agent session

`make run` is for a human terminal. From an agent it runs sandboxed, blocks
until killed, and — on the default profile — loses the single-instance lock to
the live Copse and quits. Use this recipe instead. The full rationale is in
`docs/agent-development.md#launching-copse-from-a-copse-agent-session`.

## Steps

1. **Build.** In an agent-prepared worktree, run `make build` through
   `run_shell` (not the ACP agent's own shell).
2. **Resolve paths.** Through `run_shell`:

   ```bash
   realpath node_modules/electron/dist/Copse.app
   realpath dist/main/index.js
   ```

3. **Launch** with the `launch_gui_app` tool (it always asks the user):

   ```json
   {
     "target": "<realpath of Copse.app>",
     "args": ["<realpath of dist/main/index.js>"],
     "env": { "COPSE_DIR": "<worktree>/.tmp/launch-profile" },
     "new_instance": true
   }
   ```

   - `args` must be absolute: Launch Services starts the app in `/`.
   - Always set `COPSE_DIR` to a fresh directory. Add `COPSE_PANEL_MOCK_LLM=1`
     when the check does not need a real model.

4. **Verify** — the tool result only means `/usr/bin/open` succeeded:
   - `<COPSE_DIR>/user-data/SingletonLock` exists;
   - `<COPSE_DIR>/user-data/config.json` contains a `mainWindowState` window.

   If neither appears within a few seconds, the app exited at startup; check
   that `dist/` is complete and that the paths were absolute.

## Afterwards

The window outlives the turn; tell the user it is open and that the profile
directory is disposable. A manual launch is not visual evidence — user-visible
changes still need a focused WebdriverIO spec
(`.cursor/skills/screenshot-validate/SKILL.md`).

macOS only; `launch_gui_app` is unavailable in SSH workspaces.
