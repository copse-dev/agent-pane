import { join } from 'node:path'

/** Route both ordinary temp files and zsh's heredoc files into the allowed scratch directory. */
export function withSandboxTmpEnv(env: NodeJS.ProcessEnv, tmpDir: string): NodeJS.ProcessEnv {
  // zsh uses TMPPREFIX (default /tmp/zsh), not TMPDIR, when a heredoc needs a
  // file. Redirecting TMPDIR alone therefore breaks large patches under the
  // workspace sandbox. TMPPREFIX is a filename prefix, not a directory.
  // Claude Code ignores the inherited TMPDIR for its own shell and uses
  // /tmp/claude; CLAUDE_CODE_TMPDIR is its supported override.
  return {
    ...env,
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    TMPPREFIX: join(tmpDir, 'zsh'),
    CLAUDE_CODE_TMPDIR: tmpDir,
  }
}
