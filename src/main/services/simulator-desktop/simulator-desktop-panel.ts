export type SimulatorDesktopPanelPresenter = (udid: string) => void

export const SIMULATOR_DESKTOP_SHOW_CHANNEL = 'simulator-desktop:show'

let presenter: SimulatorDesktopPanelPresenter | null = null

/** Wire the main Electron window into agent tools without importing Electron in tool tests. */
export function setSimulatorDesktopPanelPresenter(
  next: SimulatorDesktopPanelPresenter | null,
): void {
  presenter = next
}

export function showSimulatorDesktop(udid: string): void {
  if (!presenter) throw new Error('The Copse Desktop panel is not available in this process')
  presenter(udid)
}
