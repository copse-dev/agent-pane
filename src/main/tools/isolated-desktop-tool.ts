import { z } from 'zod'
import { getIsolatedDesktopLifetime } from '../services/isolated-desktop/desktop-lifetime.ts'
import { defineTool } from '@shared/types'
import { requireThreadExecutionOwner } from '../services/thread-execution-context.ts'
import { getActiveRunModel } from '../services/thread-models.ts'
import { appleDesktopRequestSchema } from '../../../scripts/lib/apple-desktop-wire.mts'
import {
  startIsolatedDesktop,
  controlIsolatedDesktop,
} from '../services/isolated-desktop/desktop-service.ts'

export const isolatedDesktopTool = defineTool({
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
  parameters: z.union([
    z.object({ action: z.literal('start'), model: z.string().min(1).max(256).optional() }).strict(),
    appleDesktopRequestSchema,
  ]),
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
      return startIsolatedDesktop(owner, model, signal, lifetime ?? signal)
    }
    const png = await controlIsolatedDesktop(owner, request)
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
