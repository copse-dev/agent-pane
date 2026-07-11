# CI runner trust boundary

Self-hosted runners must never execute untrusted code from external
contributors. Trusted push and same-repository PR jobs may use the configured
check or e2e fleets; a fork uses only the hosted, read-only `precheck` tier in
[`ci.yml`](../.github/workflows/ci.yml).

Two layers keep fork code off the self-hosted box — keep **both**:

1. **Fork guards (`if`)** — coverage, build, benchmarks, e2e, and every
   write-capable side effect are skipped unless the event is a push or a
   same-repository (non-fork) PR.
2. **Trust-based `runs-on`** — fork `precheck` and `CI Passed` resolve to
   `ubuntu-latest`; e2e's runner expression also fails closed for a fork. So
   even if a job-level fork guard is removed accidentally, untrusted code cannot
   reach the self-hosted fleet.

A same-repo (non-fork) PR is trusted because only collaborators can push
branches to this repo.

## Fork pull-request regression case

Fork pull requests deliberately run a small safe tier, rather than pretending
that skipped checks passed:

1. `precheck` runs the fork head on GitHub-hosted `ubuntu-latest` with only
   `contents: read`; its checkout leaves no token credentials in the worktree.
   It runs typecheck, lint, formatting, dead-code, and oracle validation.
2. Coverage, build, semantic benchmarks, e2e, autoformat, and screenshot writes
   remain same-repository-only and are skipped for the fork.
3. `CI Passed` succeeds for a fork only when that safe `precheck` job succeeded.
   If it was skipped, cancelled, or failed, the required aggregate check fails
   rather than making an untested contribution look green.

To verify the contract after workflow changes, open a test PR from a fork and
confirm `precheck` runs on `ubuntu-latest`, all privileged jobs remain skipped,
and `CI Passed` reports the safe-tier result. A deliberately failing lint or
typecheck in the fork must make `CI Passed` fail.

## Required repo / runner settings

The workflow guards are necessary but not sufficient on their own:

- **Settings → Actions → General → Fork pull request workflows:** require
  approval for **all external contributors** (not just first-time ones).
- **Runner:** keep the self-hosted runner in a runner group scoped to this repo
  only, ideally ephemeral and isolated. GitHub advises against self-hosted
  runners on public repos; these settings plus the guards above are what make
  it safe.
