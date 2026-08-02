# Reading video as stills (`video_frames`)

Screen recordings are the easiest thing for a user to produce and the worst
thing to put in a model's context. A two-minute capture at 30fps is 3,600
frames of a screen that changed maybe eight times. No model watches video, and
sampling it naively — even one frame a second — spends a whole context window
on near-duplicates.

So Copse never sends a video to the model. A video attached to a chat is stored
next to the thread and the agent is handed its path; it reads the recording as a
small set of **visually distinct stills** through the `video_frames` tool. A
recording of a screen that never changes comes back as exactly one image.

## Attaching a video

Drop a video on the composer (or pick it with the paperclip). It appears as a
film chip with the file's size rather than as an image thumbnail — the size is
the only cost signal that matters, because the video itself costs no context.

Supported containers are whatever Chromium decodes on every platform we ship:
`.mp4`, `.m4v`, `.mov`, `.webm`, `.mkv`, `.ogv`. The cap is 256 MB.

Where the file goes depends on where it came from:

| Source                               | What happens                                          |
| ------------------------------------ | ----------------------------------------------------- |
| Dropped from the desktop             | Copied into `<thread>/blobs/media/` in the chat store |
| Dragged from the workspace file tree | Referenced where it lies; nothing is copied           |

Either way the prompt gains a short reference block naming the path and pointing
the agent at `video_frames`, and states plainly that the video is not in context
— otherwise a model reasonably assumes it can see an attachment and wastes a
turn asking why it cannot.

Deleting the thread deletes its stored videos with it.

### Over ACP

`video_frames` is offered to external ACP agents through the
[native-tool bridge](acp-agents.md), so an agent driving your workspace reads a
recording the same way the built-in loop does — one decoder, one sampling
policy, one set of budgets. The bridge returns the frames as MCP image content
rather than only the manifest text; without that the agent would receive a note
saying "frames follow" with nothing after it.

### Playing it back

The chip on a sent message is clickable: it opens the recording in a preview
modal (`src/renderer/attachments/video-expand.ts`), so whoever attached the
video can check what they attached. Nothing about this reaches a model — the
video is still only ever a path as far as the agent is concerned.

Two constraints shape it:

- **The renderer has to be handed the bytes.** There is no custom protocol, and
  `file://` is out for the same reason the decoder avoids it, so `video:read`
  returns the file over IPC and the modal plays it from an object URL (revoked
  on close — otherwise the whole recording stays pinned in renderer memory).
- **That read is authorised to exactly two roots**: the chat store and the
  workspace — the same places `video_frames` can already read. This grants the
  _renderer_ what the agent has, so anything outside is refused and the preview
  cannot become a general file-read channel.

Playback is capped at **50 MB**, far below the 256 MB chat limit, because the
extractor streams through a hidden window while a preview pins every byte in the
visible one. Over the cap the modal says so and names the size rather than
hanging on a load that will not finish.

## The thread remembers

Sending a message with a video records it on the thread's `meta.json`
(`Thread.videos`) — on send, not on attach, so a chip added and removed never
counts. Two turn-level decisions read that record in `parentTools`
(`src/main/services/agent-service.ts`):

- **`video_frames` is withheld from threads that have never had a video.** Its
  schema is ~480 tokens on every turn it is offered, and most threads never see
  a video. This mirrors `read_terminal`, which is withheld unless the thread has
  an open Shells tab.
- **When it is offered, the attached paths are appended to its description.**
  The reference block in the user's message says the same thing, but that message
  can be trimmed out from under a long conversation; the description is rebuilt
  every turn, so the model can always name a video it was given.

The consequence worth knowing: a video sitting in the repo that was never
attached (`docs/demo.mp4`) will not turn the tool on. Attach it, or ask on a
thread that already has one.

## What the tool returns

```
video_frames({ path: "…/blobs/media/2f8c…-Screen Recording.mov" })
```

