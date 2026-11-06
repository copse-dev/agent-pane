# Core CI workflow reads

## Task brief

A real-model read-only CI evaluation advertised `gh_run_list` and `gh_run_view` in the system
prompt, but the native registry removed both when the experimental CI-investigator plugin was off.
The model repeatedly tried the PR-only `get_ci_status` on main and fell back to large generic API
responses. Basic workflow inspection should not require enabling an automated investigator.
Base: `d57af855e16db5534ae1781317b9ea1e8cc16269`.

Acceptance:

- With gh available, basic workflow listing and log reads remain available with the investigator
  plugin off, on, and off again.
- Without gh, those CLI tools are withheld.
- The experimental `investigate_ci` entry point retains its plugin, gh, subagent and read-only gates.
- The plugin owns only its automated-investigation entry point; ordinary reads have one core owner.
- A real read-only model run can use the core reads with the investigator disabled.

## Ownership

Register `gh_run_list` and `gh_run_view` alongside the other core GitHub read tools in
`syncGhTools`. Plugin synchronization only adds/removes `investigate_ci`. Remove the two read
tools from the plugin manifest and contributions, preserving the plugin's storage and all its
existing investigator gates. No shell permission, authentication, continuation or write policy
changes.

This deliberately refines the P10 ownership decision in
[hooks and feature packs](hooks-and-feature-packs.md): the automated investigator remains a plugin,
while the read primitives used by ordinary coding and review are platform tools.

## Validation

The registry regression fails on the original code with the plugin disabled. Test plugin lifecycle,
gh availability, investigator gating and ACP exposure alongside the focused GitHub services, then
run the standard static/full gate. Real-model evidence also depends on the nested tool-schema fix:
without it, the local server rejects the entire native tool list before a model can use these reads.
Record exact final results and integration revisions in the PR.

The live run exposed two further evidence issues. An empty temporary Git repository cannot answer
the recent-merge question: the scenario now copies at most 50 commits of local `origin/main` via
file transport into an independent disposable repository, preserving its original remote. A fixture
test checks history, remote, source immutability and absence of alternates. GitHub also returns an
empty conclusion for active runs; workflow text now falls back to the queued/running status rather
than printing a blank outcome. The regression fails before that formatter correction.

The first integrated real-model run on the corrected history fixture passed deterministic tool
expectations (44.3 seconds, Qwen3.6 35B A3B via LM Studio, ordinary permissions, plugin disabled).
It correctly listed the recorded merges and used core workflow reads without shell or write calls,
but guessed at a failure cause without reading logs. Treat that as a partial qualitative result;
tool availability and a scorer pass do not establish reliable diagnosis.

A same-model repeat failed the workflow-tool expectation: it ignored the available workflow
reads and inferred merge ordering from PR numbers. Preserve that failure rather than relaxing
the scorer. Final local full check: 17,062 passed, ten failed, one skipped. The ten failures are
the same eight reproduced on unchanged main plus two CI-planning fixtures affected by an
uncommitted checkout; rerun the latter after committing. Final static/build gates and 68 focused
tests pass. The settings plugin Electron eval passes and all eleven captures were inspected.
