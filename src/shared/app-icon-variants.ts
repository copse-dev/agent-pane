export const APP_ICON_VARIANTS = ['classic', 'wave'] as const
export type AppIconVariant = (typeof APP_ICON_VARIANTS)[number]

export const DEFAULT_APP_ICON_VARIANT = 'wave'

export const APP_ICON_VARIANT_LABELS: Record<AppIconVariant, string> = {
  classic: 'Classic',
  wave: 'Wave',
}

export function isAppIconVariant(value: unknown): value is AppIconVariant {
  return typeof value === 'string' && (APP_ICON_VARIANTS as readonly string[]).includes(value)
}
