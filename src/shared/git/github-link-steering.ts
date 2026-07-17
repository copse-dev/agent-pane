// GitHub-link steering helpers moved into `@copse/agent` (M0.2) so first-party
// hooks stay Electron-free. Re-exported here so existing `@shared/git` imports
// keep working.
export {
  shouldSteerGithubLinks,
  parseGithubRepoSlug,
  buildGithubLinkSteeringPrompt,
} from '@copse/agent/github-link-steering.ts'
