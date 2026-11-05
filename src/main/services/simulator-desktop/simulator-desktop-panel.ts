import { getSimulatorDesktopService } from './simulator-desktop-service.ts'
import type { SimulatorDesktopPresentation } from '@shared/types/simulator-desktop.ts'
export type SimulatorDesktopPanelPresenter = (
  udid: string,
  options?: SimulatorDesktopPresentation,
) => void

export const SIMULATOR_DESKTOP_SHOW_CHANNEL = 'simulator-desktop:show'

let presenter: SimulatorDesktopPanelPresenter | null = null

/** Wire the main Electron window into agent tools without importing Electron in tool tests. */
export function setSimulatorDesktopPanelPresenter(
  next: SimulatorDesktopPanelPresenter | null,
): void {
  presenter = next
}

export function showSimulatorDesktop(udid: string, options?: SimulatorDesktopPresentation): void {
  if (!presenter) throw new Error('The Copse Desktop panel is not available in this process')
  presenter(udid, options)
}

/** A presentation request alone is not a successful live capture. */
export async function showSimulatorDesktopWithFrame(
  udid: string,
  signal: AbortSignal,
): Promise<void> {
  const failed = new AbortController()
  const ready = getSimulatorDesktopService().waitForFrame(
    udid,
    AbortSignal.any([signal, failed.signal]),
  )
  try {
    showSimulatorDesktop(udid)
  } catch (error) {
    failed.abort(error)
  }
  await ready
}
