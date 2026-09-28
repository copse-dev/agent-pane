import { definePlugin, type RegisteredPlugin } from './plugin-manifest.ts'

export const REVIEWER_INPUT_PLUGIN_ID = 'copse.reviewer-input'
export const REVIEWER_INPUT_TOOL_NAME = 'request_review_input'

/** Opt-in agent requests for decisions that need human feedback without stopping other work. */
export const reviewerInputPlugin: RegisteredPlugin = definePlugin(
  {
    name: REVIEWER_INPUT_PLUGIN_ID,
    description:
      'Lets agents save review decisions for you in a task, continue independent work, and receive your answer as a later message.',
    trust: 'first-party',
    stability: 'experimental',
    tools: {
      native: [REVIEWER_INPUT_TOOL_NAME],
      acpTools: [REVIEWER_INPUT_TOOL_NAME],
    },
  },
  { toolNames: [REVIEWER_INPUT_TOOL_NAME] },
)
