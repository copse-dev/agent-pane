/**
 * The renderer ↔ main API protocol version (issue #2312, step 1).
 *
 * The renderer only ever talks to the main process through `ApiClient`
 * (`src/preload/api.d.ts`); the preload binds each method to an IPC channel and
 * the sidecar's WebSocket bridge carries the same channels over a socket. That
 * surface is frozen as a generated protocol: a committed channel manifest
 * (`schemas/api-protocol.manifest.json`, `pnpm run gen:api-protocol`) and the
 * full JSON Schema the build emits; this is the version stamped into both.
 *
 * Bump it only for a backward-incompatible change to the surface: a channel or
 * method removed or renamed, an argument added in a non-trailing position or
 * made required, a result shape narrowed. Purely additive changes (a new
 * channel, a new optional trailing argument, a new optional result field) keep
 * the version and only regenerate the schema. `scripts/gen-api-protocol.mts
 * --compare-ref <git-ref>` classifies a diff against a committed schema.
 *
 * A transport that connects a client and server built separately — today the
 * sidecar WebSocket bridge, later a daemon — exchanges this number in its
 * handshake and refuses a peer that speaks a different one rather than letting
 * mismatched shapes reach the handler table.
 *
 * v3 is a conservative bump, not an accurate one. `lm-studio:model-info` gained
 * an optional `embedding` field on each row (#2487) — additive by the paragraph
 * above — but `compareApiProtocol` compares whole resolved shapes and has no way
 * to say "only optional result fields were added", so it classified it breaking
 * and the gate demanded a bump. Teaching the differ that distinction is worth
 * doing on its own; until then a bump is the safe side of the disagreement,
 * since it can only refuse peers that would otherwise have been allowed.
 */
// v4 adds bounded PR activity results. The whole-shape compatibility gate
// conservatively requires a bump for the optional activity payload.
export const API_PROTOCOL_VERSION = 4 as const
