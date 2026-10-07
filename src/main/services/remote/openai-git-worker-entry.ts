import { runHostedGitTransfer } from './openai-git-worker.ts'
const [mode, base, ref, parts] = process.argv.slice(2)
runHostedGitTransfer('/workspace', mode, base, ref, parts === undefined ? undefined : Number(parts))
