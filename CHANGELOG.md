# Changelog and release notes

The canonical changelog is the set of
[GitHub Releases](https://github.com/copse-dev/agent-pane/releases). Published
release notes are owned and maintained with the GitHub Release; this file records
the release-note process and the current unreleased summary rather than copying
every published entry.

## Unreleased

- A shell in a popped-out Terminal now shows its output. Typing worked and the
  command really ran, but every byte it produced was delivered to the main
  window, which had no tab for that session and dropped it — so the pop-out sat
  there looking dead. Terminal sessions were always tracked per window; only the
  destination for their output was not, and it went to whichever window the app
  started with. A shell's output now goes to the window that opened it, and to
  no other: unlike the diff queue, which is shared workspace state, terminal
  output stays private to its own window. Closing a pop-out also shuts down the
  shells it opened, rather than leaving them running with nothing attached. The
  unsandboxed-terminal permission prompt follows the same window, so it no
  longer appears on the (possibly hidden) main window while the pop-out waits.
- Changes popped out into its own window now shows the same thing the docked
  pane does. The **Proposed** section was missing entirely from the pop-out: the
  main process pushed the proposed-diff queue to the main window only, and a
  pop-out deliberately does not run the agent loop, so nothing in the detached
  window was listening either. Two windows side by side disagreed about what the
  agent had proposed, and the one you popped out to review in was the one that
  could not show it — or accept it, since Accept and Reject only appear
  alongside a proposed diff. Diff-queue and file-change events now reach every
  window, panes read the current queue on mount rather than waiting to catch a
  push, and a pop-out opens on the file you were looking at instead of falling
  through to an unrelated git change. Approving or rejecting also refreshes the
  git sections in both windows, so the two stay in step.
- The diff viewer no longer rebuilds itself when nothing about the file changed.
  Every file-watcher tick and panel toggle re-entered it and threw away both
  editor models to recreate them from byte-identical content, which flashed the
  collapsed-region markers and scrolled you back to the first hunk in the middle
  of reading a long diff. Selecting a genuinely different file still remounts —
  including the case where two files happen to read identically, which would
  otherwise have left the previous file's syntax highlighting on screen.
- Everything Copse stores now lives in one directory. Threads, worktrees and
  knowledge were already under `~/.copse/`, but projects, settings, API keys,
  MCP config, custom tools, the browser profiles and the search index sat in
  Electron's own directory — `~/Library/Application Support/copse-panel/` on
  macOS — so backing Copse up meant copying two unrelated folders and restoring
  them as a matched pair, and moving to a new machine meant the same. They now
  live at `~/.copse/user-data/`, and the first launch after updating moves an
  existing profile across. A migration that cannot complete logs why and keeps
  using the old directory, so a failure costs a retry rather than your projects
  list. `COPSE_DIR` consequently relocates the whole profile for real: it used
  to move the thread store's per-project directories while the chat store root,
  knowledge, long tasks, roadmap review, pack snapshots and user hooks stayed
  behind in `~/.copse`, which left thread reads authorised against a root
  nothing was being written to. Back up `~/.copse/` and you have all of it —
  see [`docs/recovery.md`](docs/recovery.md), which is now one directory rather
  than a checklist.
- Knowledge notes, long tasks and roadmap-review state now follow a project that
  moves. They were filed under a hash of the project's absolute path while
  threads were filed under its id, so relocating a project — moving the repo,
  recovering a folder Copse had quarantined, or restoring a backup onto a
  machine where your home directory has a different name — brought the threads
  back and left the notes behind. Nothing was ever deleted; the app was looking
  in a directory named after where the project used to be. All three now key by
  project id like threads do, and an existing directory is carried across the
  first time it is opened.
- A provider whose stored API key cannot be decrypted no longer presents itself
  as configured. Keys are sealed with the OS keychain of the user that saved
  them, not with the Copse profile, so a profile restored on a second machine
  carries ciphertext nothing there can open. Copse treated "a key is stored" as
  "a key works": the provider looked ready and only the request failed. Such a
  key now reads as unconfigured, so the normal prompt to add one appears. A
  keyring that is merely locked — common on Linux at login — is not mistaken for
  a broken key.
- `/checkup` now reports an API key it cannot decrypt. Keys are sealed with the
  OS keychain of the user that saved them, not with the Copse profile, so a
  profile restored on a second machine carries ciphertext nothing there can
  open. Copse used to treat "a key is stored" as "a key works": the provider
  showed as configured, `/checkup` called it encrypted and healthy, and only the
  request failed. Each unreadable key is now an error naming the provider and
  pointing at re-entering it or supplying the environment variable instead. New
  [`docs/profiles.md`](docs/profiles.md) covers running more than one profile,
  what a profile does and does not isolate — keys are separated by file, not by
  encryption key — and what to expect from the one-time move of the old Electron
  directory.
- A thread working in its own isolated worktree no longer asks you to approve
  every delete, rename, and new folder. Writes have applied straight to disk
  since the session backup landed, but the three non-content ops still staged
  unconditionally — so an isolated thread was queueing up approvals for files
  only the agent had ever written, in a checkout you do not share, on a branch
  that is not yours. They now take the same path writes do, and the same
  fallbacks: an op still stages if git cannot be read, if uncommitted work could
  not be backed up first, or if the file changed underneath the agent since it
  read it. Threads on the shared checkout are unchanged — those are your files.
  **Settings → Permissions → File edits** carries the toggle
  (_Skip approval for deletes, renames, and new folders in an isolated
  worktree_), on by default.
- The side panel can now take the whole chat column. Every pane header —
  Explorer, Shells, Changes, PRs, Memories, Roadmap, Browser — carries an
  **expand** control next to its pop-out button, and pressing it gives that pane
  everything from the thread list to the right edge of the window; the same
  control, now pointing inward, restores the split. It is the in-window half of
  pop out: a wide diff, a real browser viewport or a full-width terminal without
  detaching a second window to get one. The projects rail stays where it is, so
  threads remain visible and switchable with the pane expanded, and the titlebar
  stays reachable, so switching panes swaps the content and stays expanded.
  Expanding covers chat rather than collapsing it, so the transcript keeps its
  scroll position and the composer its draft, and restoring puts both back
  exactly as they were — the agent carries on underneath either way. Closing the
  panel gives chat its column back.
- The file tree and file previews work in a `npm run dev` build again. `dev.mts`
  never emitted `dist/main/sandbox-fs-worker.js` (nor the pack-tool, ACP-probe
  and SSH-askpass bundles) — only `npm run build` did. A `dist/` filled purely by
  `npm run dev`, as in a fresh worktree, therefore failed every sandboxed `fs:*`
  call with a `MODULE_NOT_FOUND` from a child process, spawning two doomed
  Electron processes per call. Both builders now emit the same list, and a
  missing worker bundle reports itself by name instead of spawning anything.
- Opening a new thread with the Terminal pane already visible no longer fails
  to spawn a shell. Autosave already flushed `threads:create` immediately on a
  new id, but `terminal:create` did not wait for that write — main's ownership
  check then treated the missing `meta.json` as "thread does not belong to
  project". The terminal spawn now awaits the in-flight create first, and a
  missing meta is reported as "not persisted yet" rather than a membership
  mismatch.
- A thread that went wrong can now be handed to a thread that can read it.
  **Debug trace**, in the composer's overflow menu, exports the conversation
  you are looking at as a zip of its whole store directory — the spine, the
  message prose, tool arguments and results, plans, nested subagent runs — opens
  a new thread with that archive attached, and drafts a prompt asking for the
  diagnosis: a timeline of what the thread was asked to do and what it actually
  did, the point it went wrong quoted from the trace, the failure mode behind it,
  and what would have prevented it. It says up front when history was trimmed
  mid-run, which is a common cause and one the transcript alone cannot show. The
  archive is stored with the new thread, so the investigation outlives the thread
  it is about, and the agent unpacks it into files with `read_archive` rather
  than ever taking the bytes into context. Nothing is sent: the draft ends on an
  open line for you to say what you actually saw, which is the one thing a trace
  cannot contain. Debug trace and **Share trace** are also no longer behind
  Developer mode — someone whose thread has just gone wrong is by definition not
  the person who went looking for a developer setting first.
- New threads are now isolated by default, and no longer pick up where the last
  thread left off. A new thread in a Git project gets its own linked checkout,
  branched from the project's default branch — `origin/main` as last fetched,
  not whatever happens to be checked out. Both halves of that are the fix. The
  automatic choice deferred to a per-project setting that defaulted to off and
  that nothing in the app could turn on, so in practice every thread shared the
  project checkout; and because Copse leaves that checkout on the branch a
  thread created, the next thread opened straight into the previous one's
  working tree, on its branch, and built on top of it. Isolated threads were
  affected too, more quietly: a worktree was cut from the live checkout, so even
  an explicitly isolated thread started from the previous thread's commits.
  Uncommitted work in the project checkout still comes along when it belongs to
  the same commit the thread is starting from; when it does not — the checkout
  is on another branch, or the default branch has moved on since — the thread
  starts clean rather than mixing two unrelated states, and your own checkout is
  left exactly as it was either way. Threads that cannot be isolated are
  unchanged: a project that is not a Git repository, is reached over SSH, uses
  submodules, or has no resolvable default branch shares the project checkout
  and says so before you send. So does a project set to `worktreeMode: never`,
  and either way the choice is still yours per thread, from the composer.
- The Changes panel no longer goes blank when a diff is replaced. Opening a file
  tore the current diff down before the next one had been computed, so for the
  length of that compute the editor held nothing at all — and any attach that was
  abandoned partway (a store update re-selecting the same file, a fresh proposal
  arriving, a thread or project switch) returned without putting anything back,
  leaving the panel showing an empty editor rather than a diff or its “Select a
  changed file” message. The outgoing diff is now released only once its
  replacement is on screen, so an abandoned attach leaves the diff you were
  looking at in place. Clearing the viewer also releases the view-model wrapper
  around the models, which nothing had been disposing.
- The worktrees Copse creates are now something you can see and clear out.
  Every isolated thread gets its own linked checkout of the project, and until
  now nothing in the app admitted they existed: they accumulated under
  `~/.copse/worktrees`, one full working copy each, and the only way to find out
  how much disk that had become was to go looking with `git worktree list` and
  `du`. **Settings → Sources → Worktrees** lists them, most recently used first,
  and each row says what the checkout is for and what it costs — the thread it
  was created for, when it was last used, when it was created, and its measured
  size on disk, with the path on hover. Rows that are safe to reclaim say so
  rather than leaving you to work it out: a checkout whose thread is gone reads
  “orphaned”, one whose thread has moved on reads “released”, and one Copse did
  not create reads “external”, alongside badges for uncommitted work, unmerged
  commits, a detached HEAD, or a lock. Each row deletes, including the dirty and
  unmerged cases the automatic cleanup has to refuse — which are exactly the ones
  that pile up. Deleting always asks first; if Git reports content that would go
  with the directory, it asks a second time and lists the files, checked at the
  moment you delete rather than when the list was drawn, so a checkout the agent
  has dirtied since still stops you. A checkout with a turn running in it cannot
  be deleted at all. Deleting one does not brick its thread: the thread drops the
  worktree and carries on in the project checkout. The branch goes only if it is
  fully merged — anything unmerged outlives the checkout that held it.
- Switching projects no longer carries a prompt across, or leaves the app half
  moved. Two problems, both about a switch and the thing it left behind.
  Approval prompts and `ask_user` questions were checked against the focused
  thread when they were raised, but the open dialog was never re-checked — so a
  prompt from the project you just left stayed on screen over the thread you
  landed on, reading as a question that thread never asked, and answering it
  approved a tool call in the project behind you. A prompt whose thread loses
  focus is now withdrawn and re-flagged as a sidebar bell, and comes back, in
  order, when you return to it. Separately, switching away and immediately back
  used to let the abandoned switch finish behind you: it pointed the main
  process at the other project's root, saved it as the project to reopen at next
  launch, and stripped the transcripts off the sidebar rows of the project still
  on screen — leaving the file tree, git, terminals and the next run's working
  directory all serving a project the window was not showing. Clicking the
  project (or a thread in it) you are already on now cancels the switch in
  flight and puts the workspace and the saved selection back. Workspace
  activations are also applied in the order they were requested, so two quick
  switches can no longer land out of order, and a switch that is cancelled or
  superseded always releases whatever was waiting on it — File ▸ Open Folder,
  new project, relocate and orphan recovery all awaited that, and on launch the
  app layout itself was chained off it.
- The model picker names Claude models one way, whoever supplied them. Every
  provider spells them differently — Cursor's catalog returns a bare “Opus 5”
  and puts the version first in “Claude 4.6 Sonnet (Thinking)”, device agents
  label them by family alone, and some rows only had the raw id
  (`claude-opus-4-7`) — so a list whose own rows read “Claude Opus 4.8” looked
  like it held four vendors' models, and under a heading that names an agent
  rather than a vendor (“Cursor Cloud Agent”) a bare “Opus 5” did not say whose
  Opus it was. Those rows now read “Claude Opus 5”, “Claude Sonnet 4.6
  (Thinking)”, “Claude Opus 4.7”, with qualifiers kept intact. The rewrite is
  display-only and only reorders what a name already says: models it does not
  recognise — Composer 2, GPT-5.6 Sol, local weights — are left exactly as their
  provider named them. An agent's own spelling still resolves its intellect
  hint, and a spelling no alias covers now finds the measurement through the
  model it names, so more agent rows carry the score their cloud twin shows.
- Hook cards are debuggable. A card that said “Added context · Injected 307 chars
  of context” could tell you a hook had done something but never what — the
  character counts were the whole story. Every card now carries an **Inspect run**
  disclosure that shows the run itself: what the hook was handed and what it
  returned, read on demand from the thread's own records. Command hooks show the
  exact stdin they read alongside their stdout and stderr; in-process hooks, which
  had no visible output at all, now show their dispatch payload and the full text
  of everything they applied — the injected context, the message to the agent, a
  rewritten tool input, a halt reason — with real line breaks, not escaped JSON.
  Each block copies in one click. Nothing is fetched until you open a card, and
  captures are bounded so a chatty hook cannot bloat a thread.
- A long session holds on to much less memory. Two things kept transcript text
  alive that did not need to be. The transcript's render caches — the ones that
  let an unchanged tool card skip a rebuild — stored the card's whole JSON
  encoding as its signature, so every tool result, and every base64 image
  attachment inside one, was held a second time for as long as its card was on
  screen; a heap snapshot of a long session showed 83% of a 319 MB renderer heap
  in strings, with the same 500 kB screenshots and 200 kB command outputs
  appearing two and three times over. Signatures are now a short digest of that
  JSON rather than the JSON itself. Separately, archived threads were still
  folded into memory in full on every project load, message bodies and images
  included, even though the sidebar and the `@`-picker both hide them; the load
  now skips them. They stay on disk untouched, and all-time usage totals still
  count them. Third, the sidebar kept a thread list per project visited this
  session, and those lists were whole threads — so switching between projects
  added transcripts to memory rather than replacing them. A project you switch
  away from now keeps only what its rows draw: title, running mark, and the PR
  refs already scraped out of its messages. Switching back reloads from disk as
  before.
- Models chosen through an API can now be tuned, the way a device agent's model
  and permission mode already were. Settings → Models grows a **Model
  parameters** block under the chat-model picker with reasoning depth,
  temperature, and top-p. The values belong to the model rather than to the
  field, so they follow it wherever it runs — chat, task roles, subagents — and
  each model keeps its own set. Which controls appear is decided by the model:
  the newest Claude models reject temperature and top-p outright and get the
  reasoning ladder alone, older Claude models have no reasoning ladder and get a
  thinking budget instead, and OpenAI-compatible providers get all three with a
  note that the upstream model has the final say. A value saved against one
  model is re-checked against whatever it is read for, so a stale setting
  degrades to the provider default instead of failing the turn. Untouched models
  send exactly the request body they sent before.

  Two shortcuts sit on top of it. Where a vendor publishes a recipe for a model
  — DeepSeek V4 Flash asks for max reasoning effort with `temperature 1.0` and
  `top_p 0.95` in agentic use — a **Use recommended** button fills the fields
  from it and links the source. It is offered rather than applied: the recipes
  are scenario-specific and only as current as the version they were read
  against, so nothing is sent until you accept it. And a **reasoning dial** now
  sits beside the model picker in the composer, scoped to one chat, for when a
  single task wants more thinking than the model is normally set to — no
  permanent re-tuning to get through one turn.

  What a turn actually ran with is now recorded on the assistant message, next
  to the model that produced it. The saved values are mutable and the resolved
  ones can differ from them — a stale value is dropped, the dial overrides the
  level, a cheap role caps it — so without this a transcript would re-read as
  though every past turn ran at whatever Settings holds today. The transcript
  labels a turn where the model _or_ its parameters changed, so dialling effort
  up mid-chat marks the turn it took effect on, and the values travel with the
  thread through export.

  The two roles whose job is to be cheap — thread titles and follow-up
  suggestions, and the shell-command classifier — cap the reasoning depth they
  inherit. A model set to max effort for the work should not spend max effort
  naming the conversation, and that bill would arrive with nothing on screen to
  explain it.

- The Parallel Search pack's switch no longer turns on without a key. The tool
  was already credential-gated where it counts — `parallel_search` is registered
  only when the pack is enabled _and_ a Parallel API key resolves — but Settings
  let you flip the toggle with no key saved, leaving a pack that read as on and
  contributed nothing. The toggle now stays inert until a key is stored, with a
  hint saying so. Turning it off is never blocked, so clearing the key on an
  enabled pack shows the hint (and unregisters the tool) rather than trapping the
  switch on.
- Context-window trouble is now reported where the model is chosen. Picking a
  model for a thread that no longer fits it puts a message above the composer —
  "This thread no longer fits “GPT-4o mini”: the next prompt needs about 158K
  tokens and its context window holds 128K" — with the two ways out: pick a model
  with a larger window, or free up context (local models also get the "raise its
  Context Length in LM Studio" route). It appears at 90% of the window too, while
  there is still room to act, and carries a **Choose another model** button that
  opens the picker beside it. This replaces the startup banner that warned about
  low-context local models before any thread or model was in play; the same
  underlying check still feeds the `/checkup` report.
- Closing Copse while a thread is still working now asks first. Quitting tears
  down every live agent session with no way to resume, so a close that would land
  mid-turn opens a confirmation naming the threads still running ("Fix login is
  mid-turn…") with **Close anyway** / **Keep working**. Backing out leaves the
  run untouched. This covers both routes out of the app — the window's close
  button and Cmd+Q / the Quit menu item — and the prompt lands before any
  teardown starts, not after. Closing with nothing running is unchanged: no
  dialog, no extra click.
- The model value map keeps working past Artificial Analysis' API retirement.
  AA retires its legacy `/api/v2/data/*` endpoints on 4 November 2026, after
  which they answer `410 Gone`. The live panel already read the supported free
  language feed, but it fell back to the legacy scores endpoint when a response
  failed validation; since AA's documented replacement for that legacy endpoint
  is the very feed we call first, the fallback had no successor and is gone —
  one endpoint, one attempt. The `sync:intellect --from-api` refresh moves onto
  the same feed, which means it now walks every page rather than reading only
  the first, so a keyed refresh sees the whole model list instead of the first
  200 rows. API keys are unchanged.
- Icon-only controls now name themselves on hover. The titlebar panel toggles,
  pane header actions, composer buttons, browser navigation, and the PR
  lifecycle and CI glyphs all get a small label after a short hover — the plain
  kind you'd expect on the web, not a panel. It arrives faster than the OS
  tooltip it replaces, follows the app theme, flips above the anchor when there
  is no room below, and stays inside the window near an edge. Keyboard focus
  shows the same label; the click that follows a hover dismisses it. Where the
  glyph encodes state the label decodes it: "Open changes — 3 pending diffs",
  "CI failing", "Auto-merge is on — merges itself once checks pass".
- The context wheel no longer goes blank on hover while the agent is working.
  Mid-run the pre-send estimate is deliberately suppressed — it describes the
  _next_ prompt, not the one in flight — but that left the wheel with nothing to
  show for the whole run, and the part-by-part breakdown only came back once the
  turn ended. It now falls back to the aggregate it is already drawing
  ("Context · 54.0k / 180.0k (30%)"), which needs no estimate to produce. Chat
  windows that never report a breakdown at all — subagents and remote agents —
  gain the same hover summary.
- The footer token counter explains itself on hover instead of on click. Pointing
  at it opens a tooltip in the same style as the context wheel beside it: input
  and output tokens, the prompt-cache read/write split when the provider reports
  one, and the estimated cost — broken down per model once a thread has used more
  than one, plus a line for how much of the total was delegated to subagents.
  Estimated counts are labelled as such rather than priced. The click that used
  to swap the label for an inline `1200 in / 80 out · ~$0.02` string is gone; the
  counter now always reads as the plain total.
- Answers on Claude Opus 5 are shorter. That model's default replies run longer
  than other models', and the effort setting tunes how much it thinks rather
  than how much it says, so the system prompt now asks for concision explicitly
  when a turn runs on Opus 5 — with a short reminder near the end of the prompt,
  as Anthropic's
  [Opus 5 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5#response-length-and-verbosity)
  recommends. It is the only model-conditional text in the prompt; every other
  model sees exactly what it saw before. The steering sits ahead of your custom
  and project instructions, so asking for fuller explanations there still wins.
- Copse now identifies itself to model providers. Every provider request carries
  the de facto attribution pair `HTTP-Referer: https://copse.dev/` and
  `X-Title: Copse`, with OpenRouter also receiving `X-OpenRouter-Title` (the
  renamed form of the same header, sent with the same value so it does not
  matter which name that router prefers). OpenRouter uses this to attribute
  traffic to an app page and its public rankings; Vercel AI Gateway and Requesty
  use it for dashboard attribution; providers that do not recognise the headers
  ignore them. The headers are fixed constants that name the application only —
  no key, account, machine, thread, or prompt-derived value is included. See
  [docs/privacy-data-flow.md](docs/privacy-data-flow.md).
- The homepage no longer leads with a screenshot. It embeds the browser demo and
  replays a real recorded session in it: the prompt is typed into the composer,
  and the answer streams back with its tool cards and token count, in the actual
  interface. The screenshot stays as the fallback for narrow screens, a
  reduced-motion preference, or a demo that does not load.
- Zip archives can be attached to a chat and read. Drop a `.zip` on the composer
  and the agent unpacks it with the new **`read_archive`** tool into the
  conversation's own directory, then reads what is inside with its ordinary file
  tools — so a bundle of logs, a downloaded release, or an exported thread can be
  explored file by file rather than described. Previously a dropped zip was read
  as text and landed in the prompt as binary noise. The extractor refuses path
  traversal, symlinks and zip bombs, and the extraction is deleted with the
  thread. External ACP agents get the same tool through the native-tool bridge,
  so they unpack archives with those guards rather than falling back to a raw
  `unzip`. See [docs/read-archive.md](docs/read-archive.md).
- ACP agents can now read attached videos too: `video_frames` joins the
  native-tool bridge, and bridged tool results carry images as MCP image content
  so the frames themselves arrive rather than a manifest describing them.
- Fixed: composer attachments (files, images, videos, archives) carried across a
  thread switch, so a zip or recording attached in one conversation could be
  recorded against another — pointing at a file in the first thread's directory,
  which vanished if that thread was deleted. Attachments now clear on a switch,
  matching drafts.
- ACP diagnosability: a native-tool bridge that fails to start is logged instead
  of silently swallowed, the tools it offers are logged when it does start, and
  an agent that does not advertise MCP-over-http is named as the reason the
  bridge was withheld. Previously all three were indistinguishable from "the
  agent chose not to use the tool".
- Settings has been restructured. **General** is now three things and nothing
  else: **Detect settings**, **Providers**, and **Models**. Everything that used
  to be piled in alongside them moved to where it belongs: instructions, helpers
  and skills to a new **Agent** section; auto-run, file edits, web access and
  terminals to a new **Permissions** section; remote work over SSH to **SSH**;
  and the built-in browser setting to **Appearance**.
- **Providers** is now one list covering every way Copse reaches a model, so you
  pick the company rather than the connection method. The separate **Local
  models** and **ACP agents** sections are gone, folded into it. Choosing Cursor,
  for example, offers both its cloud agent and the Cursor agent installed on this
  machine, in one place. Nothing opens by default: the page shows the list until
  you pick a provider, and no device scan or setup runs until you do.
- Usage bars now share one colour instead of shading by severity, and the
  value-map key has been rewritten as a real key with swatches ("Best value at
  its level", "Included in your plan") rather than a paragraph of chart jargon.
  The "Hide plan" toggle is gone; the Plan / Inference / Expected control already
  answers the same question without deleting the models you pay for.
- Settings copy has been rewritten in user terms throughout, dropping references
  to how Copse is built internally, and the product no longer says "ACP" when it
  means an agent running on your machine.
- An external agent whose sign-in has expired can now be signed back in from the
  app. A lapsed credential used to surface as a raw
  `ACP error -32603 (Internal error)` with no route back to a working session:
  Claude's adapter reports an expired OAuth token as a generic internal error, so
  the message never reached the guidance meant for auth failures. Copse now reads
  the real cause out of that error, says which agent's sign-in expired, names the
  command that renews it (`claude /login` — not the first-run `claude setup-token`),
  and offers to open a shell in the **Shells** pane already running it. You finish
  the sign-in there and re-send your message.
- Fixed the cause of those expiries under the agent sandbox: the Claude presets
  did not allow `claude.com`, so an OAuth login could not reach
  `platform.claude.com` to refresh its access token. Nothing failed at the time —
  the agent kept working on the token it held and then died once it aged out. The
  presets now allow it.
- Everyday shell commands stop asking for approval. A new deterministic
  classifier recognises a fixed allow-list of low-risk command _shapes_ and runs
  them without a prompt: local reads, and `git fetch` / `gh pr view` against a
  remote already configured in the repository. Settings → Permissions → Shell commands →
  **Also run recognised low-risk commands without asking** raises that to local commits
  (`git add`/`commit`/`checkout -b`/`stash`) and then to pushes
  (`git push`, `gh pr create`). Nothing else changes: project scripts
  (`npm test`), `npx`, installs, force pushes, ref deletions, `gh api`,
  `gh pr merge`, anything with `$(…)` or a redirection, and every command the
  list does not recognise still prompt exactly as before. No model decides — the
  classifier is pure pattern matching, it only ever converts a prompt into an
  allow (never softens a block), and it is honoured only in a trusted workspace.
  Each auto-approval is written to the decision log. Note that at the two write
  levels `git commit`/`checkout`/`push` run your repo's git hooks, which the
  macOS sandbox contains and Linux/Windows do not.
- A thread can be exported as its whole folder, not just its transcript. The
  footer overflow menu (Developer mode) keeps **Export conversation (JSONL)** —
  the portable single-file transcript — and adds **Export thread folder (ZIP)**,
  a faithful copy of the thread's directory in the chat store: the event spine,
  message prose, tool-result and image blobs, plans, the provider-history
  sidecar, and any nested subagent sessions.
- Threads can be forked. Right-click a thread in the sidebar and choose **Fork**
  to branch the whole conversation, or hover any prompt in the transcript and
  choose **Fork from here** to branch it as it stood at that point. The fork is a
  new thread — the original is untouched — and it inherits the model context, so
  the agent remembers the conversation the transcript shows. Forking the whole
  thread copies the recorded provider history verbatim; forking from an earlier
  prompt reconstructs it from the transcript, which cannot carry the expanded
  contents of `@`-file / `@`-thread / paste attachments (the app says so when it
  applies).
- The last prompt in a thread can be resent. Hover it and choose **Resend** to
  submit it again as a new turn — useful after a failed run or to get a second
  attempt at the same question. History is appended to, never rewritten, and a
  resend while the agent is running queues behind the current turn. Attachment
  contents are not part of a resend (only the prompt's own words and images).
- Fixed: a project showing fewer threads than one sidebar page pinned its list to
  that size, so the next thread it gained (a new chat or a fork) appeared behind
  "Show more" instead of in the sidebar.
- Fixed SSH password, passphrase, and host-key prompts never appearing. The
  bundled askpass helper was emitted with a duplicate `#!/usr/bin/env node` on
  line 2 — a syntax error — so it crashed on every launch. OpenSSH treats an
  askpass that exits non-zero as "no answer" and moves on, so connecting to a
  password-auth host silently burned through the server's auth attempts and
  failed with `Too many authentication failures` instead of asking for a
  password. The build now syntax-checks that bundle before shipping it.
- ACP agents graduated out of **Settings → Experimental** into their own
  top-level **Settings → ACP agents** section. The panel now follows the
  Providers pattern: a chip row lists each agent (known presets first, then your
  custom ones, then **Add agent**) and reveals only the selected agent's install
  guidance / editor, so agents are hidden away until picked rather than all
  expanded at once. A dot marks the agents you've added.
- Packs: new opt-in `copse.forced-planning` first-party pack. When the model
  running a turn measures below a capability threshold, it requires an explicit
  plan before any other tool call — `update_todos` when that tool is offered, a
  written numbered plan when it is not — so smaller and heavily-quantized models
  can carry longer tasks. Thresholds are configured per scale in Settings →
  Packs (the Artificial Analysis Intelligence Index and the Copse composite are
  not comparable, so each has its own), with a third setting for what to do with
  unmeasured models. See docs/forced-planning.md.
- CI: bounded the retention of every workflow artifact that previously inherited
  the 90-day default (per-shard PR screenshots, coverage report, and the three
  bench result sets), so routine PR runs stop accumulating against the org's
  Actions artifact-storage quota. Screenshots expire in 3 days (only ever
  consumed by `commit-screenshots` within the same run); coverage in 7; bench
  trend data in 14.
- Added general-availability security, support, privacy/data-flow, release, and
  recovery documentation.
- Privacy: OpenRouter requests now route only to zero-data-retention,
  non-training endpoints by default (`provider.zdr` +
  `data_collection: "deny"`, two independent toggles in Settings → Providers
  → OpenRouter — turning ZDR off keeps training excluded unless separately
  allowed); the model picker lists only ZDR-capable OpenRouter models while
  ZDR routing is on, and a model with no compliant endpoint fails fast with
  an actionable message instead of being retried. Direct OpenAI requests
  send `store: false`. Settings → Providers badges each provider's default
  retention/training policy and the model picker flags providers that may
  train on inputs. Privacy-forward hosted endpoints (Groq, Together AI, and
  Fireworks AI) are available directly as provider presets instead of being
  hidden under Other. See docs/provider-data-policies.md.
- Every text attachment chip now opens its snapshot in the preview modal. A
  pasted block, an attached file and an attached terminal selection are all
  openable in the composer, so what you attached can be checked before you send
  it rather than only afterwards from the transcript — the ✕ still removes the
  chip, since the affordance sits on the label beside it. Sent pasted blocks
  open too: their chip was being rebuilt from its label alone, dropping the
  snapshot the message already carried, so the most common text attachment was
  the one kind that stayed stubbornly shut.
- An external agent that runs out of file descriptors is now replaced instead
  of being handed more turns. Copse keeps one agent process per thread alive
  across turns, so an adapter that leaks handles eventually hits its
  open-file limit — Claude Code's `EMFILE: too many open files` settings-watcher
  errors are the usual first sign. The process does not exit when this happens:
  it keeps answering while quietly failing to open anything else, so settings
  reloads, file reads and MCP servers stop working with nothing to show for it
  but a line in the log. Such a process is now torn down at the next turn
  boundary and replaced, resuming the same agent session where the agent
  supports it, so the descriptors come back without the thread losing the
  agent's memory of it. The same applies to an agent running over SSH, whose
  remote login often has the tighter limit of the two. A known-exhausted process
  is never simply handed the next prompt — the first fault always buys a fresh
  one. Only when that replacement runs out just as fast does Copse stop
  respawning: nothing it can spawn will clear a limit that low, and the
  alternative to reusing the process is refusing to run at all. That case is an
  error in `/checkup`, naming the limit the agent was launched under (macOS
  gives an app 256 by default) and how to raise it, so it can be found by
  someone who never sees the console.

## Release-note process

For every release:

1. Draft the GitHub Release from the matching `v<version>` tag.
2. Turn merged changes into user-facing notes, grouped into features, fixes,
   security/privacy changes, and developer changes as applicable.
3. State the supported OS and architectures, known issues, data migrations, and
   recovery implications. Copse supports forward fixes only; do not recommend a
   downgrade.
4. Link issues or pull requests that provide important detail without exposing
   confidential security-report information.
5. Review the notes with the artifacts, then publish them as part of the GitHub
   Release.
6. Reset the `Unreleased` section here after publication. Do not mirror the
   published notes into a second historical list in this file.

The complete shipping procedure is in
[docs/release-checklist.md](docs/release-checklist.md).
