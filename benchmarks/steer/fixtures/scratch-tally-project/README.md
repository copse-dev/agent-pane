# scratch-tally-project

A small project whose TODO comments are spread unevenly across several files.

Fixture for the `tmpdir-scratch-eval` agent-eval scenario (issue #1846). The
tally is trivial to compute but tedious to hold in one command's head, so a
model reaches for an intermediate file — which is the behaviour the scenario
scores: the scratch file has to land in `$TMPDIR` or the workspace, never a
hardcoded `/tmp/...`.

`src/report.js` carries the most TODOs; twelve exist in total.
