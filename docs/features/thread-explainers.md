# Animated explanations in a thread

With the experimental **MCP-UI canvas** plugin enabled, ask Copse in an ordinary
conversation:

> Explain how we find the code behind a question.

The thread's selected model reads relevant project context, writes four to six short
scenes, and chooses objects, actions and a visual style. It calls `preview_explainer`
to inspect actual rendered frames, then `render_explainer` to publish that story. Copse
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
signal lab. The model chooses an appropriate style independently of the actions;
`auto` defaults composed scenes to paper. Signal lab requires an explicit choice.

Objects persist between scenes. Copy reveals an independent file with the same
contents; edit changes one file; apply moves a proposal into the saved file; discard
removes only the proposal; merge shows a conflict if the illustrated values differ.
Appear, move, connect and highlight support other explanations. Actions in one scene
run together, so dependent actions require separate scenes. Labels and displayed
values stay short; captions provide complete silent narration.

This is a bounded illustration vocabulary. Its merge action compares short displayed
values, not real Git patches: the agent must ground the illustrated example and explain
any simplification. A source note distinguishes verified behavior from a conceptual
example. Existing three-beat stories and their five legacy mechanisms still render.

## Integration

- The Canvas plugin owns the explainer turn-start guidance and the bundled MCP
  server. Disabling it removes both from future work, while stored cards remain.
- Guidance is executor-neutral and only names a tool actually offered this turn.
  Explicit requests for text only abstain. Follow-ups use the existing conversation
  and tool description rather than a broad “make it simpler” intent matcher.
- The bundled tool validates bounded story data and renders a shipped, self-contained
  HTML player. Model text is serialized into inert JSON and rendered as text.
  No model-authored script runs, and no network assets are needed.
- Preview renders the shipped player in an isolated Electron window and returns one
  PNG per scene to the model. Publishing composed scenes requires a ten-minute token
  for the exact previewed HTML. Changed stories must be previewed again. This enforces
  preview generation; the model remains responsible for interpreting the frames.
- Existing Canvas ownership, sandboxed webviews, previews and persistence are reused.
  A per-run reference queue inserts the card at completion, once the reply has stopped
  streaming. The ACP bridge explicitly rebinds that queue per turn.
- The standalone Explainer Studio remains a development harness for the same visual
  vocabulary. The end-user flow is the conversation.

## Validation

Focused tests cover story bounds, escaping, narration timing, every style/mechanism
combination, causal ordering, independent contents, conflict states, exact-preview
matching, plugin disable behavior, tool availability, concurrent ownership and
ACP bridge publication. `tests/e2e/thread-explainer.e2e.ts` drives the real Electron
UI with a scripted model tool call, checks changed animation frames and visible
controls, creates a second style, reloads the session, and saves a screenshot.
`tests/e2e/thread-explainer-scenes.e2e.ts` additionally captures real preview images,
publishes two composed stories, checks final file values, and verifies persistence.

Scripted model calls prove integration. They do not establish how reliably a live
model grounds narration, chooses a style or follows revision requests; that needs
separate live-model evaluation before promoting this experimental feature.
