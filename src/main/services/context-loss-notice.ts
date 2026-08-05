/**
 * Telling the user when a turn starts with no model context but a transcript
 * full of it.
 *
 * `agent-history.json` is committed once, when a run finishes. A run that never
 * finishes contributes nothing, so the next turn loads an empty sidecar and
 * starts from zero — while the transcript on screen still shows every message
 * the user sent. Nothing announced that. The turn simply answered as though the
 * conversation had just begun, and the only trace was buried in the model's own
 * reasoning ("this is ambiguous without prior context").
 *
 * Detecting it is cheap: an empty provider history alongside a non-empty
 * transcript cannot be a fresh thread. Saying so costs one line and turns a
 * confusing answer into an explained one.
 */

/**
 * Whether this turn is starting without history it should have had.
 *
 * `transcriptMessages` counts what the user can see *before* this turn's own
 * prompt is appended, so a fresh thread's first turn — one visible message, no
 * history yet — is not a loss.
 */
export function contextWasLost(historyLength: number, transcriptMessages: number): boolean {
  return historyLength === 0 && transcriptMessages > 1
}

/**
 * The note shown when {@link contextWasLost} holds. Names the concrete symptom
 * rather than the mechanism: the user's question is "why did it forget?", and
 * the answer is that the previous run did not get to save.
 */
export function contextLossNotice(transcriptMessages: number): string {
  return (
    `_**Earlier context is missing from this turn.** The transcript above has ` +
    `${String(transcriptMessages)} messages, but this thread's saved model history was empty ` +
    `when the turn started — an earlier run ended before it could save. This turn is running ` +
    `without that history._\n\n`
  )
}
