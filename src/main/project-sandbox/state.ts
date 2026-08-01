/**
 * Native-free holder for the project-sandbox "active" flag.
 *
 * The real sandbox machinery ({@link ../project-sandbox/spawn.ts}) imports
 * `node-pty` and `@anthropic-ai/sandbox-runtime` — heavy native modules. Modules
 * that only need to *know* whether the sandbox is active (e.g. the system-prompt
 * builder) read it from here so they don't transitively pull those natives in.
 *
 * The flag is set by {@link initProjectSandbox} once ASRT seatbelt initialization
 * succeeds, and cleared on shutdown or init failure.
 */
let active = false

/**
 * Platforms we start ASRT on: `sandbox-exec` (seatbelt) on macOS, `bubblewrap`
 * on Linux. Both are first-class ASRT backends.
 *
 * Windows is deliberately absent. ASRT supports it, but only by running the
 * sandboxee under a dedicated `srt-sandbox` local account behind a Windows
 * Filtering Platform egress fence — host provisioning we do not do, so claiming
 * the platform here would enable a boundary that was never set up.
 */
const SANDBOX_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'linux']

/**
 * Whether this OS has an ASRT backend we enable. Separate from
 * {@link isProjectSandboxActive} so the init path can gate on the platform
 * *before* it has anything to report about the session.
 */
export function isProjectSandboxPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return SANDBOX_PLATFORMS.includes(platform)
}

export function setProjectSandboxActive(value: boolean): void {
  active = value
}

/** Whether ASRT was successfully initialized for this session. */
export function isProjectSandboxActive(): boolean {
  return active && isProjectSandboxPlatform()
}
