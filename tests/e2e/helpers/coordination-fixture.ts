/** Import seed-config only after the base harness installs its isolated paths. */
export async function seedCoordinationDemo(): Promise<void> {
  const { resetUserData, seedEmptyProject, writeSeedConfig } = await import('./seed-config.ts')
  const { writeE2eEnv, e2eGitBranch } = await import('./e2e-env.ts')
  const project = 'coordination-demo'
  resetUserData()
  seedEmptyProject(process.cwd(), project, {
    subagentsEnabled: false,
    model: 'claude-sonnet-4-6',
    windowBounds: { width: 1280, height: 800 },
    pluginDisabled: [
      'copse.apple-development',
      'copse.advisor-strategy',
      'copse.artifact-checkpoint',
      'copse.automations',
      'copse.ci-investigator',
      'copse.devtools-shortcut',
      'copse.dark-factory',
      'copse.long-horizon-tasks',
      'copse.mcp-ui-canvas',
      'copse.okf-memories',
      'copse.pii-redaction',
      'copse.review',
      'copse.roadmap-plans',
      'copse.todos',
      'copse.post-turn-review',
      'copse.model-comparison',
    ],
  })
  writeSeedConfig({
    projects: [{ id: project, path: process.cwd(), name: 'Coordination demo · scripted mock' }],
    activeProjectId: project,
    [`threads:${project}`]: [
      { id: 'license-collector', title: 'License collector · demo' },
      { id: 'notices-staleness-lint', title: 'Notices lint · demo' },
    ].map((thread, index) => ({
      ...thread,
      draftPrompt: 'Scripted coordination demo',
      status: 'idle',
      messages: [
        {
          id: `${thread.id}-intro`,
          role: 'assistant',
          content:
            'Scripted mock demo. Coordination uses real Copse tools; no model calls or file writes.',
          toolCalls: [],
          createdAt: 1_700_000_000_000,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1_700_000_000_000 + index,
      updatedAt: 1_700_000_000_000 + index,
      gitBranch: e2eGitBranch(),
      worktreeChoice: 'shared',
    })),
  })
  writeE2eEnv({
    COPSE_COORDINATION_DEMO: '1',
    COPSE_PANEL_USER_DATA: process.env.COPSE_PANEL_USER_DATA,
    COPSE_WORKSPACE_DIR: process.env.COPSE_WORKSPACE_DIR,
  })
}
