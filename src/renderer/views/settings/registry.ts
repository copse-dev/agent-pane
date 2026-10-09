import { generalMarkup, generalFields } from './general-markup.ts'
import { classifiersMarkup } from './classifiers-markup.ts'
import { usageMarkup } from './usage-markup.ts'
import { agentMarkup, agentFields } from './agent-markup.ts'
import { permissionsMarkup, permissionsFields } from './permissions-markup.ts'
import { mcpMarkup, mcpFields } from './mcp-markup.ts'
import { customiseMarkup, customiseFields } from './customise-markup.ts'
import { storageMarkup } from './storage-markup.ts'
import { appearanceMarkup, appearanceFields } from './appearance-markup.ts'
import { sshMarkup, sshFields } from './ssh-markup.ts'
import { experimentalMarkup, experimentalFields } from './experimental-markup.ts'
import { aboutMarkup } from './about-markup.ts'
import type { SettingsSection } from './navigation.ts'
import type { SettingField } from './fields.ts'

export interface SettingsSectionDefinition {
  id: SettingsSection
  label: string
  markup: string
  fields: readonly SettingField[]
}

/** New sections register here; their markup and fields stay with the feature. */
export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  { id: 'general', label: 'General', markup: generalMarkup, fields: generalFields },
  { id: 'classifiers', label: 'Classifiers', markup: classifiersMarkup, fields: [] },
  { id: 'usage', label: 'Usage', markup: usageMarkup, fields: [] },
  { id: 'agent', label: 'Agent', markup: agentMarkup, fields: agentFields },
  { id: 'permissions', label: 'Permissions', markup: permissionsMarkup, fields: permissionsFields },
  { id: 'mcp', label: 'MCP servers', markup: mcpMarkup, fields: mcpFields },
  { id: 'customise', label: 'Customise', markup: customiseMarkup, fields: customiseFields },
  { id: 'storage', label: 'Storage', markup: storageMarkup, fields: [] },
  { id: 'appearance', label: 'Appearance', markup: appearanceMarkup, fields: appearanceFields },
  { id: 'ssh', label: 'SSH', markup: sshMarkup, fields: sshFields },
  {
    id: 'experimental',
    label: 'Experimental',
    markup: experimentalMarkup,
    fields: experimentalFields,
  },
  { id: 'about', label: 'About', markup: aboutMarkup, fields: [] },
]
