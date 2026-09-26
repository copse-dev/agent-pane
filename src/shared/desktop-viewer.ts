/**
 * The Desktop pane that shows a Simulator or emulator is gated by the
 * experimental `vncEnabled` setting. Every surface that can hit that gate
 * (the pane itself, its IPC, and the agent's Simulator tool) names the same
 * place to turn it on, so the user is never left guessing why nothing appeared.
 */
export const DESKTOP_VIEWER_SETTING_LOCATION = 'Settings → Experimental → Remote desktop viewer'

export const DESKTOP_VIEWER_OFF_TITLE = 'Desktop viewer is off'

export const DESKTOP_VIEWER_OFF_DETAIL = `Turn on ${DESKTOP_VIEWER_SETTING_LOCATION} to watch the Simulator here.`
