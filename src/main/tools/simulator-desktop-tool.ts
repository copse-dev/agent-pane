import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getSetting } from '../services/storage/settings.ts'
import { getSimulatorDesktopService } from '../services/simulator-desktop/simulator-desktop-service.ts'
import { showSimulatorDesktop } from '../services/simulator-desktop/simulator-desktop-panel.ts'
import { APPLE_DEVELOPMENT_TOOL_NAMES } from '@copse/agent/plugins/apple-development-plugin.ts'

export const OPEN_SIMULATOR_DESKTOP_TOOL_NAME = APPLE_DEVELOPMENT_TOOL_NAMES[0]

export const openSimulatorDesktopTool = defineTool({
  name: OPEN_SIMULATOR_DESKTOP_TOOL_NAME,
  description:
    "Open a booted iOS Simulator in Copse's visible Desktop panel. Use this after XcodeBuildMCP boots a Simulator or successfully builds and launches an app there. The panel starts view-only; the user explicitly enables mouse and keyboard control.",
  parameters: z.object({
    udid: z
      .uuid()
      .optional()
      .describe('Booted Simulator UDID. May be omitted when exactly one Simulator is booted.'),
  }),
  async execute({ udid }) {
    if (!getSetting<boolean>('vncEnabled', false)) {
      throw new Error('Enable the Desktop viewer in Settings before opening a Simulator')
    }
    const devices = await getSimulatorDesktopService().listDevices()
    const device = udid ? devices.find((candidate) => candidate.udid === udid) : devices[0]
    if (!device) {
      throw new Error(udid ? 'That Simulator is not booted' : 'No booted Simulator was found')
    }
    if (!udid && devices.length > 1) {
      return (
        'More than one Simulator is booted. Call open_simulator_desktop again with one of these ' +
        `UDIDs:\n${devices.map((candidate) => `${candidate.name}: ${candidate.udid}`).join('\n')}`
      )
    }
    showSimulatorDesktop(device.udid)
    return `Asked the Desktop panel to connect to ${device.name} (${device.runtime}).`
  },
})
