# Controller paths

Read only the section for the tools available in the current session. Paths below
are relative to the Copse repository root. Follow the current checkout's tool
schemas and permission contract if capabilities have changed.

## Copse native agent or an ACP agent inside Copse

Use `isolated_copse` when available. It is exposed through Copse's ACP bridge as
well as to its native agent; Claude or Codex running inside Copse can therefore
use the same bounded control surface. Its presence is not proof of an end-to-end
authenticated ACP pass.

Read `docs/shell-permissions.md` and the setup/validation limits in
`docs/plans/apple-container-desktop.md`. The current implementation needs local
Apple silicon macOS, a running Apple container service, and a branch-built
`copse-desktop:local` image. The repository provides `probe:apple-desktop`,
`build:apple-desktop`, and `smoke:apple-desktop` scripts; inspect their help and
setup requirements before use. Building/running the image is separate from having
the tool in the catalog.

Build the host with `pnpm run build` before `build:apple-desktop`, including after
changes to guest setup scripts. The transport sends its compiled
`dist/main/apple-desktop-guest.cjs` into the guest; rebuilding only the container
image can leave that controller stale. Record both the host source and image pin.

Build with the same `COPSE_DIR` as the parent app: the builder writes a trusted
image receipt under that profile, and a receipt in the daily profile does not
authorize another profile. Do not copy or manufacture a receipt; rerun the
supported builder for the intended profile (its image layers can be cached).

If Claude sees no Copse tools although the bridge reports them offered, inspect
the actual advertised schemas before changing authentication or permissions.
Older builds advertised `isolated_copse` as a top-level union, which made Claude
drop the whole server and made LM Studio reject the turn. The fix landed in
`c1f414f4c` with later schema refinements on main. Check the tested build's ancestry
and existing fixes before implementing a new repair; an offered tool count alone
does not prove the agent loaded those tools.

1. Choose an API or supported ChatGPT model for the child. ACP agent sign-ins are
   not copied into it. Pass the model explicitly, especially from an ACP parent.
2. Start with `{ "action": "start", "model": "<supported model id>" }`. The
   tool requests fresh approval for this thread and its fixed model budget.
3. Use `{ "action": "screenshot" }` to observe the 1280×800 guest. Use observed
   coordinates with `click`, `type` text, and `key` such as `Return` or `ctrl+a`.
   Consult the live schema for bounds; the current `type` limit is 2,000 characters.
4. Drive the journey and save observable evidence before
   `{ "action": "stop" }` revokes access and deletes the VM.

Create the disposable project before opening guest Settings. The empty welcome
screen does not expose the sidebar Settings button. Once the project is open,
use the visible Settings entry; the current key schema does not accept the comma
shortcut. Do not repeat clicks on an absent sidebar or guess unsupported keys.

The current grant lasts at most 15 minutes / 100,000 input-and-output tokens and
has no shared host folders, credentials, host display, or general network access.
Use an offline, dependency-free sample. Package downloads, host-repository repairs,
authenticated ACP inside the guest, and overnight runs are not supplied by this
route. The guest cannot start another isolated Copse. Stop/cancellation/expiry
revokes access; an ACP grant is also bound to its parent turn/session. Keep an
interactive journey within that lifetime and capture evidence as it proceeds.
Chat, auxiliary tasks and automatic review share that token grant. A second edit
can be written before its turn or review exhausts the grant; record that as partial,
not a completed journey. Preserve default review unless the scenario explicitly
specifies otherwise, and label reviewer-off runs as configured passes.

Copse's `desktop_*` tools block the host Copse app to prevent self-approval.
`launch_gui_app` can open a branch window but does not grant control of it or VM
isolation. Do not replace a failed isolated guest with host clicks, shell-driven
input, or a WebdriverIO route to evade that boundary. Report the missing capability.

## Standalone Codex or Claude Code with computer use

For repeatable macOS ACP setup and thread export, use the
[fixture helpers](fixtures.md). They prepare fixtures and capture traces; the
controller still drives and verifies the real journey.

Use the host's actual computer-use tools and their documentation. Codex sessions
may expose `cua_repl`; Claude sessions may expose a different desktop tool or none.
Do not prescribe another host's tool name as if it were available.

Prepare the branch using `docs/agent-development.md`. For a Copse-managed launch,
build with `make build`, resolve the Electron bundle and `dist/main/index.js` to
absolute paths, and use `launch_gui_app` with a fresh `env.COPSE_DIR`. For a
standalone host without that tool, use its supported, approved GUI launch mechanism
with the same absolute entrypoint and isolated profile; do not copy an unavailable
tool call. Keep `ELECTRON_RUN_AS_NODE` out of a manual Electron launch environment.

Identify the child window by its process/profile and visible state before typing;
multiple instances may have the same application name or bundle ID. A launcher
returning success does not prove the child opened. Check startup state and the
actual window. If the controller cannot distinguish the child from the daily app,
stop before input and resolve the target.

Select the requested inner provider through supported Copse settings. Verify its
login independently of the outer host's login. Use
`docs/remote-agent-demo-debugging.md` for authenticated ACP provenance and visible
recording details, while retaining the current `COPSE_DIR` isolation contract.
Record the Copse provider route and, where evidence exposes it, the underlying
model separately. Do not infer the inner model from the outer agent's identity.

## WebdriverIO from an authorized host

Reuse `wdio.eval.conf.ts`, `tests/e2e/helpers/seed-config.ts`,
`tests/e2e/helpers/agent-eval-scenario.ts`, and the composer/wait/export patterns in
`tests/e2e/agent-eval-drive.e2e.ts`. Follow
`.agents/skills/agent-run-eval/SKILL.md` for commands and artifacts. Use Node 24+
and pnpm; use `pnpm run build` and the repository's `test:e2e:agent-eval` or focused
`test:e2e -- --spec ...` path appropriate to the selected config.

Inspect the selected driver's approval loop before executing it. The stock eval
driver approves all ordinary dialogs and accepts all proposed diffs, rejecting
only its special Guarded YOLO harm prompt. Prompt wording and a disposable project
do not contain those approvals. For real dogfooding, reuse a focused driver that
validates the requested operation, target and scope against the run authorization,
and rejects or pauses unexpected approvals. If none exists, adapt one at the test
boundary before running; do not change product permission policy to make it pass.
Use the stock driver only when its entire approval behavior is appropriate to an
explicitly authorized, contained scenario.

Set `workspace.type` to `tempProject` in scenarios: omitting it can operate in the
current Copse checkout. Seed only starting fixtures with the harness helpers, and
let Copse make the evaluated edits. Keep `COPSE_EVAL_MODEL` explicit and inspect
the config's ACP mode/authentication behavior. API-key environment variables alone
do not configure this harness. Never broaden the requested mode to unblock a run.

Preserve the generated workspace when needed with `COPSE_EVAL_KEEP_WORKSPACE=1`;
`COPSE_EVAL_KEEP_WDIO=1` retains diagnostic WDIO directories. The stock driver prints
`COPSE_EVAL_ARTIFACT=...`; a focused driver must likewise save evidence on failure.
Do not assume screenshot capture or trace export happens automatically in every
driver. When asserting a UI outcome, assert the DOM and save a focused screenshot.
Analyze a saved trace with `pnpm run analyze:thread <trace.jsonl>` (optionally followed
by a scenario file). Do not add a standalone `--`: pnpm forwards it to this script,
which reads positional file paths.
Serialize drivers sharing a display, profile, or harness environment file. Wait
for owned processes to exit and preserve reports before deleting owned state.
