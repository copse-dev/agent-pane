/** Debugger endpoints must not expose a silently authorized packaged process. */
export function hasUnsafeVaultLaunchArguments(argv: readonly string[]): boolean {
  return argv.some((argument) => {
    const option = argument.split('=', 1)[0]?.toLowerCase() ?? ''
    return (
      option.startsWith('--remote-debugging-') ||
      option.startsWith('--inspect') ||
      option === '--js-flags'
    )
  })
}
