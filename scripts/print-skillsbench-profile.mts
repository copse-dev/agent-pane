import { parseSkillsBenchProfileId, skillsBenchProfile } from './lib/skillsbench-profiles.mts'

const profile = skillsBenchProfile(parseSkillsBenchProfileId(process.argv[2]), [])
process.stdout.write(
  `${JSON.stringify({ id: profile.versionedId, contentHash: profile.contentHash })}\n`,
)
