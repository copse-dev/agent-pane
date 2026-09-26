const EXACT_UNSAFE_SWITCHES = new Set(['js-flags', 'debug', 'debug-brk', 'debug-port'])
const UNSAFE_SWITCH_PREFIXES = ['remote-debugging-', 'inspect']

/**
 * Chromium accepts a switch with either `--` or a single `-` prefix
 * (`-remote-debugging-port=9222` works), so the switch name is compared after
 * stripping every leading dash and any `=value`.
 */
function switchName(argument: string): string | null {
  if (!argument.startsWith('-')) return null
  const name = argument.replace(/^-+/, '').split('=', 1)[0]?.toLowerCase() ?? ''
  return name.length > 0 ? name : null
}

/** Debugger endpoints must not expose a silently authorized packaged process. */
export function hasUnsafeVaultLaunchArguments(argv: readonly string[]): boolean {
  return argv.some((argument) => {
    const name = switchName(argument)
    if (name === null) return false
    return (
      EXACT_UNSAFE_SWITCHES.has(name) ||
      UNSAFE_SWITCH_PREFIXES.some((prefix) => name.startsWith(prefix))
    )
  })
}
