// The `copse.pii-redaction` first-party pack.
//
// Bundles the experimental client-side PII redaction feature behind a single
// lifecycle flag. The pack declares the `reveal_pii` native tool (registered
// host-side in `registry-bootstrap.ts`) and the redaction steering prompt
// block; the runtime call sites read
// `packRegistry.isEnabled('copse.pii-redaction')` to decide whether to (a)
// register the reveal tool for the model tool list, (b) append the steering
// block to the system prompt, and (c) rewrite the user's input into stable
// placeholders before it leaves the device (`pii-redactor.ts`). A Settings >
// Packs disable drops all three in one atomic flag flip (decision 15).
//
// **No-double-registration.** Historically the `reveal_pii` tool was registered,
// the prompt block appended, and the input rewritten when the top-level
// `piiRedactionEnabled` boolean was on. That standalone setting is gone
// (`PII_REDACTION_ENABLED_SETTING` deleted, the `piiRedactionEnabled` checkbox
// removed from `settings-dialog.ts`) — the pack toggle is the master switch.
// Gating on both the pack and the deleted setting would have double-consulted
// the enable state; the deletions happen in the same change to keep a single
// source of truth (`isEnabled(PII_REDACTION_PACK_ID)`).
//
// Electron-free (execution-guidance rule 4): pure declarations. The prompt block
// TEXT lives here so the pack is the single source of truth — the host
// (`agent-prompt.ts`) re-exports {@link PII_REDACTION_BLOCK} from this module.
// Host wiring (tool registration + input rewrite + live sync) reads the pack
// registry via the shared `getDefaultPackRegistry()` seam.
import { definePack, type PackPromptBlock, type RegisteredPack } from './pack-manifest.ts'

/** Stable pack id — the manifest name + the grouping key across contributions. */
export const PII_REDACTION_PACK_ID = 'copse.pii-redaction'

/** The native tool name the pack contributes while enabled. */
export const PII_REDACTION_TOOL_NAME = 'reveal_pii'

/**
 * The redaction steering block appended to the system prompt while the pack is
 * enabled (host re-exports this as `PII_REDACTION_BLOCK` from `agent-prompt.ts`,
 * and `agent-system-prompt.ts` appends it iff the pack is enabled). Defined here
 * so the pack's `promptBlocks` declaration and the host's appended text are the
 * same string — a single source of truth.
 */
export const PII_REDACTION_BLOCK = `

This conversation has client-side PII redaction on. Personal data the user typed is replaced with stable placeholders before their message reaches you — typed tokens like [GIVEN_NAME_1], [EMAIL_2], [SSN_1], [PHONE_1]. The same real value always maps to the same placeholder, so you can reason about a placeholder as if it were the value. Keep placeholders intact in your replies and edits; do not invent or guess the underlying values.
- reveal_pii: When you genuinely need a real value — e.g. to write it verbatim into a file or command — call reveal_pii with the placeholder. The user is prompted to approve each reveal and may decline, in which case keep using the placeholder.`

/** The manifest's steering prompt block (framed as trusted first-party text). */
const PII_REDACTION_PROMPT_BLOCK: PackPromptBlock = {
  id: 'pii-redaction-block',
  text: PII_REDACTION_BLOCK,
  trust: 'trusted',
}

/**
 * The `copse.pii-redaction` pack: manifest declares the native tool
 * (`tools.native`), the redaction steering block, and pack-scoped storage;
 * runtime contributions carry the same tool name + prompt block so
 * `activeToolNames()` reports the tool while enabled (the atomicity contract
 * test in `pack-registry.test.ts` asserts that `disable()` clears the active
 * tool list in one flag flip).
 */
export const piiRedactionPack: RegisteredPack = definePack(
  {
    name: PII_REDACTION_PACK_ID,
    description:
      'PII redaction — replaces personal data you type (names, emails, phone numbers, SSNs, card numbers) with stable placeholders on-device before your message reaches any model provider; the agent calls the `reveal_pii` tool, gated by your approval, when it genuinely needs a real value.',
    trust: 'first-party',
    defaultEnabled: false,
    tools: { native: [PII_REDACTION_TOOL_NAME] },
    prompt: [PII_REDACTION_PROMPT_BLOCK],
    storage: { namespace: PII_REDACTION_PACK_ID },
  },
  {
    toolNames: [PII_REDACTION_TOOL_NAME],
    promptBlocks: [PII_REDACTION_PROMPT_BLOCK],
  },
)
