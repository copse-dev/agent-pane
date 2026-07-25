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
…/Screen Recording.mov — 2560x1440, 00:02:14.300 long.
Sampled 00:00:00.000–00:02:14.300 (269 samples); 6 visually distinct frames returned at 1280x720.
Frames follow as images, in order, named by timestamp:
  frame-00-00-00.000.jpg  00:00:00.000
  frame-00-00-12.500.jpg  00:00:12.500  (34% of the frame changed)
  …
```

Each image is named for its position (`frame-00-01-23.450.jpg` =
`00:01:23.450`), so the model can quote a time back to the user and re-request
that moment with a tighter `start`/`end`.

Arguments:

| Argument      | Default     | Notes                                                               |
| ------------- | ----------- | ------------------------------------------------------------------- |
| `path`        | required    | Workspace-relative, or the absolute path given for an attachment    |
| `start`/`end` | whole video | Seconds (`12.5`) or `mm:ss` / `hh:mm:ss`                            |
| `max_frames`  | 10 (max 60) | Over the cap, the biggest-change frames are kept                    |
| `sensitivity` | `normal`    | `high` catches a changed line of text; `low` only major transitions |
| `max_width`   | 1280        | Longest edge of the returned frames                                 |

Audio is never decoded.

## How frames are chosen

The interesting part is deciding what counts as a _different_ frame.

Each sampled frame is reduced to a **signature**: a 32×18 grid of mean cell
colours (`src/shared/video/frame-selection.ts`). The distance between two frames
is the fraction of grid cells whose colour moved by more than a noise floor.

Three deliberate choices:

- **A grid, not a whole-frame metric.** Screen recordings change _locally_ — a
  dialog opens, a line of output appears, a tab switches. A frame average barely
  moves for any of those, so a global metric would score a meaningful change as
  identical. Counting moved cells catches localized change while ignoring codec
  noise.

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
