/**
 * Canonical ~4 chars/token heuristic.
 *
 * The app does not run a real tokenizer; every locally-estimated token count
 * (context preview, history trimming, footer output fallback, stream stats,
 * ACP/headless usage) derives from this ratio. It is approximate by design —
 * "good enough for budget trimming" — and is applied on top of the flat
 * per-image estimate below. Keep this the single source of truth so the
 * estimators cannot drift from one another.
 */
export const CHARS_PER_TOKEN = 4

/** Flat estimate per image block (avoids counting base64 at ~4 chars/token). */
export const ESTIMATED_IMAGE_TOKENS = 1600
