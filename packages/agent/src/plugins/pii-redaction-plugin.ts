// The `copse.pii-redaction` first-party plugin.
//
// Bundles the experimental client-side PII redaction feature behind a single
// lifecycle flag. The plugin declares the `reveal_pii` native tool (registered
// host-side in `registry-bootstrap.ts`) and the redaction steering prompt
// block; the runtime call sites read
// `pluginRegistry.isEnabled('copse.pii-redaction')` to decide whether to (a)
// register the reveal tool for the model tool list, (b) append the steering
// block to the system prompt, and (c) rewrite the user's input into stable
// placeholders before it leaves the device (`pii-redactor.ts`). A Settings >
// Plugins disable drops all three in one atomic flag flip (decision 15).
//
// **No-double-registration.** Historically the `reveal_pii` tool was registered,
// the prompt block appended, and the input rewritten when the top-level
// `piiRedactionEnabled` boolean was on. That standalone setting is gone
// (`PII_REDACTION_ENABLED_SETTING` deleted, the `piiRedactionEnabled` checkbox
// removed from `settings-dialog.ts`) — the plugin toggle is the master switch.
// Gating on both the plugin and the deleted setting would have double-consulted
// the enable state; the deletions happen in the same change to keep a single
// source of truth (`isEnabled(PII_REDACTION_PLUGIN_ID)`).
//
// Electron-free (execution-guidance rule 4): pure declarations. The prompt block
// TEXT lives here so the plugin is the single source of truth — the host
// (`agent-prompt.ts`) re-exports {@link PII_REDACTION_BLOCK} from this module.
// Host wiring (tool registration + input rewrite + live sync) reads the plugin
// registry via the shared `getDefaultPluginRegistry()` seam.
import { definePlugin, type PluginPromptBlock, type RegisteredPlugin } from './plugin-manifest.ts'

/** Stable plugin id — the manifest name + the grouping key across contributions. */
export const PII_REDACTION_PLUGIN_ID = 'copse.pii-redaction'

/** The native tool name the plugin contributes while enabled. */
export const PII_REDACTION_TOOL_NAME = 'reveal_pii'

/**
 * The redaction steering block appended to the system prompt while the plugin is
 * enabled (host re-exports this as `PII_REDACTION_BLOCK` from `agent-prompt.ts`,
 * and `agent-system-prompt.ts` appends it iff the plugin is enabled). Defined here
 * so the plugin's `promptBlocks` declaration and the host's appended text are the
 * same string — a single source of truth.
 */
export const PII_REDACTION_BLOCK = `

This conversation has client-side PII redaction on. Some personal data the user typed — such as email addresses, SSNs and card numbers — is replaced with placeholders before their message reaches you, as typed tokens like [EMAIL_QJXKT_1] or [SSN_QJXKT_1] (the letters are a per-session tag). Within a session the same real value always maps to the same placeholder, so you can reason about a placeholder as if it were the value. URLs, hostnames and IP addresses are left as typed. Keep placeholders intact in your replies and edits; do not invent or guess the underlying values.
- reveal_pii: When you genuinely need a real value — e.g. to write it verbatim into a file or command — call reveal_pii with the placeholder. The user is prompted to approve each reveal and may decline, in which case keep using the placeholder. Placeholders from an earlier app session cannot be revealed.`

/** The manifest's steering prompt block (framed as trusted first-party text). */
const PII_REDACTION_PROMPT_BLOCK: PluginPromptBlock = {
  id: 'pii-redaction-block',
  text: PII_REDACTION_BLOCK,
  trust: 'trusted',
}

/**
 * The `copse.pii-redaction` plugin: manifest declares the native tool
 * (`tools.native`), the redaction steering block, and plugin-scoped storage;
 * runtime contributions carry the same tool name + prompt block so
 * `activeToolNames()` reports the tool while enabled (the atomicity contract
 * test in `plugin-registry.test.ts` asserts that `disable()` clears the active
 * tool list in one flag flip).
 */
export const piiRedactionPlugin: RegisteredPlugin = definePlugin(
  {
    name: PII_REDACTION_PLUGIN_ID,
    description:
      'PII redaction — replaces email addresses, SSNs and card numbers you type with placeholders on-device before your message reaches any model provider; names, phone numbers and street addresses are only caught when the optional contextual model is installed, which Copse releases do not include. URLs and IP addresses are left as typed. The agent calls the `reveal_pii` tool, gated by your approval, when it genuinely needs a real value.',
    trust: 'first-party',
    stability: 'experimental',
    tools: { native: [PII_REDACTION_TOOL_NAME] },
    prompt: [PII_REDACTION_PROMPT_BLOCK],
    storage: { namespace: PII_REDACTION_PLUGIN_ID },
  },
  {
    toolNames: [PII_REDACTION_TOOL_NAME],
    promptBlocks: [PII_REDACTION_PROMPT_BLOCK],
  },
)
