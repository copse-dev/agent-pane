# Keep generated CI plans outside the checkout

## Task brief

CI's `tee plan.txt` creates an untracked file before the oracle scans the working
tree. This defeats the docs-only unit shortcut and contaminates later shadow
planning. Store the temporary plan under `RUNNER_TEMP`, update its output and
summary consumers, and preserve detection of genuine untracked source files.

Acceptance: execute the workflow's planning fragment against a temporary Git
repository; documentation-only changes select unit skip, no generated file enters
the checkout, and adding untracked source still selects the conservative full
unit plan. Existing force-full branches and main's gate policy stay unchanged.
