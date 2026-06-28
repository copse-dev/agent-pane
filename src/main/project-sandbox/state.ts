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

export function setProjectSandboxActive(value: boolean): void {
  active = value
}

/** Whether ASRT seatbelt was successfully initialized for this session (macOS only). */
export function isProjectSandboxActive(): boolean {
  return active && process.platform === 'darwin'
}
