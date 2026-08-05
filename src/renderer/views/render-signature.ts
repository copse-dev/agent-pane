/**
 * Compact digests of "everything this card renders", used by the transcript to
 * skip a rebuild when nothing changed (#728).
 *
 * The obvious spelling — keep `JSON.stringify(item)` itself as the signature —
 * costs a second full copy of every tool result for as long as the card stays in
 * the DOM. A heap snapshot of a long session showed exactly that: 83% of a
 * 319 MB renderer heap held by strings, with base64 image attachments and
 * 200 kB command outputs each appearing two and three times over — once on the
 * thread in the store, again in the signature caches. Digesting collapses every
 * signature to a couple of dozen bytes, so only the store's copy survives.
 *
 * The digest is two independently seeded 32-bit FNV-1a lanes plus the input
 * length. Not cryptographic, and it does not need to be: nothing trusts a
 * signature across a process boundary, and the only cost of a collision is one
 * card skipping a re-render it should have done — far rarer, at 64 bits with an
 * exact length alongside, than the dropped frames the cache exists to prevent.
 */

const FNV_PRIME = 0x01000193
const FNV_OFFSET = 0x811c9dc5
const MIX_PRIME = 0x85ebca6b
const MIX_OFFSET = 0xc2b2ae35

/** 64-bit-ish digest of `text`, as `<lane>:<lane>:<length>` in base 36. */
export function digestString(text: string): string {
  let a = FNV_OFFSET
  let b = MIX_OFFSET
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, FNV_PRIME)
    b = Math.imul(b ^ code, MIX_PRIME)
    // Rotate the second lane so it does not track the first through runs of
    // repeated characters (long base64 payloads are full of them).
    b = (b << 13) | (b >>> 19)
  }
  return `${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}:${text.length.toString(36)}`
}

/**
 * Digest of a render input's JSON encoding. Takes an `object` — every call site
 * signs a display item, a tool-call array or a chrome record — which is also
 * what keeps `JSON.stringify` honest here: it is the bare `undefined`, function
 * and symbol inputs that it drops rather than encoding.
 */
export function renderSignature(value: object): string {
  return digestString(JSON.stringify(value))
}
