import { z } from 'zod'
import { defineTool } from '@shared/types'
import { deviceHubService } from '../services/apple-development/device-hub.ts'
import { getActiveProjectId } from '../services/workspace.ts'
import {
  isAppleDevelopmentProjectEnrolled,
  isAppleDevelopmentProjectSupported,
} from '../services/apple-development/apple-development-service.ts'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { APPLE_DEVELOPMENT_PLUGIN_ID } from '@copse/agent/plugins/apple-development-plugin.ts'
import { getSetting } from '../services/storage/settings.ts'
import { showSimulatorDesktop } from '../services/simulator-desktop/simulator-desktop-panel.ts'
import { getSimulatorDesktopService } from '../services/simulator-desktop/simulator-desktop-service.ts'

const deviceId = z.string().regex(/^[A-Za-z0-9-]{1,128}$/)
const ratio = z.number().min(0).max(1)
const input = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tap'), x: ratio, y: ratio }),
  z.object({
    type: z.literal('key-tap'),
    usage: z.number().int().min(4).max(231),
    modifiers: z.array(z.number().int().min(224).max(231)).max(4).optional(),
  }),
  z.object({ type: z.literal('button-tap'), name: z.enum(['home', 'lock', 'side', 'siri']) }),
])

export const deviceHubTool = defineTool({
  name: 'device_hub',
  description:
    'Use Apple Device Hub on a local Mac. List physical devices and simulators, open Device Hub, list installed apps, launch an installed bundle ID, or capture a screenshot. Show opens a booted simulator in Copse’s Desktop panel, initially view-only. Input sends a discrete simulator tap (normalized x/y), USB HID key, or hardware button. Physical-device input and live embedding are not supported; use Device Hub for those. Requires an enrolled Apple Development project and tool permission. Build/install apps with the bundled XcodeBuildMCP tools.',
  provenance: 'external',
  parameters: z.discriminatedUnion('action', [
    z.object({ action: z.literal('list') }),
    z.object({ action: z.literal('open') }),
    z.object({ action: z.literal('apps'), device_id: deviceId }),
    z.object({
      action: z.literal('launch'),
      device_id: deviceId,
      bundle_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/),
    }),
    z.object({ action: z.literal('screenshot'), device_id: deviceId }),
    z.object({ action: z.literal('show'), device_id: deviceId }),
    z.object({ action: z.literal('input'), device_id: deviceId, input }),
  ]),
  async execute(args, signal) {
    const projectId = getActiveProjectId()
    if (
      !projectId ||
      !getDefaultPluginRegistry().isEnabled(APPLE_DEVELOPMENT_PLUGIN_ID) ||
      !isAppleDevelopmentProjectEnrolled(projectId) ||
      !isAppleDevelopmentProjectSupported(projectId)
    ) {
      throw new Error(
        'Enable Apple Development and enroll a local macOS project before using Device Hub.',
      )
    }
    if (args.action === 'list') return JSON.stringify(await deviceHubService.list(signal))
    if (args.action === 'open') {
      await deviceHubService.open(signal)
      return 'Opened Device Hub. Select the device in its sidebar.'
    }
    if (args.action === 'apps') return deviceHubService.apps(args.device_id, signal)
    if (args.action === 'launch')
      return deviceHubService.launch(args.device_id, args.bundle_id, signal)
    if (args.action === 'screenshot') {
      const bytes = await deviceHubService.screenshot(args.device_id, signal)
      return {
        result: `Screenshot of device ${args.device_id}.`,
        images: [
          { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, kind: 'screenshot' },
        ],
      }
    }
    const device = await deviceHubService.device(args.device_id, signal)
    if (device.kind !== 'simulator')
      throw new Error(
        'Physical-device input and live embedding are not supported yet. Open Device Hub to control this device, or use screenshot to inspect it.',
      )
    if (device.bootState !== 'booted')
      throw new Error('Boot this simulator with XcodeBuildMCP or Device Hub first.')
    if (args.action === 'show') {
      if (!getSetting<boolean>('vncEnabled', false))
        throw new Error('Enable the Desktop viewer in Settings first.')
      showSimulatorDesktop(device.udid)
      return `Opened ${device.name} in the Desktop panel, view-only.`
    }
    await getSimulatorDesktopService().agentInput(device.udid, args.input, signal)
    return `Sent ${args.input.type} to ${device.name}. Capture a screenshot to verify the result.`
  },
})
