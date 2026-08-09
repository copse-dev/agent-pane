# Debugging real agent demos on a remote GUI machine

A polished agent demo has two conflicting requirements:

- the work should be produced by the real product and a real model; and
- the published playback should be deterministic, safe, and cheap to run.

The useful pattern is **real inference once, deterministic playback forever**.
Run Copse on a spare GUI-capable machine, record a tightly designed turn through
the product, preserve the raw export, convert it into a replay trace, and use a
focused visual eval to prove that the trace still drives the ordinary UI.

This is more than moving computation off a laptop. The remote machine becomes a
debugging instrument: it can host an isolated app profile, expose the native
Electron UI, run an authenticated ACP agent, serve the generated site, and
render screenshots while the coordinating machine remains usable.

For the trace format and converter commands, read
[`demo-walkthrough.md`](./demo-walkthrough.md). For containerised Linux e2e
offload, read
[`plans/remote-e2e-dev-loop.md`](./plans/remote-e2e-dev-loop.md). This guide is
about the interactive, macOS-GUI path used to create and debug a model-generated
walkthrough.

## What the workflow proves

Treat the finished demo as a small evidence bundle rather than a single screen
recording.

| Claim                                      | Evidence                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| The product invoked a quality model        | ACP route in the export plus the exact turn context from the agent session         |
| The model created the files                | Raw thread export and the generated workspace contents                             |
| The public demo is deterministic           | Generated `DemoTrace` checked into the repository                                  |
| The replay uses normal product paths       | Proposed-file events, Browser link routing, and pane controls exercised by an eval |
| The result looks correct                   | Focused screenshots captured at a fixed viewport                                   |
| Nothing private was published accidentally | Manual review of every tool argument in the emitted trace                          |

No single layer proves all six. In particular, a beautiful screenshot does not
prove model provenance, and a genuine model transcript does not prove that the
static demo can render the result.

## 1. Prepare an isolated remote target

Use a dedicated checkout and a short app-profile path on the remote Mac. Keep
the generated business workspace separate from the product repository and name
it after the demo business, not after Copse.

```sh
ssh mac-mini
cd ~/debugging/agent-pane
nvm use
npm ci

mkdir -p ~/debugging/crumb-and-bloom
```

Use a fresh `COPSE_PANEL_USER_DATA` and, when useful, a fresh
`COPSE_WORKSPACE_DIR` for every recording attempt. This prevents existing
projects, threads, selected models, and approval decisions from contaminating
the recording.

Keep the profile path short. Electron's SSH askpass bridge creates a Unix-domain
socket below the profile directory; a long macOS Application Support path can
exceed the platform socket-path limit and fail at startup with `listen EINVAL`.
A short directory such as `.copse-demo-recording` avoids that class of failure.

Do not copy model credentials between machines. Authenticate the agent on the
remote machine using its normal login flow so the run exercises the same path a
user would.

## 2. Make the GUI observable

Headless Chromium is excellent for repeatable evals, but it can hide problems
in native dialogs, focus, window sizing, and Electron startup. Keep at least one
recording attempt visible.

On macOS, opening an application over SSH does not always create a usable window
in the logged-in GUI session. AppleScript can make that intent explicit:

```sh
osascript \
  -e 'tell application "Google Chrome"' \
  -e 'make new window' \
  -e 'set URL of active tab of front window to "http://127.0.0.1:4173"' \
  -e 'activate' \
  -e 'end tell'
```

Screen capture is a separate macOS permission. A visible window can exist while
`screencapture` still reports `could not create image from display`. Do not
weaken permissions just to make automation green: use the visible session for
interactive debugging and WebdriverIO for the committed screenshot evidence.

## 3. Prove the ACP route before spending a recording

Install the ACP adapter under the Node version used by the repository, complete
its login, and verify the route before launching Copse. Non-login SSH shells
often omit `nvm` from `PATH`, so an adapter can work interactively and then fail
when started by automation. Resolve the actual Node and adapter binaries rather
than assuming the remote shell inherits them.

Record two model identifiers separately:

- **Product route**, for example `acp:codex`. This is what Copse selected and
  what the thread export normally retains.
- **Underlying model**, from the matching ACP agent turn context. The adapter
  may record a concrete model such as `gpt-…` even when the Copse export can only
  prove `acp:codex`.

Use a unique phrase from the recording prompt to locate the exact agent session,
then extract only the `model` and `effort` fields. Avoid dumping unrelated
session contents into logs.

This distinction prevents a provenance mistake: the coordinating agent may
design the prompt and automate the recording, while the ACP model inside Copse
is still the model that authored the site.

## 4. Design the recording for replay

For a hero-sized file-creation demo, the prompt should enforce these properties:

1. **One user turn.** Thread usage is aggregate, so a single turn is what lets
   the converter emit an honest usage footer.
2. **Create files rather than editing existing ones.** A whole new file reads
   better at demo scale than an unexplained hunk in an existing project.
3. **Explain the complete approach first.** The export groups prose and tool
   calls rather than preserving every live interleave. Narration between writes
   can replay in the wrong order.
4. **Avoid discovery when the workspace is intentionally empty.** Explicitly
   say not to inspect it. Otherwise an agent may issue a file search that adds
   noise or requires approval.
5. **Avoid approvals and questions.** The playback has nobody available to
   answer them.
6. **Finish with one bare loopback URL.** The Markdown link handler can route it
   into the Browser panel.

Keep the prompt short enough to watch being typed. At roughly 28 characters per
second, a 2,000-character prompt spends more than a minute before inference even
appears. A prompt around 700–900 characters still constrains the output while
keeping the whole walkthrough comfortably observable.

