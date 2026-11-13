# Repeatable macOS ACP journey

Use these helpers from a standalone controller with authorized computer use. They package
the setup and export steps tested with Codex → Copse → Codex ACP. Claude uses the
same fixture with its own ACP adapter and `default` permission mode; validate its
live journey separately. These helpers do not replace `isolated_copse` when
the controller itself runs inside Copse.

Run from the Copse checkout with its dependencies installed and Node 24+. Record
the actual controller, account access and time/spend boundary before launching.

## Prepare

1. Build the source with `pnpm run build`.
2. Check the selected CLI's supported authentication status. If signed out, use
   its official sign-in flow and let the user complete it. An execution approval
   is not authentication; never copy credentials between profiles or providers.
3. Resolve the installed **ACP adapter**, then run one of:

```sh
node .agents/skills/copse-dogfood/scripts/prepare-acp.mts --provider codex --agent-command /absolute/path/to/codex-acp
node .agents/skills/copse-dogfood/scripts/prepare-acp.mts --provider claude --agent-command /absolute/path/to/claude-agent-acp
```

The helper creates a unique `.tmp/copse-dogfood-*` run containing an empty Git
project, a fresh profile seeded through the repository harness, a uniquely named
copy of the Electron runtime, two prompt files, and an evidence brief. It signs
only the copied runtime. No inference or GUI launch happens during preparation.
It uses the installed runtime at `node_modules/electron/dist/Copse.app`; pass
`--electron-app /absolute/path/to/Copse.app` if the checkout uses another location.
It does not build the source or establish build freshness itself.

Inspect `evidence/brief.json` and fill in the actual controller and run boundary.
`launch-command.txt` contains a shell-quoted macOS Launch Services command with
absolute paths. Run it through the host's authorized launch mechanism, requesting
escalation if required. It uses `COPSE_AGENT_EVAL=1` for independent-instance and
ambient-MCP isolation. The profile selects `acp:codex-acp` in `agent` mode or
`acp:claude-acp` in `default` mode, with Copse subagents disabled. It uses the
provider's existing supported sign-in; no sign-in is copied into the profile.

## Drive and verify

Target the returned application path/bundle ID and confirm the empty sample
project before input. Paste `prompt-1.txt` through the composer. After completion,
independently add Alder and Birch in the generated page, check that input clears,
and confirm whitespace creates no row. Save a screenshot and observed results.

Paste `prompt-2.txt` through the composer. After completion, remove Alder, confirm
Birch remains, and add Cedar. Check the generated files and record independent
assertions appropriate to their actual implementation. Do not seed the expected
implementation, fix the sample externally, or count the inner agent's claims as
verification. Inspect any approval against the bounded journey; these helpers have no
automatic approval handler.

Stop after two prompts or 20 minutes unless the user selected another boundary.
Capture blockers before recovery. Quit the owned app through its UI, then confirm
it and its preview server exited. Do not query a stale app handle to confirm exit
if the host tool reopens apps on lookup. Keep the daily app running.

## Export

After shutdown, export the stored thread and raw event/blob directory:

```sh
node .agents/skills/copse-dogfood/scripts/export-thread.mts --run /absolute/path/to/run
pnpm run analyze:thread /absolute/path/to/exported-thread.jsonl
```

Each export uses a fresh `evidence/export-*` directory and writes `index.json` with
trace paths. It exports every thread under the fixture's `dogfood-reading-list`
project. It uses the actual thread-store reader and JSONL serializer, with all
dependencies bundled; no separate package install is needed. An empty store fails
instead of reporting a live pass. Preserve screenshots separately and identify
whether they came from the outer controller or an inner screenshot tool.

Record actual pass/fail/blocked outcomes, source SHA plus dirty state, provider
route, mode, approvals, usage, trace paths and teardown. The setup/export helper
passing proves its plumbing, not the untested controller/provider combinations.

## Copse controlling Copse

Follow [controllers.md](controllers.md) for the guest route. Preflight the Apple
container service and branch-built image before asking the inner agent to start.
If the service is stopped, `container system start` needs the host's execution
approval. Missing images require the build/probe sequence documented in
`docs/plans/apple-container-desktop.md`; they are not pulled from Docker Hub.
Starting a service or building an image does not grant model access. The real
`isolated_copse` start still needs a supported host model and its fresh, bounded
approval. Keep that approval in the parent UI; the child cannot approve it.
