export type DiffApplyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_entry' | 'disk_changed'; message: string }
