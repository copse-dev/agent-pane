# External agent execution mode

Status: implementation ready for PR review; native visual validation remains open.

## Task brief

An external coding agent can run a thread using its own default permission behavior and full toolset. The chat input’s overflow menu lets the user choose **Copse managed** (default) or **Agent managed** for that thread. The default has no footer badge; Agent managed has a visible badge. The UI does not use the protocol name.

The choice applies to the next turn, survives reopening the thread, and follows the thread when the user switches among supported external agents. Switching changes the session fingerprint so an existing process with the previous sandbox or mode cannot be reused.

In Agent managed, Copse does not wrap the process in its project sandbox. It selects the agent-advertised Auto/Default session mode instead of replaying a saved Plan mode, without changing the agent's saved settings for Copse-managed threads. The composer hides the conflicting mode selector while retaining other agent options. Copse does not inject its prompt steering or synthesize an unfinished-turn continuation. Requests the agent sends to its client remain visible for user approval. The Copse tool bridge stays available, and each bridge call retains its ordinary Copse gate. Copse reports the agent's streamed activity and audits changes it did not mediate.

## Acceptance evidence

- Focused tests cover payload validation, the agent-managed permission path, and the composer choice.
- A browser/Electron spec opens the overflow menu, asserts the selected mode and badge, and captures the dialog and active composer.
- Because this changes the sandbox and permission boundary, run the full local check and focused Electron spec before delivery. Verify session reuse and a real agent prompt where the environment permits.

## Completion evidence

- `pnpm run build` and `pnpm run check:local` passed. Focused payload, thread-store, ACP permission/mode, and picker tests passed (104/104).
- The branch build launched through macOS Launch Services with an isolated profile. The user confirmed the mode behavior looked good in the app.
- The focused Electron spec could not create a browser session in this sandbox, so it produced no review screenshot. The full `pnpm run check` passed its static stages but the unit suite encountered sandbox-denied local listeners and sockets; it was stopped after failures were recorded. Both remain required on a capable validation host before merge.
