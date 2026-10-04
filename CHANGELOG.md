# Changelog and release notes

The canonical changelog is the set of
[GitHub Releases](https://github.com/copse-dev/copse-releases/releases). Published
release notes are owned and maintained with the GitHub Release; this file holds
only the notes in flight — `Unreleased`, and the section for the version being
released — rather than copying every published entry.

## Unreleased

- Settings → About has an update channel. Beta gets new features first; switch
  to Stable and Copse keeps installing betas until the next stable release,
  then installs only stable releases. It never moves you back to an older
  version. Copse remembers the channel you installed from, so beta testers stay
  on beta after the first stable release unless they choose Stable.
- The footer's context ring no longer drops to about 0% when a run starts and
  then jumps back up after the first model call: its first reading now counts
  the system prompt and tools, as the readings that follow do. Its label also
  quotes the same figures as the hover beside it. The hover's Subagents line
  now says "N running" for runs still going and "no usage reported" or "N
  without usage" for runs that ended without reporting tokens, instead of
  "no usage yet" beside a run already marked done.

## 0.1.0-beta.13

- Copse reads another tool's sign-in to show plan usage only for providers you
  have set up in Settings → General: Claude Code or Codex once you have added
  and enabled its agent, Cursor once you have added its agent or saved a Cursor
  key, and Hugging Face once you have saved a Hugging Face key in Copse.
  Previously it looked for Claude Code, Codex, Cursor, and Hugging Face
  sign-ins whenever it checked plan usage, including when choosing the default
  model for a new thread. Plans that are not set up now say where to set them
  up in Settings → Usage, and nothing is read for them.
- Help → Report an Issue… opens Copse's bug report form on GitHub with your
  Copse version and Mac platform already filled in. Nothing about your
  projects, threads, or settings is included, and nothing is filed until you
  submit the form.
- The footer's context ring and token counter are now one control. The ring is
  the only thing left in the footer: the percentage and the `N tokens` text are
  gone, and one hover shows the context breakdown, token usage, cache and cost,
  and each subagent run with its status and tokens. The ring turns amber from
  80% of the context window and red from 95%; figures reported by ACP agents
  keep the same solid track. The footer now needs less width before it
  collapses into its compact layout.
- The macOS disk image is now signed and notarized by Apple, as well as the
  app inside it, so macOS can check the download itself before you open it.
- In the concise thread view, clicking the row for a running turn (for
  example "Running pnpm test…") shows that turn in full — narration,
  reasoning, and tool calls — until it finishes. Click it again to return to
  the concise view. The concise view also no longer leaves empty space between
  a prompt and its reply.
- Thread rows show a pull request's state at a glance: merged pull requests
  are purple with a merge icon, closed ones are red, and an open pull request
  whose checks are failing is marked red.
- The Activity panel keeps your place when new activity arrives, instead of
  jumping back to the top while you read older entries.
- The message box footer no longer flickers between its compact and full
  layouts at certain window widths.
- Codex models stay counted as covered by your plan when the shared weekly
  window is used up but your account still covers that model, or when its
  ChatPass allowance has room left.
- GLM-4.7-Flash now runs with Z.ai's published coding parameters by default
  (temperature 0.7, top-p 1.0, up to 16,384 output tokens). Any value you set
  yourself still wins.
- With LM Studio, Copse starts loading the selected model as soon as you send
  a thread's first message, so the model loads while the checkout is
  prepared.
- Branch CI automations no longer fail with "GitHub returned invalid CI data"
  when you preview or save one.
- Settings → Classifiers can detect a Kev or Winnow classifier server running
  on this machine and add it, or download and run one for you after asking.
  Liquid's d1 decision API is available as a preset, and a new Background
  questions setting chooses which classifier answers the judgements Copse makes
  on its own, such as roadmap labels and fit checks.
- Settings → Experimental lists experimental plugins as well as Customise, and
  adds Animated explainers (off by default): ask "explain X" in a chat and the
  agent builds a narrated animation grounded in your project.

## Release-note process

1. Add a user-facing entry under `Unreleased` in the PR that makes the change.
2. The version bump ([`scripts/release-bump.mts`](scripts/release-bump.mts), run
   weekly by `release-bump.yml`) renames `Unreleased` to `## <version>`, opens a
   new empty `Unreleased`, and drops the previous version's section, which its
   published GitHub Release already records. Do not rename these headings by
   hand.
3. The GitHub Release body is generated from the `## <version>` section with the
   supported OS, architectures, and update channel added
   ([`scripts/release-notes.mts`](scripts/release-notes.mts)). Before announcing
   the release, add known issues, data migrations, and recovery implications to
   it. Copse supports forward fixes only; do not recommend a downgrade. The
   in-app update prompt shows each skipped version's notes from below the
   body's `<!-- copse:changelog -->` marker, so keep that line when editing.
4. Link issues or pull requests that provide important detail without exposing
   confidential security-report information.

The complete shipping procedure is in
[docs/release-checklist.md](docs/release-checklist.md).
