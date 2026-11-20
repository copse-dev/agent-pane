# Small user journeys

Use the user's scenario when supplied. These examples are starting points, not a
required campaign or permission to spend on every controller/provider combination.

## Short isolated-guest smoke

For the fixed 100,000-token guest grant, start with two small file edits before
attempting the larger page journey below. Ask the child to create only
`index.html` containing only `<h1>Copse smoke one</h1>`, then finish. Inspect its actual diff
through the guest Changes panel and capture a screenshot. Follow up asking it to
rewrite that file with heading `Copse smoke two`; inspect and capture the changed
file again. This proves a real child turn and follow-up, not browser interactions.

Record optional plugin configuration. Automatic post-turn review can consume the
small grant independently of the requested edits. If the authorized fixture has
that optional reviewer disabled, set it through the guest's normal Plugins UI and
report that scope; it is not a default-configuration pass. Preserve any failure
observed with review enabled. Do not change permission policy or the grant limit.

Budget the outer controller too: repeated screenshot polls consume its model
context even while the guest is idle. Use the controller's supported wait (a
scoped read-only `sleep` command is sufficient when authorized), wait several
seconds between idle polls, and cap a smoke at 20 screenshots. Record the displayed
error before retrying an interrupted turn; one bounded retry is enough when the
same error persists.

## Build, follow up, verify

Use an empty disposable project and a dependency-free sample that can run offline.
For example, send through the Copse composer:

> Build a small reading-list page using only index.html, styles.css and app.js.
> Include a labelled book-title input, Add button, and list. Adding a nonempty title
> should create a row and clear the input; ignore whitespace-only titles. Keep all
> resources local and use no package installs or external services. Explain how to
> open it locally. Do not commit or publish anything.

After the first turn completes, inspect the files and open the result through the
available local preview/browser surface. Add `Alder`, then `Birch`; try whitespace
input. Verify two rows, the cleared input, and no blank row. Then send:

> Add a Remove button to each book row. Removing one book should preserve the other
> books. Keep the existing Add behavior and styling.

Verify removing `Alder` preserves `Birch`, and adding `Cedar` still works. Save the
before/after evidence and trace. If no preview surface exists in the chosen guest,
record that limitation and use an offline file/test task the guest can actually
execute; do not claim the page interactions passed from a screenshot of source.

## Existing project and permissions

Seed a small broken project with known staged, unstaged, and untracked changes and
record their starting contents. Ask Copse to fix the specific bug while preserving
that work. Inspect the actual diff and run the relevant test afterward.

When permission behavior is the target, choose one concrete sequence such as reject
an edit, follow up with an allowed edit, then verify only the latter happened. For
remembered grants, explicitly exercise the intended scope and revocation. Capture
the displayed scope and resulting effect. A driver that accepts every prompt
cannot prove these journeys. Do not request broader permissions merely to avoid
measuring a prompt.

## Cancellation, recovery, and bounded automations

Choose one interruption and an observable recovery: cancel a running task and
change direction, reopen the isolated profile and continue, or recover after a
controlled provider error. Record which work stopped and which persisted. Use
existing test boundaries for failure injection, not new test-only product flags.

For scheduled runs, use the real schedule UI, verify one requested trigger and its
result, then pause/remove the schedule created by the test. A manually submitted
prompt does not establish that the scheduler works. Inspect approval stalls and
overlapping/held runs when requested; increasing time limits or granting everything
does not establish recovery. Do not attempt an overnight campaign within an
`isolated_copse` grant or renew grants automatically to bypass its lifetime.

## Evidence record

Keep a compact record alongside local artifacts:

- Scenario, tested source SHA, OS, outer controller, inner provider/model, real or
  mock mode, permission configuration, and time/spend boundary.
- Each acceptance criterion and its pass/fail/blocked result; exact verification
  commands, relevant files, screenshots, and raw thread-export paths.
- Unexpected prompts, failure/recovery sequence, fixture changes versus work done
  by Copse, and any requested fixes with their independently verified results.
- Resources created, teardown outcome, and unverified controller/provider pairs.

Keep traces local unless publication was requested and their contents reviewed.
Missing authentication is an environment blocker, not a model-quality failure.
