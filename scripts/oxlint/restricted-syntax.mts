/**
 * oxlint JS plugin: `copse/restricted-syntax`, a drop-in for ESLint's core `no-restricted-syntax`.
 *
 * oxlint has no native equivalent, and this repo's restrictions (dynamic-key `in`, native
 * `window.confirm`/`alert`, `readFileSync` on the plan-usage path) are esquery selectors. oxlint's
 * JS plugin host dispatches selector-keyed visitors exactly as ESLint does, so each option becomes
 * one visitor and the selectors in `.oxlintrc.json` stay byte-identical to `eslint.config.mjs`.
 */

interface Restriction {
  readonly selector: string
  readonly message: string
}

interface RuleContext {
  readonly options: readonly Restriction[]
  report(descriptor: { node: unknown; message: string }): void
}

const restrictedSyntax = {
  meta: {
    type: 'suggestion',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: { selector: { type: 'string' }, message: { type: 'string' } },
        required: ['selector', 'message'],
        additionalProperties: false,
      },
    },
  },
  create(context: RuleContext): Record<string, (node: unknown) => void> {
    return Object.fromEntries(
      context.options.map(({ selector, message }) => [
        selector,
        (node: unknown): void => {
          context.report({ node, message })
        },
      ]),
    )
  },
}

export default {
  meta: { name: 'copse' },
  rules: { 'restricted-syntax': restrictedSyntax },
}
