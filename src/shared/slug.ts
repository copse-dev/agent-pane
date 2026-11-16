/**
 * Lowercase slug for ids and directory names: every run of non-alphanumerics
 * becomes one dash, leading/trailing dashes are dropped, and the result is
 * capped at 64 characters. May return `''`; callers supply their own fallback.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}
