# Paired browser capability matrix

Scope: #4095, shared desktop chat in `/remote/` and the existing Mobile Companion activity
surface in `/`. This is a client of an awake, running Copse desktop. Explicit Quit, host sleep,
network loss and disabled Mobile Companion make it unavailable. It is not a detached daemon.

Acceptance: a paired browser sends a message through the real HTTPS server and dispatcher,
receives the answer once, queues and stops work, answers a question and declines/approves a
pending request. Closing the desktop window, including while idle, must keep these paths
working. Reopening must retain one renderer/queue owner and the same message IDs. Revoked or
read-only credentials cannot act. Temporary disconnection must preserve the unsent draft;
uncertain delivery must reuse its request identity, and stale runs/prompts must fail closed.

The machine-readable companion, `remote-client-capabilities.json`, accounts for **every wire
channel** in the generated API manifest. `scripts/lib/remote-capabilities.test.ts` fails on
unclassified additions/removals, on overlap, and if transport read/action allowlists drift.
This is an inventory, not permission to expose desktop IPC. Adding support requires a narrow
validated operation, access checks, UI availability and behavioral tests.

| Capability                                                                     | Shared remote chat / companion                                                        | Acceptance evidence                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Saved and live transcript; Markdown, reasoning, tool cards                     | Shared desktop conversation renderer; snapshots polled every 1.5s                     | Paired-browser e2e, shared-remote-chat demo; client hydration tests                               |
| Existing chats, project activity, new chat                                     | Companion activity and existing submission pipeline                                   | mobile-controls e2e; paired-browser e2e                                                           |
| Send text, queue follow-up, stop                                               | Supported; server deduplicates deliveries and binds Stop to a run ID                  | Paired-browser and mobile-controls e2e; remote/client tests                                       |
| Approve / deny once; answer questions                                          | Shared chat decision cards and companion; no remembered grants                        | Paired-browser and mobile-controls e2e; mobile boundary tests                                     |
| Draft, retry, reconnect                                                        | Unsent draft retained in this page; uncertain retry retains identity                  | Paired-browser e2e; shared-remote-chat demo; client tests                                         |
| Read-only pairing                                                              | Saved activity/transcripts in companion; shared chat requires control                 | Paired-browser auth checks; mobile-controls e2e                                                   |
| Revocation and access downgrade                                                | Checked before actions and after awaited reads; controls disabled on failure          | Paired-browser e2e; remote-http/interface tests                                                   |
| Desktop window closed                                                          | Hidden primary renderer retained while companion is enabled, with throttling disabled | Paired-browser e2e (idle close, run, question, approval, queue, reopen); window-detach unit tests |
| Explicit Quit / sleeping host                                                  | Unavailable; connection UI disables writes                                            | Connection failure tests; real-device sleep/resume acceptance remains required                    |
| Suggested next prompt                                                          | Supported, editable before send                                                       | Shared-remote-chat demo and remote-composer tests                                                 |
| Todos, model identity, usage                                                   | Display where supplied by shared transcript/companion                                 | Shared conversation and companion tests; not a model-changing API                                 |
| Images                                                                         | Existing companion accepts one validated image; shared composer is text-only          | Existing mobile-message-image tests; shared-composer attachment parity deferred                   |
| Model selection, reasoning controls, attachment composer                       | Not yet supported in shared remote composer                                           | No exposed picker or inert attachment controls; tracked as parity backlog                         |
| Rename/archive/delete/fork/rewind threads                                      | Desktop only                                                                          | Wire inventory; require explicit remote operations before enabling                                |
| File tree, file/diff editor, git/PR management, terminal, browser/desktop pane | Desktop only                                                                          | Wire inventory; no generic IPC forwarding                                                         |
| Settings, keys, trust, packs, agent installation, sandbox grants               | Desktop only; only reviewed nonsecret setting reads                                   | remote-interface boundary tests and wire inventory                                                |
| Native dialogs, editor launch, OS integration                                  | Desktop only                                                                          | Unsupported calls rejected in browser transport                                                   |

## Validation and release evidence

Run `pnpm run check`, `pnpm run build`, `pnpm run build:demo`, the focused paired-browser
Electron spec and shared-remote-chat browser specs. The paired-browser spec runs the actual
app/mobile HTTPS server and a separate ordinary browser; only model responses are scripted.
Its LAN address and profile are isolated; never send test actions to the daily Copse instance.
Capture and inspect light/dark narrow-screen screenshots. Local macOS images are review
artifacts, not replacements for CI Linux reference screenshots.

Before calling physical-phone acceptance complete, record real iPhone Safari and Android Chrome
results for pairing/certificate trust, keyboard positioning, enlarged text, background/resume,
network changes, and revocation. Emulation and a successful build do not establish those claims.

## Remaining parity work

Prioritize shared-composer images/model selection, thread management, then workspace viewers.
Each addition must update this matrix, classify its wire surface and exercise the real paired
transport. Keep snapshot state read-only: the browser must never start a second dispatcher,
autosave desktop transcripts, or persist its own copy over the runtime's messages.
