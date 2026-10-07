import { runHostedGitTransfer } from './openai-git-worker.ts'
const [mode, base, ref] = process.argv.slice(2)
runHostedGitTransfer('/workspace', mode, base, ref)
