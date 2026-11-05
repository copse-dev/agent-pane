import { join } from 'node:path'

/**
 * Route both ordinary temp files and zsh's heredoc files into the allowed scratch directory.
 *
 * This only covers the environment Copse hands to `spawn`. ASRT additionally
 * bakes its own `TMPDIR=…` into the wrapped command (`env TMPDIR=… sandbox-exec
 * …`), and that assignment runs inside the spawned process, so it wins over the
 * `TMPDIR` set here. See {@link pinSandboxWrapTmpDir} for the other half.
 */
export function withSandboxTmpEnv(env: NodeJS.ProcessEnv, tmpDir: string): NodeJS.ProcessEnv {
  // zsh uses TMPPREFIX (default /tmp/zsh), not TMPDIR, when a heredoc needs a
  // file. Redirecting TMPDIR alone therefore breaks large patches under the
  // workspace sandbox. TMPPREFIX is a filename prefix, not a directory.
  return {
    ...env,
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    TMPPREFIX: join(tmpDir, 'zsh'),
    CLAUDE_CODE_TMPDIR: tmpDir,
  }
}

/**
 * Make ASRT's own `TMPDIR` agree with {@link withSandboxTmpEnv} (#4149).
 *
 * `SandboxManager.wrapWithSandboxArgv` reads
 * `process.env.CLAUDE_CODE_TMPDIR || process.env.CLAUDE_TMPDIR || '/tmp/claude'`
 * in the *wrapping* process and bakes the result into the wrapped command as
 * `env TMPDIR=<that>`. That runs inside the child, after Copse's spawn env has
 * been applied, so without this the agent's shell saw `TMPDIR=/tmp/claude` while
 * `TMP`, `TEMP` and `CLAUDE_CODE_TMPDIR` named the workspace scratch directory.
 * Claude Code itself is not the culprit: it only inherits what ASRT wrote.
 *
 * Call once in every process that initialises `SandboxManager` (the main
 * process and each ACP worker), before the first wrap. It changes only that
 * process's own `process.env`. The caller's environment object is untouched.
 */
export function pinSandboxWrapTmpDir(tmpDir: string): void {
  process.env['CLAUDE_CODE_TMPDIR'] = tmpDir
  // ASRT only consults the legacy name when the current one is empty, but a
  // stale value would still be misleading to anything reading this process.
  delete process.env['CLAUDE_TMPDIR']
}
