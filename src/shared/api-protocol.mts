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
 */
export const API_PROTOCOL_VERSION = 3 as const