```
…/Screen Recording.mov — 2560x1440, 02:14.300 long.
Sampled 0.000s–02:14.300 every 1.1s (120 samples); 2 changes found, returned as 6 frames at 1280x720.
Anything lasting less than 1.1s can fall between samples and not appear at all. …
Each change is bracketed by the samples either side of it, so a brief one reads
as before → change → after. Describe what moved between them, not what each
frame contains.
Frames follow as images, in order. Each is named for its position in the video —
frame-0.000s.jpg is 0.000s:
  frame-0.000s.jpg
  frame-11.400s.jpg  (before)
  frame-12.500s.jpg  (34% changed)
  frame-13.600s.jpg  (after)
  …
```

Each image is named for its position **in the video** — always absolute, never
an offset into the requested range — so the model can quote a time back to the
user and re-request that moment with a tighter `start`/`end`.

### The manifest is priced per line

Every frame line is paid for on every call, so redundancy there is the one place
in this design worth being stingy:

- **Timestamps scale to the recording.** A 57-second clip has no hours and no
  minutes, so `frame-00-00-03.386.jpg` spends four tokens saying "not hours, not
  minutes". Names become `frame-3.386s.jpg` under a minute, `frame-01-23.450.jpg`
  under an hour, and only then the full `frame-00-01-23.450.jpg`. Every form
  round-trips through `parseTimePosition`, so the model can hand any of them
  straight back as `start`/`end` — including the bare `3.4s` it would reach for
  unprompted.
- **The timestamp appears once, in the name.** A second column restating it cost
  a few tokens per line to repeat the number the model had just read. The header
  states the mapping instead, worked through the first frame's real name rather
  than an invented example.
- **Role labels are one word.** `(before)` and `(after)` say everything
  `(the state just before the next change)` did; the sentence explaining how to
  read the sequence is in the header, where it is paid for once.

Together that is roughly half the tokens per frame line, for the same
information.

Arguments:

| Argument      | Default     | Notes                                                               |
| ------------- | ----------- | ------------------------------------------------------------------- |
| `path`        | required    | Workspace-relative, or the absolute path given for an attachment    |
| `start`/`end` | whole video | Seconds (`12.5`, `12.5s`) or `mm:ss` / `hh:mm:ss`                   |
| `max_frames`  | 10 (max 60) | Images, not changes — a change costs up to 3 with its context       |
| `sensitivity` | `normal`    | `high` catches a changed line of text; `low` only major transitions |
| `interval`    | derived     | Seconds between samples; clamped, not rejected, if out of range     |
| `max_width`   | 1280        | Longest edge — width _or_ height — of the returned frames           |

Audio is never decoded.

### Sampling resolution, and what it cannot see

The tool samples ~120 positions across whatever window you ask for, so the gap
between samples comes from the window length: ~480ms across a whole 57-second
recording, ~42ms across a 5-second range, ~33ms (one video frame) across two and
a half. **Narrowing `start`/`end` is what buys temporal resolution** — the seek
count stays the same, so a close look costs no more than a survey, and a full
survey is no coarser than the old fixed grid.

This matters because of the blind spot it implies: an event shorter than the
sampling gap can fall between two samples and never appear at all. A UI flicker
is often one or two frames. So the manifest states the interval it used and says
so outright, rather than letting "no distinct frames" read as "nothing happened".

A ranged call has a second blind spot, and it is the one that actually bit in
testing: it decodes only its range, so nothing in the result can say anything
about the rest of the recording. Left unsaid, a model that finds a change in the
window it was handed reports it and stops — even when the thing the user is
describing happens later, and the user then has to say "try around 3s". So a
result that covers less than the whole video names the remainder in seconds and
says to survey before concluding.

`interval` is also **clamped rather than rejected**. Asking for a finer gap than
the decoder offers is a reasonable thing to want, and failing the call on it cost
a whole turn: the model got a raw schema error back and had to retry with a legal
value.

`sensitivity: 'high'` also **drops the sub-second penalty** described below. The
penalty exists to stop an animation becoming one frame per tick during a broad
survey; someone who has narrowed to a couple of seconds and asked for high
sensitivity is explicitly asking to see everything, including the brief event
they zoomed in to find.

> An earlier version sampled on a fixed 0.5s grid regardless of the window. That
> silently made the tool's own advice useless — narrowing the range re-sampled
> the same grid — and anything shorter than half a second was invisible however
> far you zoomed in.

