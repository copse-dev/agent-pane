import { z } from 'zod'
import { isRecord } from '@copse/std/unknown-value.ts'
import { getIsolatedDesktopLifetime } from '../services/isolated-desktop/desktop-lifetime.ts'
import { defineTool, type ToolDefinition } from '@shared/types'
import { requireThreadExecutionOwner } from '../services/thread-execution-context.ts'
import { getActiveRunModel } from '../services/thread-models.ts'
import {
  APPLE_DESKTOP_KEY_PATTERN,
  appleDesktopRequestSchema,
} from '../../../scripts/lib/apple-desktop-wire.mts'
import {
  startIsolatedDesktop,
  controlIsolatedDesktop,
} from '../services/isolated-desktop/desktop-service.ts'

// What agents see: one object schema. The Anthropic API requires
// `type: "object"` at the top level of a tool's input schema, and Claude Code
// then drops every tool of the MCP server that offered one without it, so the
// union below hid all of Copse's bridged tools from Claude (#4142). `parameters`
// still validates each action's exact fields.
const ISOLATED_DESKTOP_INPUT_SCHEMA = z.toJSONSchema(
  z.object({
    action: z.enum(['start', 'screenshot', 'click', 'type', 'key', 'stop']),
    model: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe('start: the model to approve for the desktop'),
    x: z.number().int().min(0).max(1279).optional().describe('click: x pixel'),
    y: z.number().int().min(0).max(799).optional().describe('click: y pixel'),
    button: z.number().int().min(1).max(3).optional().describe('click: mouse button, default 1'),
    text: z.string().max(2000).optional().describe('type: the text to type'),
    key: z
      .string()
      .max(80)
      .regex(APPLE_DESKTOP_KEY_PATTERN)
      .optional()
      .describe('key: a key such as Return or ctrl+c'),
  }),
)

const startRequestSchema = z
  .object({ action: z.literal('start'), model: z.string().min(1).max(256).optional() })
  .strict()

/** Each action's fields, read from the strict shape that validates it so the two cannot drift. */
const FIELDS_BY_ACTION = new Map<string, ReadonlySet<string>>(
  [startRequestSchema, ...appleDesktopRequestSchema.options].map((shape) => [
    shape.shape.action.value,
    new Set(Object.keys(shape.shape)),
  ]),
)

/** Every field some action takes: the fields the flat schema above offers every action. */
const ACTION_FIELDS = new Set([...FIELDS_BY_ACTION.values()].flatMap((fields) => [...fields]))

/**
 * Drop the fields that only other actions take. The advertised schema offers
 * every field to every action, so `{ action: 'click', x, y, model }` follows
 * it, yet the strict shapes below would reject `model` and make the model
 * retry. The drop is silent: such a field means nothing to this action, and
 * each field's description already names the action that reads it. A key no
 * action takes is kept, so the strict shapes still reject it, and what reaches
 * the guest helper is exactly what `appleDesktopRequestSchema` accepts.
 */
function withoutOtherActionsFields(input: unknown): unknown {
  if (!isRecord(input) || typeof input['action'] !== 'string') return input
  const fields = FIELDS_BY_ACTION.get(input['action'])
  if (!fields) return input
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => fields.has(key) || !ACTION_FIELDS.has(key)),
  )
}

const isolatedDesktopParameters = z.preprocess(
  withoutOtherActionsFields,
  z.union([startRequestSchema, appleDesktopRequestSchema]),
)

/** The isolated desktop service the tool drives. */
export interface IsolatedDesktopService {
  start: typeof startIsolatedDesktop
  control: typeof controlIsolatedDesktop
}

const isolatedDesktopService: IsolatedDesktopService = {
  start: startIsolatedDesktop,
  control: controlIsolatedDesktop,
}

export function createIsolatedDesktopTool(
  desktop: IsolatedDesktopService = isolatedDesktopService,
): ToolDefinition<z.output<typeof isolatedDesktopParameters>> {
  return defineTool({
    name: 'isolated_copse',
    provenance: 'external',
    description:
      'Start and control an isolated Linux Copse desktop in an Apple container VM. ' +
      'Start requires user approval for this thread and its fixed model budget. ' +
      'Subsequent screenshot/click/type/key actions target only this thread’s VM (1280×800). ' +
      'No host files, display, credentials or network are shared. The child can approve its own dialogs. ' +
      'Use stop to revoke the session and delete the VM. Requires local Apple silicon macOS, ' +
      'a running Apple container service, and the copse-desktop:local image built from the branch. ' +
      'Never use launch_gui_app as a fallback for isolation.',
    parameters: isolatedDesktopParameters,
    rawParameters: ISOLATED_DESKTOP_INPUT_SCHEMA,
    async execute(request, signal) {
      const owner = requireThreadExecutionOwner()
      signal.throwIfAborted()
      if (request.action === 'start') {
        const lifetime = getIsolatedDesktopLifetime()
        if (lifetime && !request.model)
          throw new Error(
            'Specify the API or supported ChatGPT model to approve for the isolated desktop',
          )
        const model = request.model ?? getActiveRunModel()
        if (!model) throw new Error('Choose a model for the isolated desktop')
        return desktop.start(owner, model, signal, lifetime ?? signal)
      }
      const png = await desktop.control(owner, request)
      if (!png)
        return request.action === 'stop'
          ? 'Isolated desktop revoked and VM deleted.'
          : 'Guest input completed.'
      return {
        result: 'Isolated Copse desktop (1280×800). The screenshot is attached.',
        images: [
          {
            dataUrl: 'data:image/png;base64,' + png.toString('base64'),
            name: 'isolated-copse.png',
            kind: 'screenshot',
          },
        ],
      }
    },
  })
}

export const isolatedDesktopTool = createIsolatedDesktopTool()