The model should generate into a fresh business workspace. Reusing a successful
workspace for a second take violates the “create new files” constraint and
changes the tool behaviour.

## 5. Preserve raw evidence before normalising anything

Export the Copse thread as JSONL and make an untouched copy. Native save dialogs
are intentionally outside normal DOM automation and can leave Electron waiting
for a filename; plan a manual save step or a pre-agreed export location rather
than trying to type through the renderer.

The converter's redaction boundary deserves special attention:

- prose and tool results pass through secret redaction; but
- **tool-call arguments are published verbatim**.

For `write_file`, that means the path and the entire generated file content are
public. Review the emitted TypeScript module, not only the source transcript.
Search for home directories, user names, private repository paths, tokens,
internal host names, and tool metadata that was never meant for a marketing
page.

Some ACP adapters export a generic edit event with an empty argument object even
though the model really changed files. Such a trace is authentic but cannot
recreate the workspace during playback. When that happens:

1. keep the raw JSONL unchanged;
2. copy the exact generated files from the isolated recording workspace;
3. create a clearly named replay-normalised derivative;
4. replace only the payload-less edit marker with deterministic `write_file`
   calls containing those exact bytes; and
5. run the normal trace converter against the derivative.

This is repair, not regeneration. Never ask another model to recreate missing
content and present it as the recorded output.

## 6. Make localhost honest in a static demo

A published browser demo has no development server behind the model's
`http://localhost:…` link. The replay does, however, already hold the proposed
files in memory.

A robust static preview can therefore:

1. retain replayed writes in the demo API;
2. resolve the loopback URL to `index.html`;
3. read local stylesheet and script references from the same in-memory file
   set;
4. inline those assets into an iframe `srcdoc`; and
5. sandbox the iframe so generated JavaScript cannot reach the surrounding demo.

Keep real Electron behaviour unchanged. Electron should continue using its
actual `<webview>` and a real localhost server; the `srcdoc` fallback is only
for the static browser host.

If autoplay should end on the site, make the transition observable rather than
time-based:

1. click the final assistant link through the public DOM;
2. wait until the preview iframe reports that its workspace document is ready;
3. invoke the pane's normal Expand control; and
4. preserve chat alongside the expanded Browser pane.

Waiting for readiness is the important part. A fixed sleep can produce a demo
that occasionally expands a blank panel on slower machines.

## 7. Turn the run into an executable visual eval

The eval should assert both the trace semantics and the final composition. A
focused walkthrough can verify:

- exactly one user message;
- the intended project and business name;
- the expected number and paths of proposed files;
- the recorded usage footer;
- Browser navigation to the bare loopback URL;
- a meaningful element inside the generated iframe, not merely iframe
  existence;
- in-place expansion rather than a native pop-out;
- chat and titlebar still visible;
- irrelevant project chrome hidden; and
- minimum pane and preview dimensions at the reference viewport.

Capture at least two screenshots:

- the generated-file review state; and
- the loaded Browser preview with chat alongside it.

DOM assertions catch behaviour regressions. Screenshots catch typography,
clipping, awkward responsive breakpoints, and panel proportions that are valid
according to the DOM but visibly wrong.

Run the narrow loop while iterating:

```sh
npm test -- autoplay demo-api browser-pane
npm run build:demo
npm run test:demo -- --spec tests/demo/<walkthrough>.demo.ts
```

Then run the repository gates required by `AGENTS.md`. If the broad suite has
known environmental failures, report them separately from the focused evidence;
do not turn an unrelated red suite green by weakening the new eval.

## Failure modes worth remembering

| Symptom                                 | Likely cause                                          | Response                                                             |
| --------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| `listen EINVAL` for `askpass.sock`      | App profile path exceeds the Unix socket limit        | Use a shorter isolated profile path                                  |
| `npm: command not found` over SSH       | Non-login shell did not load `nvm`                    | Use the resolved Node bin directory or an explicit login shell       |
| Demo test cannot bind port 4173         | A manual preview server is still listening            | Resolve the exact PID with `lsof`, stop only that process, then test |
| Electron is stuck behind a save dialog  | Native dialogs are outside renderer automation        | Complete the save visibly or use a planned export location           |
| Replay has an edit card but no files    | ACP export omitted edit arguments                     | Preserve raw JSONL and make an exact-byte replay derivative          |
| Hero takes too long to start            | Recording prompt is too long for human-speed autoplay | Shorten constraints without weakening the one-turn contract          |
| Visible Chrome process has no window    | Remote launch missed the GUI session                  | Create and activate a window explicitly with AppleScript             |
| `screencapture` cannot read the display | macOS Screen Recording permission is absent           | Use WebdriverIO screenshots; do not silently broaden permissions     |
| Preview expands blank intermittently    | Expansion races iframe construction                   | Wait on an explicit preview-ready signal                             |

## The reusable idea

Remote execution, ACP inference, trace conversion, and visual evals are not four
separate tricks. Together they form a debugging loop:

1. **Observe** the real product on a disposable remote GUI profile.
2. **Generate** through the same authenticated agent route a user would choose.
3. **Capture** raw evidence before transforming it.
4. **Normalise** only what the transport failed to serialize, preserving exact
   generated bytes.
5. **Replay** through ordinary UI and state paths.
6. **Evaluate** semantics and appearance at a fixed viewport.
7. **Publish** the trace and screenshots, not the live model dependency.

That loop is useful beyond marketing demos. It is a practical way to reproduce
GUI-only bugs on spare machines, compare ACP adapters, create deterministic
regression fixtures from real inference, and let an agent keep working locally
while expensive rendering runs elsewhere.
