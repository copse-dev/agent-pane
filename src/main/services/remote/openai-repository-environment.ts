import type { OpenAiHostedEnvironment } from './openai-agents-api.ts'

/** Shared by the app and the no-inference repository diagnostic. */
export function repositoryEnvironment(
  worker: Buffer,
  metadata: { tree: string; snapshotTree: string; commit: string },
  transfer: { base: string; ref: string },
  sourceFileIds: string[],
  url: string,
): OpenAiHostedEnvironment {
  return {
    type: 'openai_hosted',
    network: { access: 'enabled' },
    files: [
      {
        type: 'inline',
        data: Buffer.from(JSON.stringify({ ...metadata, url })).toString('base64'),
        path: '/workspace/inputs/archive.json',
      },
      ...sourceFileIds.map((file_id, index) => ({
        type: 'file_id' as const,
        file_id,
        path: `/workspace/inputs/source.part-${String(index)}`,
      })),
      { type: 'inline', data: worker.toString('base64'), path: '/workspace/inputs/copse-git.cjs' },
    ],
    setup_commands: [
      {
        command: `node /workspace/inputs/copse-git.cjs archive ${transfer.base} ${transfer.ref} ${String(sourceFileIds.length)}`,
      },
    ],
  }
}
