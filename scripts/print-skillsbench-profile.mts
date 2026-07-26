import { skillsBenchProfile } from './lib/skillsbench-profiles.mts'

const profile = skillsBenchProfile(process.argv[2], [])
process.stdout.write(
  `${JSON.stringify({
    id: profile.versionedId,
    baseId: profile.id,
    contentHash: profile.contentHash,
    reasoningPolicy: profile.reasoningPolicy,
  })}\n`,
)
