// The `copse.artifact-checkpoint` first-party plugin.
//
// A delayed artifact checkpoint targets the benchmark failure mode where an
// agent spends most of a long task exploring and only attempts the deliverable
// at the deadline. It contributes one step-boundary hook and one scoped delay
// setting. The experimental stability declaration makes it default-off on fresh
// profiles; disabling it atomically removes the hook from new runs.
import { definePlugin, type RegisteredPlugin } from './plugin-manifest.ts'
import {
  ARTIFACT_CHECKPOINT_DELAY_MINUTES_SETTING,
  ARTIFACT_CHECKPOINT_PLUGIN_ID,
  DEFAULT_ARTIFACT_CHECKPOINT_DELAY_MINUTES,
  artifactCheckpointHook,
} from '../artifact-checkpoint.ts'

export { ARTIFACT_CHECKPOINT_PLUGIN_ID }

export const artifactCheckpointPlugin: RegisteredPlugin = definePlugin(
  {
    name: ARTIFACT_CHECKPOINT_PLUGIN_ID,
    description:
      'Artifact checkpoint — once a longer-running agent task crosses the configured delay, ask it to preserve the best runnable artifact before further exploration and use the remaining time for focused validation.',
    trust: 'first-party',
    stability: 'experimental',
    settings: {
      [ARTIFACT_CHECKPOINT_DELAY_MINUTES_SETTING]: {
        kind: 'number',
        title: 'Checkpoint after this many minutes',
        description:
          'Wall-clock time from the start of one agent run. The checkpoint fires at most once per run and does not create an extra continuation turn.',
        default: DEFAULT_ARTIFACT_CHECKPOINT_DELAY_MINUTES,
      },
    },
    storage: { namespace: ARTIFACT_CHECKPOINT_PLUGIN_ID },
  },
  { blockingHooks: [artifactCheckpointHook] },
)
