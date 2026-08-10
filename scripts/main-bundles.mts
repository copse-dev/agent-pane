/**
 * Main-process bundles that run as their own OS process.
 *
 * `dist/main/index.js` reaches each of these by *path* — spawned, exec'd, or
 * handed to another program — instead of importing it. Nothing links them into
 * another bundle, so a missing emit is invisible to the build, to typecheck and
 * to every unit test; it only surfaces when the feature runs, as a
 * `MODULE_NOT_FOUND` from a child process the user never sees launched.
 *
 * They live in one list because the two builders drifted: `build.mts` emitted
 * all four, `dev.mts` emitted none of them (`sandbox-fs-worker.js` had no build
 * context at all, and `pack-tool-worker.js` had one that was never rebuilt or
 * watched). A `dist/` filled only by `npm run dev` — a fresh worktree, a clean
 * clone — therefore shipped a main process whose sandboxed `fs:*` calls could
 * not work: every file-tree listing and file preview failed, and each attempt
 * re-spawned two doomed Electron processes (the persistent worker plus its
 * one-shot fallback). Adding an entry point to only one of the builders is the
 * bug; this list makes that impossible.
 */
export interface StandaloneMainBundle {
  /** Repo-relative entry point. */
  entry: string
  /** Repo-relative output, next to `dist/main/index.js` where the runtime looks. */
  outfile: string
}

export const STANDALONE_MAIN_BUNDLES: StandaloneMainBundle[] = [
  // Seatbelt/bubblewrap-wrapped filesystem worker behind every sandboxed `fs:*`
  // IPC — both the long-lived server and the one-shot fallback exec this path.
  {
    entry: 'src/main/project-sandbox/sandbox-fs-worker.ts',
    outfile: 'dist/main/sandbox-fs-worker.js',
  },
  {
    entry: 'src/main/services/packs/pack-tool-worker.ts',
    outfile: 'dist/main/pack-tool-worker.js',
  },
  // Runs the ACP model/mode probe under its OWN SandboxManager so a background
  // probe cannot widen the app's process-global network allowlist (see
  // docs/plans/sandbox-network-scope-isolation.md). Must bundle free of electron
  // and node-pty, which a parse check alone would not catch — the natives fail
  // at require time, not parse time.
  {
    entry: 'src/main/services/acp/acp-probe-worker.ts',
    outfile: 'dist/main/acp-probe-worker.js',
  },
  // Owns ASRT for one long-lived sandboxed ACP session and relays the agent's
  // stdio, keeping its network allowlist out of the Electron main process.
  {
    entry: 'src/main/services/acp/acp-session-host-worker.ts',
    outfile: 'dist/main/acp-session-host-worker.js',
  },
  // No esbuild `banner` for this one: askpass-helper.ts already starts with
  // `#!/usr/bin/env node` and esbuild preserves a source hashbang verbatim.
  // Adding the banner too put a second `#!…` on line 2 of the bundle, where it
  // is not a hashbang but a syntax error — every SSH password/passphrase/host-key
  // prompt died in the helper, so OpenSSH silently skipped the prompt and burned
  // through auth attempts instead.
  {
    entry: 'src/main/services/ssh-workspace/askpass-helper.ts',
    outfile: 'dist/main/ssh-askpass-helper.js',
  },
]
