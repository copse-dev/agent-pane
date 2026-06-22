import { LM_STUDIO_MODEL_IDS } from './lm-studio-defaults.ts'

export type PreferredModelRole = 'chat' | 'smallTasks' | 'safety'

export interface PreferredModel {
  role: PreferredModelRole
  id: string
  label: string
  description: string
  /** Rough download size for onboarding copy (GB). */
  downloadGb: number
}

export const PREFERRED_MODELS: PreferredModel[] = [
  {
    role: 'chat',
    id: LM_STUDIO_MODEL_IDS.chat,
    label: 'Default local model',
    description: 'Main local model for chat when you pick a local model',
    downloadGb: 22,
  },
  {
    role: 'smallTasks',
    id: LM_STUDIO_MODEL_IDS.smallTasks,
    label: 'Small tasks model',
    description: 'Thread titles and other lightweight prompts (local default)',
    downloadGb: 4,
  },
  {
    role: 'safety',
    id: LM_STUDIO_MODEL_IDS.safety,
    label: 'Instruct / safety model',
    description: 'Classifies shell commands when the OS sandbox is off',
    downloadGb: 2.5,
  },
]

export const PREFERRED_MODEL_IDS = PREFERRED_MODELS.map((m) => m.id)

export function preferredModelSettingKey(role: PreferredModelRole): string {
  switch (role) {
    case 'chat':
      return 'localDefaultModel'
    case 'smallTasks':
      return 'smallTasksModel'
    case 'safety':
      return 'safetyModel'
  }
}
