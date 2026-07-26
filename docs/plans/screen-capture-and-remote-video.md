# Screen capture from simulators and remote machines

**Status: Proposed.** Design only. This builds on
[`docs/video-frames.md`](../video-frames.md) — the `video_frames` tool
([#1227](https://github.com/copse-dev/agent-pane/pull/1227)) — and assumes it
lands first. Nothing here is implemented.

## The ask

Today a user records their screen with the OS recorder, finds the file, and
drops it on the composer. That works when the thing being debugged is on the
machine running Copse. It does not when the thing being debugged is an iOS
Simulator on a build mac, an Android emulator, or a browser on the Linux box the
SSH workspace points at — which is most of the cases where "let me show you what
it does" is the fastest way to explain a bug.

So: take a screen recording of a simulator or a remote machine, land it in the
chat as a video attachment, and let the agent analyse it across time.

## What "streaming" means here, and what it does not

The word bundles three separable capabilities, and only the first two are needed
for the sentence above:

1. **Capture** — producing a recording of something that is not already a file on
   the user's disk.
2. **Transfer** — getting those bytes to where the decoder is, or avoiding the
   need to move them at all.
3. **Liveness** — reading a recording that is still being written.

The plan covers all three, in that order, because each is independently useful
and (1) + (2) alone deliver the ask. What it deliberately does not attempt is a
live pixel feed the model watches — `video_frames` samples by seeking, and no
part of the design assumes a video stream exists.

## What `video_frames` assumes today

Three assumptions in the shipped tool break the moment the recording is not a
local file at rest:

| Assumption                                                   | Where                                    | What breaks                               |
| ------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------- |
| The whole file can be read into memory as one buffer         | `video-frames-tool.ts:220`               | 256 MB cap is per-file, per-call          |
| Reading goes through `WorkspaceFs.readFileBytes`             | same                                     | correct shape — but see the SSH bug below |
| A video is a single seekable container with a known duration | `decode-contract.ts`, `video-decoder.ts` | a recording in progress has neither       |

The second one is worth calling out on its own, because it is a live bug rather
than a limitation:

> **`video_frames` cannot read any real video on an SSH workspace today.**
> `SshWorkspaceFs.readFileBytes` (`ssh-workspace-fs.ts:93`) runs
> `base64 -w0 <path>` through `execOnSshHost`, and every SSH exec result is
> capped by `appendFlatCapped(..., COMMAND_OUTPUT_MAX_BYTES)` — **100 KiB**
> (`subprocess-output-cap.ts:2`). Base64 inflates 4/3, so anything over ~75 KiB
> comes back truncated, with `[output truncated]` spliced into the middle of the
> payload, and is then base64-decoded into garbage that the decoder rejects as a
> corrupt file. `describeWorkspaceVideo` has a second, smaller version of the
> same problem: it calls `statSync` on a path that may be on another machine.

Fixing that is P0 below and is worth doing whether or not the rest of this plan
proceeds.

## Decisions

### 1. A recording is a **segment set**, not a file

The central structural change. A capture writes a directory, not a file:

```
<thread>/blobs/media/<recordingId>/
  recording.json          # manifest: source, clocks, segments
  000.mp4                 # 0.000s – 10.012s
  001.mp4                 # 10.012s – 20.031s
  …
```

```typescript
interface Recording {
  id: string
  source: { kind: CaptureKind; label: string; target: 'local' | { hostId: string } }
  /** Wall clock when capture started, on the *capturing* machine. */
  startedAt: number
  /** capturingClock − localClock, measured at start. Zero for a local capture. */
  clockSkewMs: number
  segments: RecordingSegment[]
  /** Absent while the capture is running. */
  endedAt?: number
}

interface RecordingSegment {
  index: number
  /** Offset of this segment's first frame within the recording. */
  startOffsetSeconds: number
  durationSeconds: number
  /** Where the segment lives on the capturing machine. */
  remotePath?: string
  /** Local copy, once pulled. Absent means "not fetched yet". */
  path?: string
  sizeBytes: number
}
```

Five things fall out of this that do not fall out of a single file:

- **Every transfer is bounded.** A `video_frames` call for 01:30–01:40 of a
  40-minute remote session pulls the one or two segments that overlap it, not
  4 GB. Segments are cached after the first pull, so a second look at the same
  moment costs nothing.
- **A running recording is readable.** A closed segment is a complete, seekable
  container; the open one simply is not offered yet. No partial-container
  parsing, no `moov`-atom repair.
- **Android is possible at all.** `adb shell screenrecord` has a hard 180-second
  limit per invocation. Under the segment model that is not a special case — it
  is just this source's segment length.
- **A crashed recorder loses one segment**, not the session.
- **The 256 MB cap becomes per-segment**, so session length stops being bounded
  by a constant chosen for a dropped file.

`video_frames` gains a second way to be addressed — a recording id or the
recording directory — and maps the requested window onto segments internally,
decoding each and translating frame times back to absolute recording time. Frame
naming does not change: names stay absolute positions in the recording, never
offsets into a segment, exactly as they are already absolute rather than offsets
into a requested range.

### 2. Capture sources sit behind one interface, and the app ships no encoder

```typescript
interface CaptureSource {
  id: string // 'ios-simulator:<udid>', 'window:<id>', 'display:1'
  label: string // 'iPhone 16 Pro — Simulator'
  kind: CaptureKind
  target: ExecutionTarget // reuses the local/ssh union already in the codebase
}
```

Five implementations, in the order they earn their keep:

| Source             | How                                                                           | Notes                                                                  |
| ------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Window or display  | Electron `desktopCapturer` + `MediaRecorder` in a hidden window               | No toolchain assumptions; covers Simulator.app and the emulator window |
| iOS Simulator      | `xcrun simctl io <udid> recordVideo --codec h264 --mask ignored`              | Enumerate with `simctl list devices booted -j`; **stop with SIGINT**   |
| Android emulator   | `adb -s <serial> shell screenrecord` → `adb pull`, one call per segment       | 180 s ceiling per call; mp4 finalised only on clean stop               |
| In-app browser tab | CDP `Page.startScreencast` on the existing `BrowserSessionManager` window     | No OS permission at all; can skip the container entirely (see below)   |
| Remote display     | Whatever the host has: `ffmpeg -f x11grab`, `wf-recorder`, `screencapture -v` | Capability-probed, never assumed                                       |

Two of those deserve their reasoning stated:

**The hidden-window recorder mirrors the hidden-window decoder.** `video-decoder.ts`
already establishes the pattern — a `show: false` `BrowserWindow` with
`backgroundThrottling: false`, a lockdown call, an idle teardown, and a
request/response IPC contract in `src/shared/video/`. A recorder window is the
same shape: `desktopCapturer.getSources()` in main, `getUserMedia` with the
chosen source id in the hidden renderer, `MediaRecorder` with a `timeslice`
producing one blob per segment. Chromium encodes; nothing new is shipped,
licensed, or vetted — the same argument that kept ffmpeg out of #1227. It also
means the highest-value source (any window on the machine, including a simulator
whose CLI we do not have) needs no per-platform tooling.

**Using the remote host's ffmpeg is not shipping ffmpeg.** `SshWorkspaceFs`
already builds the remote filesystem out of `base64`, `realpath`, and `stat` that
happen to be on the host. A remote display capture is the same bargain: probe for
an encoder, use it if present, and return a specific, actionable error if not.
Extend `SshCapabilityReport` (which already reports `git`, `rg`, `inotifywait`)
with `ffmpeg`, `xcrun`, `adb`, and `screencapture`, so the source picker can say
_why_ a host offers nothing rather than showing an empty list.

**The browser-tab source can skip video entirely.** `Page.startScreencast`
delivers JPEG frames with timestamps — which is exactly the `FrameCandidate[]`
shape `frame-selection.ts` already consumes. Encoding those into a container just
to seek back through them would be silly. Worth building last, but the frame
selector should not assume its input came from a decode.

### 3. Fix the remote read with a stream, not a bigger cap

`readFileBytes` accumulates into a JS string and is capped for good reason — it
is the same helper that stops a chatty command flooding a tool result. Raising
the cap to video sizes would be wrong for every other caller.

Instead add a binary channel to the transport:

```typescript
interface SshTransport {
  // …existing
  fetchFile(remotePath: string, localPath: string, opts?: SshExecOptions): Promise<void>
  sizeOf(remotePath: string): Promise<number>
}
```

`fetchFile` spawns `ssh … host cat -- <path>` with the existing argv builder and
ControlMaster socket, and pipes stdout straight into a local write stream — the
bytes never become a string, so no cap applies and memory stays flat. No new auth
surface: same `baseSshArgs`, same control socket, same askpass lease.
`sizeOf` runs first so an oversized file fails before the transfer rather than
after it. There is precedent for a call-site-specific limit already
(`FILE_INDEX_LIST_MAX_BYTES` raises the cap to 8 MB for path listings), but a
stream is the right answer for something that is megabytes by definition.

`WorkspaceFs` gains `fetchToLocal(path)` — a no-op returning the same path
locally, a cached pull over SSH — and `video_frames` calls that instead of
`readFileBytes`. `describeWorkspaceVideo`'s `statSync` becomes
`getActiveWorkspaceFs().stat()` at the same time.

### 4. A capture lands in the chat the way a dropped file does

The attachment path from #1227 is already the right one and should not be
duplicated: `video:attach` → `VideoAttachmentRef` → composer chip → `Thread.videos`
on send → `applyVideoToolAvailability` offers `video_frames` and names the paths
in its description. A capture produces the same `VideoAttachmentRef` (pointing at
the recording directory) and joins that flow at the chip.

There is one wiring gap, and it is easy to miss: **`Thread.videos` is written by
the renderer.** `recordThreadVideos` (`src/shared/store/thread-helpers.ts`) runs
against the renderer's `AppStore` on send. A capture the _agent_ starts finishes
in main, so main must push the ref out (a `thread:videoAttached` IPC event the
renderer folds into the store) — otherwise the tool stays withheld on the very
thread that just recorded a video, because `getThreadVideos()` reads a `meta.json`
the renderer owns.

Two entry points, both gated:

- **UI** — a record control in the composer opening a source picker (local
  windows and displays, booted simulators, devices, plus the remote host's
  sources when the workspace is an SSH one). While recording, the chip ticks up
  a duration and offers stop; on stop it becomes the existing film chip.
- **Tool** — `screen_record({ action: 'start' | 'stop' | 'list', source })`, so the
  agent can reproduce a bug and look at it without a human in the loop. Off by
  default behind a `screenCaptureEnabled` setting, wired exactly where
  `browserToolsEnabled` is: `settings-writable.ts`, `settings-dialog.ts`,
  `agent-system-prompt.ts`, `registry-bootstrap.ts`, `permission-gate.ts`,
  `tool-display.ts`.

### 5. Wall-clock time is the point of "time analysed"

A dropped file has only one clock: position in the video. A recording the app
started has three, and knowing all of them is what turns a set of screenshots
into an analysis:

- **Video time** — what frame names already carry.
- **Wall clock** — `startedAt + t`, so `frame-12.480s.jpg` is `14:03:21.480` and
  can be lined up against a log line, a test failure, a CI step, or the
  `run_background` output already in the thread.
- **Skew** — the capturing machine's clock is not the local one. Measure it once
  at capture start (remote `date +%s.%N` against local `Date.now()`), store it on
  the manifest, and **state it in the result**. Silently correlating a simulator
  recording against a host log when the clocks differ by 400 ms produces a
  confident wrong answer, which is worse than no correlation.

Two surface changes, both minimal by #1227's own doctrine that manifest lines are
priced per line:

- One header line stating the mapping once — `Recorded 14:03:09.000; frame-12.480s.jpg is 14:03:21.480` —
  and **no second column** on each frame line restating it.
- An optional `clock: 'video' | 'wall'` argument on `video_frames`, so a model that
  read `14:03:21` in a log can pass it straight back as `start`. It has to be
  explicit rather than sniffed: `hh:mm:ss` is already a legal _video_ position, so
  guessing would silently reinterpret every existing call.

### 6. Reading a recording that has not finished

Once segments exist this is almost free, and it follows the disclosure pattern
#1227 already established for "what this call did not look at":

- Only closed segments are offered.
- The header says what is missing: `Still recording — the last 4.2s has not been written yet. Re-run to pick up more.`
  Without that line, "nothing changed after 30s" reads as a finding rather than
  as the edge of the data.

A blocking follow mode (`wait_for_segments`) is deliberately out of scope: an
agent turn that blocks for a minute is worse than one that samples, answers, and
is asked again.

## Security and privacy

Screen capture is the most invasive capability in the app. It is also the one
where the honest disclosure is short, so the UI should just say it:

**The recording never leaves the machine. The frames the agent reads do.**

- **Off by default**, both the setting and per-source consent. Never a
  default-selected "entire desktop" — the picker leads with the specific window
  or simulator, because that is both the common case and the containable one.
- **A visible indicator while recording**, in-app, not only the OS one.
- **macOS TCC**: check `systemPreferences.getMediaAccessStatus('screen')` before
  starting and surface a real message. Without it macOS hands back a black or
  desktop-picture frame and the failure looks like a decoder bug.
- **Agent-initiated capture is permission-gated** at the browser-tools tier: the
  in-app browser and a named simulator can auto-run; a display or window capture
  prompts, because what is on the rest of the screen is not the agent's to decide
  about.
- **Remote temp files are the sharp edge.** A remote capture writes to the host's
  disk under `mktemp -d`; a killed recorder that leaves gigabytes in `/tmp` on a
  shared build box is the failure mode to design against. Clean up on stop, on
  abort, and on reconnect (sweep stale `copse-rec-*` directories owned by us).
- **Retention.** Recordings are large and land in the thread store, which is
  deleted with the thread but otherwise grows without bound. A per-thread size
  budget that prunes oldest-first, surfaced in the chip, is the smallest thing
  that works.

`docs/threat-model.md` and `docs/privacy-data-flow.md` both need a paragraph;
capture is a new class of input, not a variation on file reading.

## Phases

Each is independently shippable and independently useful.

| Phase                   | Scope                                                                                                                              | Rough size |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **P0 Remote read**      | `fetchFile`/`sizeOf` on the transport, `fetchToLocal` on `WorkspaceFs`, async stat in `describeWorkspaceVideo`                     | ~1 day     |
| **P1 Segment sets**     | `Recording` manifest, `video_frames` addressing a recording, segment→absolute time mapping, wall-clock header, still-running line  | 2–3 days   |
| **P2 Local capture**    | Hidden recorder window, window/display + simulator + emulator sources, source picker, composer record chip, `screenCaptureEnabled` | ~1 week    |
| **P3 Remote capture**   | Capability probe extension, remote segment writer via `spawnBackgroundProcess`, lazy segment pull + cache, cleanup                 | 3–4 days   |
| **P4 Time correlation** | Skew measurement, `clock: 'wall'`, correlation with shell/terminal/CI output already in the thread                                 | 2–3 days   |
| **P5 Live analysis**    | Read-while-recording, stop-on-finding, the disclosure lines that go with both                                                      | ~2 days    |

P0 and P1 are worth doing even if capture never ships: P0 fixes a real bug, and
P1 is what makes a long recording affordable at all.

## Testing

The shape is already set by #1227 and by the SSH work, which both had to test
things a unit test cannot reach:

- **Pure units** — segment/absolute time mapping, skew arithmetic, manifest
  lines, capability-probe parsing, the adb 180-second segmentation boundary.
  These are the bulk and they need no device.
- **A fake capture source**, in the shape of `fake-ssh-transport.ts`, so the
  attachment flow, the chip, and the tool gating are all testable in CI with no
  simulator, no display, and no TCC prompt.
- **A real two-segment decode**, extending the trick #1227 used: record a webm
  in-process, split it, and drive it through the real `decoder.html` over the
  real IPC contract. That is the only way the segment-boundary maths gets
  checked against an actual decoder.
- **e2e** — record → chip → send → transcript, mirroring
  `tests/e2e/video-attachment.e2e.ts`, against the fake source.
- **A live harness** — `npm run validate:screen-capture`, mirroring
  `validate:browser-tools`, for the parts CI structurally cannot cover: TCC
  permission, `simctl`/`adb` presence, and a real remote host.

## Open questions

- **Does the agent get `screen_record` in v1**, or only the human? The UI button
  is most of the value and none of the permission surface.
- **Is remote _display_ capture worth building**, or is the real case "a mac over
  SSH with a simulator on it" — which P3 covers with `simctl` and no x11grab at
  all?
- **Segment length.** 10 s is a guess: it bounds a pull to a few MB and is well
  inside every source's limits, but a source with expensive start-up (simctl
  re-invocation per segment) may want longer.
- **Do captured frames get persisted?** #1227 left this open for dropped videos;
  a live recording makes it sharper, because re-running the tool after a reload
  may sample a recording that has since grown.
- **Retention default** — what a thread's recording budget should be before it
  prunes.
