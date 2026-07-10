export const APP_ICON_VARIANTS = [
  'rose',
  'aurora',
  'citrus',
  'candy',
  'steel',
  'amber',
  'forest',
  'orchid',
  'sunset',
  'ocean',
  'emerald',
  'nebula',
  'ember',
  'paper',
  'coral',
  'lagoon',
] as const
export type AppIconVariant = (typeof APP_ICON_VARIANTS)[number]

export const DEFAULT_APP_ICON_VARIANT: AppIconVariant = 'rose'

export const APP_ICON_VARIANT_LABELS: Record<AppIconVariant, string> = {
  rose: 'Rose',
  aurora: 'Aurora',
  citrus: 'Citrus',
  candy: 'Candy',
  steel: 'Steel',
  amber: 'Amber',
  forest: 'Forest',
  orchid: 'Orchid',
  sunset: 'Sunset',
  ocean: 'Ocean',
  emerald: 'Emerald',
  nebula: 'Nebula',
  ember: 'Ember',
  paper: 'Paper',
  coral: 'Coral',
  lagoon: 'Lagoon',
}

/**
 * Colour recipe for one icon variant — the two gradient stops of the wave
 * stroke plus the tile background. These are the schemes exported from the
 * "Icon Studio" design (claude.ai/design), and are the single source of truth
 * for both the rasterised PNG/.icns assets (scripts/generate-icon.mts renders
 * the wave mark from them) and any in-app colour swatches.
 */
export interface AppIconScheme {
  /** Gradient start colour (top-left of the stroke). */
  start: string
  /** Gradient end colour (bottom-right of the stroke). */
  end: string
  /** Rounded-tile background fill. */
  bg: string
}

export const APP_ICON_VARIANT_SCHEMES: Record<AppIconVariant, AppIconScheme> = {
  rose: { start: '#FDA4AF', end: '#F472B6', bg: '#7A1145' },
  aurora: { start: '#7C3AED', end: '#22D3EE', bg: '#0F172A' },
  citrus: { start: '#79F042', end: '#4C7EF0', bg: '#121C0D' },
  candy: { start: '#4265F0', end: '#F04C86', bg: '#0D101C' },
  steel: { start: '#E5E7EB', end: '#9CA3AF', bg: '#111827' },
  amber: { start: '#D97706', end: '#F8C471', bg: '#1B1712' },
  forest: { start: '#E5E7EB', end: '#9CA3AF', bg: '#12591A' },
  orchid: { start: '#E5E7EB', end: '#9CA3AF', bg: '#610E5C' },
  sunset: { start: '#F97316', end: '#DB2777', bg: '#1A1220' },
  ocean: { start: '#22D3EE', end: '#3B82F6', bg: '#0B1220' },
  emerald: { start: '#34D399', end: '#059669', bg: '#06120E' },
  nebula: { start: '#6366F1', end: '#D946EF', bg: '#0F0A1E' },
  ember: { start: '#FBBF24', end: '#EF4444', bg: '#1C1210' },
  paper: { start: '#111827', end: '#4B5563', bg: '#F3F4F6' },
  coral: { start: '#FF7A6B', end: '#FFB86B', bg: '#1C1113' },
  lagoon: { start: '#06B6D4', end: '#14B8A6', bg: '#041A1C' },
}

export function isAppIconVariant(value: unknown): value is AppIconVariant {
  return typeof value === 'string' && (APP_ICON_VARIANTS as readonly string[]).includes(value)
}
