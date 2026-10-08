import { setupHostedArchive } from './openai-archive-worker.ts'
import { runHostedGitTransfer } from './openai-git-worker.ts'
const [mode, base, ref, parts] = process.argv.slice(2)
if (mode === 'archive') {
  runHostedGitTransfer('/workspace', 'assemble', base, ref, Number(parts))
  void setupHostedArchive('/workspace', base ?? '').catch(() => {
    console.error(
      'Repository archive setup failed. Retry with a fresh archive URL; verify the pinned tree and local overlay.',
    )
    process.exitCode = 1
  })
} else
  runHostedGitTransfer(
    '/workspace',
    mode,
    base,
    ref,
    parts === undefined ? undefined : Number(parts),
  )
