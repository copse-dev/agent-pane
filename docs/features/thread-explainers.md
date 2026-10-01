# Animated explanations in a thread

In **Settings → Experimental → Animated explainers**, choose **Open explainer
settings…**. This opens **Canvas and explainers** with its plugin settings expanded.
Enable the plugin and turn on **Animated explainers (experimental)**. You can also
find these controls under **Customise → Plugins** or by searching Settings for
“Animated explainers”. The explainer setting defaults to off, including for people
who already use Canvas. It takes effect without restarting Copse. Then ask in an
ordinary conversation:

> Explain how we find the code behind a question.

The thread's selected model reads relevant project context, writes three to six short
narration beats, and invents an appropriate visual style and drawing. It calls
`preview_explainer` to inspect actual rendered frames, then `render_explainer` with
only the returned preview ID. Copse embeds the exact reviewed animation in its reply.
No separate editor, storyboard form, hosting service, or additional provider key is
involved.

The agent performs the preview and quality review itself and publishes automatically.
It asks the user to review a draft only when the user explicitly requests that step.

Ask “make it simpler”, “focus on the engineering details”, or “try another style” to
revise it. Every render has a unique Canvas identity, preserving earlier cards. The
shared player provides play/pause, seeking, replay, and a written narration transcript.
Playback starts on request and pauses when the document is hidden. Narrow cards have
an additional readable caption below the picture. Silent narration is the default;
spoken narration and product MP4 export are outside this increment.

## Original drawings

The preferred input is `beats` plus `drawing`. The model supplies a style name,
art direction, background and ink colours, and a Canvas drawing function body. It
receives `ctx`, `frame` and `helpers`; Copse supplies the player and composition.
The drawing area is 1280 × 480 inside a 1280 × 720 frame. Titles, captions and progress
live outside the drawing area, so models need not implement these repeatedly.

`frame` provides absolute `time`, total `duration`, zero-based beat `index`, beat
`progress`, `start`, `end`, `width` and `height`. Derive all state from these values
so seeking produces the same picture in either direction. Standard Canvas methods
are available, along with `helpers.textBox`, `text`, `rect`, `circle`, `line`, `clamp`, `ease`
and `mix`; the tool schema documents their signatures. No DOM, Node, network assets,
random values, clocks or asynchronous drawing are needed.

Use `textBox(label, x, y, width, height, options)` for text inside cards, buttons
and badges. It measures the visible glyph bounds, centres them horizontally and
vertically, and wraps within eight-pixel padding. Options include `align`
(left/center/right), `verticalAlign` (top/middle/bottom), `padding`, `size`,
`minSize`, `maxLines`, `lineHeight`, `color`, `weight` and `font`. Defaults are
28px text, a 26px minimum (or the requested size if smaller), and two lines. It
fits down to the minimum and reports overflow to the previewing agent instead of
clipping or dropping words. The agent should enlarge the box or shorten the label.
Reserve icon space by passing the text's portion of the box. Both drawing and
text use the caller's current transform, keeping labels attached during movement.
The original `text` helper remains compatible: its y coordinate is the middle
baseline, not an alphabetic baseline requiring an added offset. These are layout
primitives; colours, shapes, composition and motion remain the agent's choice.

Earlier paper, felt, print and miniature studies provide grounding for readable
labels, recognisable objects and consequential motion. They do not restrict the
model to named styles or templates. Source notes distinguish verified project
behaviour from illustrative examples. Preview checks cannot establish factual
correctness or comprehension; the model must inspect and revise its work.

## Compatibility

The older objects/scenes vocabulary still supports paper desk, isometric mailroom,
editorial comic, felt stop-motion, travel poster, kinetic print, miniature workshop,
folded paper and signal lab. Signal lab requires an explicit choice. Objects persist
between scenes; copy, edit, apply, discard and merge demonstrate changes to short
illustrative values. Its merge action is not a real Git merge. Existing three-beat
legacy stories also remain playable. These paths are retained for saved cards and
callers that already use them.

## Integration and boundaries

- The Canvas plugin owns turn-start guidance and the bundled MCP server. Both the
  plugin and its animated-explainers setting must be on to offer explainer tools
  and guidance. Turning off just the setting removes these live while preserving
  HTML Canvas tools. Stored cards remain playable.
- Guidance is executor-neutral and names only tools offered this turn. Explicit
  requests for text only abstain. Revision requests use the conversation and tool
  descriptions rather than a broad “make it simpler” intent matcher.
- Story fields are bounded and serialized as inert JSON. Generated drawing code
  runs in a dedicated worker with an OffscreenCanvas, separated from the player DOM
  and Node. Each frame has a two-second watchdog; failure terminates the worker and
  shows an unavailable state without freezing the chat.
- Self-contained Canvas artefacts permit blob workers under their inherited CSP;
  remote workers, external scripts and eval remain disallowed. The drawing player
  additionally denies all connections. Preview uses the same secured data URL as
  the inline player, an isolated in-memory session, and a network request deny rule.
- Preview returns one strip per beat with early, middle and outcome frames. It
  requires visible movement within at least one beat and checks repeatable seeking, but these are
  smoke checks rather than a guarantee of animation quality. The whole preview has
  a twenty-second timeout and responds to tool cancellation.
- Publishing custom drawings or composed scenes requires a ten-minute token for the
  exact previewed HTML. A bounded cache retains that HTML and narration so publishing
  needs only `previewId`, avoiding another code-generation pass. Changed stories need
  a fresh preview. This enforces preview generation, not the model's visual judgment.
- Existing Canvas ownership, sandboxed webviews, previews and persistence are reused.
  Per-run references insert the card once the reply stops streaming; the ACP bridge
  rebinds that queue per turn. Published cards do not depend on the preview cache.

## Validation

Builds parse the copied player scripts before bundling. The fast syntax gate also
parses fixture modules and their embedded drawing bodies before the longer static
checks. Artwork is not executed during these syntax checks.

Unit tests cover story bounds, inert serialization, narration timing, legacy
styles/mechanisms, causal ordering, preview matching, preview-only publication,
cancellation forwarding, plugin disable behaviour, tool availability, concurrent
ownership and ACP publication.

The Electron specs `thread-explainer.e2e.ts` and `thread-explainer-scenes.e2e.ts`
cover existing playback, values, revisions and persistence.
`settings-explainers.e2e.ts` covers default-off behaviour for existing Canvas users,
live tool registration and revocation, persistence, and the experimental settings UI.
`thread-explainer-drawing.e2e.ts` covers the shared player with original drawings,
preview strips, syntax/timeout/static/random failures, isolation, deterministic
seeking, narrow layout, revisions and reload, and saves native screenshots.

Scripted calls establish integration, not live-model quality. Use separate real-ACP
runs with ordinary prompts, unrelated project fixtures and a follow-up revision to
assess grounding, visual clarity, style choice and generation latency before
promoting this experimental feature beyond a limited alpha.