## How frames are chosen

The interesting part is deciding what counts as a _different_ frame.

Each sampled frame is reduced to a **signature**: ~576 mean cell colours on a
grid derived from the frame's aspect ratio (`src/shared/video/frame-selection.ts`).
The distance between two frames is the fraction of grid cells whose colour moved
by more than a noise floor.

Four deliberate choices:

- **A grid, not a whole-frame metric.** Screen recordings change _locally_ — a
  dialog opens, a line of output appears, a tab switches. A frame average barely
  moves for any of those, so a global metric would score a meaningful change as
  identical. Counting moved cells catches localized change while ignoring codec
  noise.

- **Cells stay square, so the grid follows the frame.** The grid was originally a
  fixed 32×18, which is only right for 16:9. On a portrait recording (2296×3916 —
  a phone capture, a tall window, a stacked layout) that made each cell 40×121px:
  a 3:1 vertical smear. A panel collapsing inside a short horizontal strip was
  averaged across three times its own height, so the cell mean never cleared the
  noise floor and the change was invisible at _every_ sensitivity. `signatureGridFor`
  now splits the frame into ~576 near-square cells — 32×18 for landscape, 18×32
  for that portrait capture — so a change registers in proportion to the area it
  actually covers.

- **Colour, not luma.** A luma-only signature is half the size and works fine for
  text, but it is blind to a status flipping red→green or a diff line going from
  removed to added — near-identical in brightness, and exactly the moment someone
  records a screen capture to show. (This was caught by decoding a real video,
  not by unit tests; see the regression test in `frame-selection.test.ts`.)

- **Compare against the last _kept_ frame, not the previous sample.** A slow
  change — a progress bar creeping, a page fading in — is a series of
  individually sub-threshold steps that would otherwise vanish entirely. It also
  makes a genuinely still recording collapse to one frame, because nothing ever
  clears the bar against the opening frame.

### Sub-second changes are held to a higher bar

Two frames a second or more apart are cheap to justify: whatever changed had time
to matter. Two frames 100 ms apart are almost always the same moment caught
mid-animation — a fade, a scroll, a menu sliding open — and returning both spends
a full image's worth of tokens on a duplicate.

So the threshold scales with how close together the candidates are: it relaxes to
the base value at a 1s gap and rises to 3× as the gap approaches zero. A burst of
motion has to be a genuinely large change to produce more than one frame.

## A change on its own is not readable

Finding the frame where something changed is only half the job. Handed that one
image, a model has the state _during_ the event and nothing to compare it
against — it cannot tell what appeared from what vanished, so it describes a
screenshot instead of a change. For a flicker, which is the thing people record
screen captures to show, that is worthless.

So every change is returned **bracketed by the samples either side of it**. A
brief event reads as before → change → after, and the manifest labels each frame
with its role so the sequence is self-describing:

```
  frame-1.000s.jpg  (before)
  frame-2.000s.jpg  (30% changed)
  frame-3.000s.jpg  (after)
```

Two consequences worth knowing:

- **Content appearing and content vanishing are two changes, not one.** A true
  flicker therefore comes back as before → appeared → gone → after. That is the
  correct reading, and it is what makes "it flashed and went away" visible
  rather than "there is a panel here".
- **`max_frames` is a budget in images, not in changes.** With context, the
  default of 10 covers roughly four changes rather than nine. That is a
  deliberate trade: four changes a model can actually read beat nine it can only
  see one frame of. The manifest says when it capped and names the lever.

Changes are taken in order of size rather than in time order, so when the cap
bites it is the smallest changes that go — an early flurry would otherwise eat
the whole budget and hide a bigger change later in the recording. A change whose
neighbours will not fit is still kept alone: a change with no context beats no
change at all.

### Nothing distinct is not the same as nothing happened

A range where nothing clears the threshold is ambiguous in the way that matters
most: the screen genuinely held still, or something moved and was judged too
small. Those want opposite responses — nothing, versus a closer look — and a
frame count cannot tell them apart.

So instead of returning the opening frame alone, the tool falls back to the
**largest change actually measured** (`peakChange`) and the sample before it —
a pair the model can read — and says plainly that it was under the bar:

