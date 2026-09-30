# Animated explanations in a thread

With the experimental **MCP-UI canvas** plugin enabled, ask Copse in an ordinary
conversation:

> Explain how we find the code behind a question.

The thread's selected model reads relevant project context, writes three narration
beats, chooses a visual mechanism and style, and calls `render_explainer`. Copse
embeds a playable animation in its assistant reply. No separate editor, storyboard
form, hosting service, or additional provider key is involved.

Ask “make it simpler”, “focus on the engineering details”, or “try paper” to revise
it. Each render has a unique Canvas identity, so a new version preserves earlier
cards. The player has play/pause, seeking, replay, and a written narration transcript.
Playback starts on request and pauses when the document is hidden. Captions are
complete without audio. Spoken narration and MP4 export are not part of this
native increment.

## Visual vocabulary

The existing styles are paper desk, isometric mailroom, editorial comic, felt
stop-motion, travel poster, kinetic print, miniature workshop, folded paper and
signal lab. Automatic defaults favour concrete objects: paper for review, mailroom
for parallel investigation, travel for limited capacity, folded paper for routing,
and comic for a generic sequence. Signal lab requires an explicit choice.

The five mechanisms have literal meanings. Review shows three edits with two
accepted and one reverted; parallel shows three workers searching and gathering
reports; context removes older output; routing follows device, cloud and tool
stops. The agent should choose the neutral sequence when these actions do not
match the evidence. This is a bounded library, not an arbitrary animation model.
The storyboard must supply project-specific narration and labels. A source note
distinguishes verified behavior from a conceptual example.

## Integration

- The Canvas plugin owns the explainer turn-start guidance and the bundled MCP
  server. Disabling it removes both from future work, while stored cards remain.
- Guidance is executor-neutral and only names a tool actually offered this turn.
  Explicit requests for text only abstain. Follow-ups use the existing conversation
  and tool description rather than a broad “make it simpler” intent matcher.
- The bundled tool validates bounded story data and renders a shipped, self-contained
  HTML player. Model text is serialized into inert JSON and rendered as text.
  No model-authored script runs, and no network assets are needed.
- Existing Canvas ownership, sandboxed webviews, previews and persistence are reused.
  A per-run reference queue inserts the card at completion, once the reply has stopped
  streaming. The ACP bridge explicitly rebinds that queue per turn.
- The standalone Explainer Studio remains a development harness for the same visual
  vocabulary. The end-user flow is the conversation.

## Validation

Focused tests cover story bounds, escaping, narration timing, every style/mechanism
combination, plugin disable behavior, tool availability, concurrent ownership and
ACP bridge publication. `tests/e2e/thread-explainer.e2e.ts` drives the real Electron
UI with a scripted model tool call, checks changed animation frames and visible
controls, creates a second style, reloads the session, and saves a screenshot.

Scripted model calls prove integration. They do not establish how reliably a live
model grounds narration, chooses a style or follows revision requests; that needs
separate live-model evaluation before promoting this experimental feature.
