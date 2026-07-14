## Problem

Copse has a post-turn review subagent, a PR pane, and a Changes diff view, but reviewing someone else's (or the agent's) PR is still fragmented: no logical diff grouping, no inline findings (bugs, security, maintainability), and no chat grounded in the PR diff + wider codebase.

## Proposal

A **PR review mode** in the existing PR pane / Changes surface — not a separate app.

### Diff presentation

- Group related file changes together (subsystem / feature), not strict alphabetical.
- Detect moves/copies and render as renames where possible (reduce noisy full delete+add).
- Permalink to specific diff lines (shareable within Copse).

### Findings sidebar

- Structured findings cards: category (bug, security, style, question), confidence/severity, file:line, recommendation.
- Initial source: post-turn review subagent adapted to PR diff input; later optional dedicated review pass.
- Security findings: CWE-style classification, scoped to PR changes (not whole-repo scan).

### PR chat

- Ask questions about the PR; context = PR diff + semantic search across repo.
- Optional: "apply suggestion" → staged edit on PR branch (approval-gated), reusing staged-diff workflow.

### Workflow actions

- Reuse existing `gh_pr_*` tools: approve, request changes, mark ready, rerun CI, enable auto-merge.
- Surface CI status inline (already partially in PR pane).

## Out of scope

- Whole-repo security scanning fleet (separate future work).
- GitLab / Bitbucket (GitHub first via `gh`).

## Acceptance criteria

- Open linked PR → review mode shows grouped files + findings list.
- At least one e2e spec with screenshot on a seeded PR fixture.
- Chat on PR returns answers citing diff hunks or repo paths.
- Findings persist for the review session (not lost on pane switch).

## Related

- `src/renderer/views/review-panel.ts`
- `src/renderer/views/pr-pane-list.ts`
- Post-turn review subagent
- `src/main/tools/github-tools.ts`
