/** The container worker has no desktop shell for browser-based sign-in. */
export const shell = {
  openExternal: (_url: string): Promise<void> =>
    Promise.reject(new Error('Opening a browser is unavailable in a container worker.')),
}
