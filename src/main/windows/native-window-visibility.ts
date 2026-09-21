interface ChromiumSwitchReader {
  hasSwitch(name: string): boolean
}

/** Chromium headless mode owns no native desktop surface, so showing a window ends the session. */
export function shouldShowNativeWindows(commandLine: ChromiumSwitchReader): boolean {
  return !commandLine.hasSwitch('headless')
}