```
Nothing cleared the bar for a distinct frame. The two frames below bracket the
largest change in this range (0.9% of the frame at 3.100s); if that is not
what you are looking for, re-run that moment with sensitivity:"high" and a
narrow start/end.
```

Sub-1% changes are printed to one decimal — rounding 0.4% to "0%" would say
precisely the opposite of what happened.

A single frame now means one thing only: **nothing in the range moved at all.**

## How decoding works

There is no ffmpeg. Chromium already ships the codecs and a `<canvas>` that can
downscale and re-encode, so decoding runs in a hidden `BrowserWindow`
(`src/main/services/video/video-decoder.ts` + `src/renderer/video/decoder.ts`)
that is created on first use and closed after a few minutes idle. That avoids a
per-platform binary, a licensing question, and another supply-chain surface for a
feature whose whole point is to be cheap.

Details worth knowing if you touch it:

- The video is handed over as bytes and turned into a **blob URL** in the
  decoder. A `file://` source would taint the canvas and force
  `webSecurity: false` on that window.
- The window sets `backgroundThrottling: false`. A hidden window is "occluded" as
  far as Chromium is concerned, and every seek is driven by an event-loop turn —
  without it a decode crawls.
- Frames are reached by **seeking**, not by playing through. That is what makes a
  range cheap: asking for 01:30–01:40 of an hour-long recording decodes ten
  seconds' worth, and the same request always returns the same frames.
- A sample identical to its predecessor is not encoded at all. A still recording
  is almost entirely such samples.
- Containers written by live recorders often report `duration: Infinity`; the
  decoder seeks past the end to make Chromium find the real one.
- `max_width` bounds the **longest** edge, not the width. Scaling on width alone
  is the obvious reading of the name and it is wrong for anything taller than it
  is wide: a 2296×3916 portrait capture came back at 1280×2183 — 2.8M pixels
  against the 0.96M a landscape frame gets from the same budget. Since image
  token cost is computed from pixel dimensions, a portrait recording silently
  cost ~3× per frame, and a dozen of them was enough to kill a local server's
  request mid-turn.

Frames come back as **JPEG at quality 0.8**. WebP is ~40% smaller on a dense
screen frame and was the original choice for that reason — it was the wrong
trade twice over. Image _token_ cost is computed from the pixel dimensions, not
the byte size, so WebP saved request bandwidth and no context at all; and several
OpenAI-compatible servers reject `data:image/webp` outright. LM Studio fails the
whole turn with `'url' field must be a base64 encoded image`. Quality 0.8 rather
than 0.7 because JPEG rings around small UI text, and an unreadable frame is
worth nothing however small it is.

## Images in tool results

`video_frames` is the first tool that returns pictures, so the tool-result
contract carries them (`packages/llm/src/tool-result-images.ts`):

- **Anthropic** accepts image blocks inside a `tool_result`, so the frames stay
  attributed to the call that produced them.
- **OpenAI-shaped APIs** (chat completions, responses) only accept a string as a
  tool output, so the frames follow as a user message immediately after the tool
  message.

Either way each image is labelled with its name first, so a model reading four
near-identical screenshots can say "at 00:01:23.450 the dialog is open" rather
than "in the third image". The text result always stands on its own: images are
stripped from the on-disk history (they are regenerable, and would grow a
thread's sidecar without bound), so a reloaded thread re-reads what it needs.

### When the model cannot take images at all

Nothing in the app knows whether a given model has vision — there is no such
field in the model catalog, and a local server can be pointed at anything. So a
text-only model would reject the request and kill the turn.

Instead, an image rejection is caught and the request is retried once with every
image replaced by a note saying they could not be shown
(`dropImageContent` + `isImageUnsupportedError`). The model then answers from the
frame manifest — which still names every frame and its timestamp — and can say
what it was unable to see, rather than the run dying on a 400 or, worse, the
model reasoning confidently about pictures it never received.

The match is deliberately narrow (a 400/415/422 whose message names an image):
a false positive would silently strip images from a request that could have
carried them. It also lives outside `isRetryableStreamError`, because this retry
_changes_ the request rather than replaying it.
