/**
 * Pure helpers for the Claude Managed Agents provider, kept free of any
 * main-process (electron) imports so they can be unit-tested directly.
 *
 * Repository access uses the native `github_repository` session resource: the
 * repo is cloned and its git remote wired up from the resource's
 * `authorization_token` during sandbox init, and the agent pushes branches /
 * opens PRs through the GitHub MCP server — the token never appears in the
 * prompt or in any agent-visible context. So the system prompt below carries no
 * credentials; it only tells the agent how to operate on the already-mounted
 * checkout.
 */
export const DEFAULT_MANAGED_AGENT_MODEL = 'claude-opus-4-8'
export const DEFAULT_MANAGED_AGENT_BRANCH_PREFIX = 'claude/'
export const MANAGED_AGENT_REPO_MOUNT_PATH = '/workspace/repo'
export const GITHUB_MCP_SERVER_URL = 'https://api.githubcopilot.com/mcp/'
export const GITHUB_MCP_SERVER_NAME = 'github'

export interface ManagedAgentSystemPromptInput {
  /** Sandbox path where the github_repository resource is mounted. */
  mountPath: string
  /** Prefix for the working branch the agent creates, e.g. `claude/`. */
  branchPrefix: string
  /** Branch/commit to start from; empty means the repo's default branch. */
  startingRef?: string
  autoCreatePR: boolean
  /** Commit to the starting ref directly instead of cutting a new branch. */
  workOnCurrentBranch: boolean
}

/**
 * Build the standing system prompt that orients the agent in a sandbox where the
 * repository is already cloned and the git remote is already authenticated.
 */
export function buildManagedAgentSystemPrompt(input: ManagedAgentSystemPromptInput): string {
  const baseRef = input.startingRef?.trim()
  const lines: string[] = [
    'You are an autonomous software engineering agent working in an isolated cloud sandbox.',
    `The target GitHub repository is already cloned and mounted at \`${input.mountPath}\`, with its`,
    'git remote configured and authenticated. Change into that directory before doing any work.',
    '',
  ]

  if (baseRef) {
    lines.push(`Start from the ref the user chose: check out \`${baseRef}\`.`)
  } else {
    lines.push(`Start from the repository's default branch.`)
  }

  if (input.workOnCurrentBranch) {
    lines.push(
      `Commit your work directly to ${baseRef ? `\`${baseRef}\`` : 'the default branch'} — do not create a new branch — then push it.`,
    )
  } else {
    lines.push(
      `Before making changes, create a new working branch named \`${input.branchPrefix}<short-kebab-summary>\`.`,
    )
  }

  lines.push(
    'Make the changes the user asks for. Where it is quick and relevant, run the project tests or build to check your work.',
    'Commit with a clear, descriptive message and push the branch to origin.',
  )

  if (input.autoCreatePR) {
    lines.push(
      'Then open a pull request using the GitHub MCP tools (e.g. create_pull_request), targeting the',
      `${baseRef ? `\`${baseRef}\`` : 'default'} branch.`,
    )
  } else {
    lines.push('Do not open a pull request — just push the branch.')
  }

  lines.push(
    '',
    'When you finish, end your final message by clearly stating the exact branch name you pushed' +
      (input.autoCreatePR ? ' and the URL of the pull request you opened.' : '.'),
  )

  return lines.join('\n')
}

/**
 * System prompt for a session with no repository attached (the local project is
 * not a git repo or has no GitHub remote). The sandbox starts empty and nothing
 * in it persists for the user, so results must come back in the reply itself.
 */
export function buildManagedAgentNoRepoSystemPrompt(): string {
  return [
    'You are an autonomous software engineering agent working in an isolated cloud sandbox.',
    'No repository is attached to this session — the workspace starts empty. Do not attempt to',
    'clone, push, or open pull requests.',
    '',
    'Do the work the user asks for directly in the sandbox. Nothing in the sandbox is delivered',
    'back to the user automatically, so include any code, file contents, or other results they',
    'need inline in your final message.',
  ].join('\n')
}
