/** Parsed five-field cron expression, evaluated in the machine's local time. */
interface CronSpec {
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
  daysOfMonth: ReadonlySet<number>
  months: ReadonlySet<number>
  daysOfWeek: ReadonlySet<number>
  anyDayOfMonth: boolean
  anyDayOfWeek: boolean
}

interface FieldRange {
  min: number
  max: number
  normalize?: (value: number) => number
}

function parseNumber(raw: string, range: FieldRange): number {
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid cron value “${raw}”`)
  const value = Number(raw)
  if (value < range.min || value > range.max) {
    throw new Error(
      `Cron value ${raw} must be between ${String(range.min)} and ${String(range.max)}`,
    )
  }
  return range.normalize?.(value) ?? value
}

function addRange(
  values: Set<number>,
  start: number,
  end: number,
  step: number,
  range: FieldRange,
): void {
  if (end < start) throw new Error('Cron ranges must increase from left to right')
  for (let value = start; value <= end; value += step) {
    values.add(range.normalize?.(value) ?? value)
  }
}

function parseField(raw: string, range: FieldRange): ReadonlySet<number> {
  const values = new Set<number>()
  for (const part of raw.split(',')) {
    if (!part) throw new Error('Cron lists cannot contain an empty value')
    const [base, stepRaw, ...extra] = part.split('/')
    if (extra.length > 0 || base === undefined) throw new Error(`Invalid cron field “${raw}”`)
    const step = stepRaw === undefined ? 1 : parseNumber(stepRaw, { min: 1, max: range.max })
    if (base === '*') {
      addRange(values, range.min, range.max, step, range)
      continue
    }
    const bounds = base.split('-')
    if (bounds.length === 1) {
      if (stepRaw !== undefined) throw new Error('A cron step requires * or a range')
      values.add(parseNumber(base, range))
      continue
    }
    if (bounds.length !== 2 || bounds[0] === undefined || bounds[1] === undefined) {
      throw new Error(`Invalid cron range “${base}”`)
    }
    const start = parseNumber(bounds[0], range)
    const end = parseNumber(bounds[1], range)
    // Use un-normalized 7 as the range endpoint for day-of-week; addRange
    // normalizes only while inserting values.
    addRange(values, Number(bounds[0]), Number(bounds[1]), step, range)
    if (start === end && bounds[0] !== bounds[1]) values.add(start)
  }
  if (values.size === 0) throw new Error(`Cron field “${raw}” selects no values`)
  return values
}

export function parseCronExpression(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('Use five cron fields: minute hour day month weekday')
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    throw new Error('Use five cron fields: minute hour day month weekday')
  }
  return {
    minutes: parseField(minute, { min: 0, max: 59 }),
    hours: parseField(hour, { min: 0, max: 23 }),
    daysOfMonth: parseField(dayOfMonth, { min: 1, max: 31 }),
    months: parseField(month, { min: 1, max: 12 }),
    daysOfWeek: parseField(dayOfWeek, {
      min: 0,
      max: 7,
      normalize: (value) => (value === 7 ? 0 : value),
    }),
    anyDayOfMonth: dayOfMonth === '*',
    anyDayOfWeek: dayOfWeek === '*',
  }
}

/** Match standard cron day semantics: restricted day-of-month/day-of-week are ORed. */
export function cronMatches(expression: string, date: Date): boolean {
  const spec = parseCronExpression(expression)
  if (!spec.minutes.has(date.getMinutes())) return false
  if (!spec.hours.has(date.getHours())) return false
  if (!spec.months.has(date.getMonth() + 1)) return false

  const dayOfMonthMatches = spec.daysOfMonth.has(date.getDate())
  const dayOfWeekMatches = spec.daysOfWeek.has(date.getDay())
  if (spec.anyDayOfMonth) return dayOfWeekMatches
  if (spec.anyDayOfWeek) return dayOfMonthMatches
  return dayOfMonthMatches || dayOfWeekMatches
}

export function validateCronExpression(expression: string): void {
  parseCronExpression(expression)
}
