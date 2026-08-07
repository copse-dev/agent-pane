// The one parser for a Copse model selection.
//
// The model picker stores a single string that has to carry, variously: a bare
// cloud model id, a routing slug plus an upstream id, or an agent identity plus
// the model chosen inside that agent. Before this module each consumer
// re-derived the split — `startsWith('lmstudio:')` here, an `indexOf(':')`
// there, a slug regex in extra-providers.ts, a first-`#` split in acp.ts and
// again in remote-agent.ts — so a new namespace had to be taught to every site
// and a missed one failed silently (an `openrouter:anthropic/claude-opus-5`
// that no longer looked like the Opus 5 it is).
//
// `parseModelSelection` classifies the namespace and splits the parts; the
// namespace owners keep their own validity rules on top (which providers are
// real remote agents, which slugs are configured extra providers, how a plugin
// decodes its halves). Parsing here, policy there.
//
// Leaf module by design: it imports only the prefix literals, so both
// `model-catalog.ts` and `extra-providers.ts` can depend on it without the
// cycle that importing one from the other would create.

import { OPENROUTER_MODEL_PREFIX } from './openrouter.ts'
import {
  ACP_MODEL_PREFIX,
  AGENT_MODEL_SEP,
  AUTO_MODEL_PREFIX,
  LMSTUDIO_MODEL_PREFIX,
  PLUGIN_MODEL_PREFIX,
  REMOTE_AGENT_MODEL_PREFIX,
} from './reserved-prefixes.ts'

/**
 * Which routing layer a selection names.
 *
 * `cloud` is the unprefixed case — a first-party model id sent straight to
 * Anthropic or OpenAI. `extra-provider` is any `<slug>:` that is not one of the
 * reserved namespaces; whether that slug is actually configured is the
 * extra-provider store's question, not this parser's.
 *
 * `auto` is the odd one out: it names no route at all but a *rule* for choosing
 * one (`dynamic-model.ts`), which the host resolves into one of the others
 * before anything is sent. It is classified here because `auto:` is shaped
 * exactly like a provider slug, and without this it would be routed to a
 * provider named "auto".
 */
export type ModelNamespace =
  | 'cloud'
  | 'openrouter'
  | 'lmstudio'
  | 'extra-provider'
  | 'remote-agent'
  | 'acp'
  | 'plugin-model'
  | 'auto'

export interface ModelSelection {
  namespace: ModelNamespace
  /** Namespace token without its trailing colon; `''` for a bare cloud id. */
  slug: string
  /**
   * Agent, provider, or plugin identity for the agent-shaped namespaces (`acp`,
   * `remote-agent`, `plugin-model`); `''` for the rest. Raw as stored —
   * `plugin-model` URI-encodes its halves and decodes them in its own parser.
   */
  agent: string
  /**
   * Everything after the namespace and, where there is one, the agent identity.
   * `''` when a selection names an agent but no model within it.
   */
  id: string
  /**
   * `id` reduced to the model id alone, for matching against a catalog.
   *
   * Aggregators address models as `<vendor>/<model>` (`anthropic/claude-opus-5`),
   * so that leading segment is dropped for the namespaces that do it. Elsewhere
   * — notably `lmstudio`, where `org/repo` *is* the id — this equals `id`.
   */
  modelId: string
}

/** Namespaces whose ids are `<vendor>/<model>`, so the vendor is not part of the id. */
const VENDOR_ADDRESSED: ReadonlySet<ModelNamespace> = new Set(['openrouter', 'extra-provider'])

/** Namespaces that name an agent identity first, then optionally a model within it. */
const AGENT_SHAPED: ReadonlyArray<readonly [ModelNamespace, string, string]> = [
  ['remote-agent', REMOTE_AGENT_MODEL_PREFIX, AGENT_MODEL_SEP],
  ['acp', ACP_MODEL_PREFIX, AGENT_MODEL_SEP],
  // A plugin route separates its two halves with `:` rather than `#`; both are
  // URI-encoded, so an encoded separator cannot be mistaken for the real one.
  ['plugin-model', PLUGIN_MODEL_PREFIX, ':'],
]

/** Namespaces that are a plain routing slug in front of an upstream model id. */
const SLUG_SHAPED: ReadonlyArray<readonly [ModelNamespace, string]> = [
  ['openrouter', OPENROUTER_MODEL_PREFIX],
  ['lmstudio', LMSTUDIO_MODEL_PREFIX],
  // `id` here is the rule body (`best-value`, `min-intellect:45`), not a model.
  ['auto', AUTO_MODEL_PREFIX],
]

/** An extra provider's slug. */
const SLUG_RE = /^[a-z0-9-]+$/

/**
 * Whether `value` is a well-formed provider slug.
 *
 * Exported so the store that accepts a user-added provider validates against
 * the same grammar this parser classifies by — a slug the store admits but the
 * parser would not recognise yields a provider that can never be selected.
 */
export function isProviderSlug(value: string): boolean {
  return SLUG_RE.test(value)
}

function vendorless(namespace: ModelNamespace, id: string): string {
  if (!VENDOR_ADDRESSED.has(namespace)) return id
  const vendor = id.indexOf('/')
  return vendor === -1 ? id : id.slice(vendor + 1)
}

function selection(
  namespace: ModelNamespace,
  slug: string,
  agent: string,
  id: string,
): ModelSelection {
  return { namespace, slug, agent, id, modelId: vendorless(namespace, id) }
}

/**
 * Split a stored model selection into its namespace and parts.
 *
 * Total — every string classifies, an unrecognised one as `cloud`. Callers that
 * need to know a selection is *valid* (a real remote-agent provider, a
 * configured extra provider, a non-empty agent id) check that themselves; this
 * only says what shape it has.
 */
export function parseModelSelection(model: string): ModelSelection {
  for (const [namespace, prefix, separator] of AGENT_SHAPED) {
    if (!model.startsWith(prefix)) continue
    const rest = model.slice(prefix.length)
    const sep = rest.indexOf(separator)
    const agent = sep === -1 ? rest : rest.slice(0, sep)
    return selection(namespace, prefix.slice(0, -1), agent, sep === -1 ? '' : rest.slice(sep + 1))
  }

  for (const [namespace, prefix] of SLUG_SHAPED) {
    if (model.startsWith(prefix)) {
      return selection(namespace, prefix.slice(0, -1), '', model.slice(prefix.length))
    }
  }

  // Anything else carrying a well-formed slug is an extra provider. A bare
  // cloud id has no colon, and a malformed one (uppercase, punctuation) is left
  // as `cloud` rather than invented into a provider that cannot exist.
  const colon = model.indexOf(':')
  if (colon > 0) {
    const slug = model.slice(0, colon)
    if (SLUG_RE.test(slug)) {
      return selection('extra-provider', slug, '', model.slice(colon + 1))
    }
  }

  return selection('cloud', '', '', model)
}
