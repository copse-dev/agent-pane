import { isRecord } from './internal-utils.ts'

/**
 * Allowed JSON shape for Anthropic `GET /api/oauth/usage`.
 *
 * Keep this in sync with `claude.ts`. Anything not listed here is reported by
 * the probe CLI so we notice new buckets (Fable landed this way) before they
 * silently disappear into ignored keys.
 */
export const CLAUDE_USAGE_SCHEMA: SchemaNode = {
  type: 'object',
  keys: {
    five_hour: { type: 'ref', ref: 'legacyWindow' },
    seven_day: { type: 'ref', ref: 'legacyWindow' },
    seven_day_opus: { type: 'ref', ref: 'legacyWindow' },
    seven_day_sonnet: { type: 'ref', ref: 'legacyWindow' },
    seven_day_oauth_apps: { type: 'ref', ref: 'legacyWindow' },
    seven_day_cowork: { type: 'ref', ref: 'legacyWindow' },
    seven_day_omelette: { type: 'ref', ref: 'legacyWindow' },
    iguana_necktie: { type: 'ref', ref: 'legacyWindow' },
    extra_usage: {
      type: 'object',
      keys: {
        is_enabled: { type: 'any' },
        monthly_limit: { type: 'any' },
        used_credits: { type: 'any' },
        utilization: { type: 'any' },
      },
    },
    limits: {
      type: 'array',
      item: {
        type: 'object',
        keys: {
          kind: {
            type: 'enum',
            values: ['session', 'weekly_all', 'weekly_scoped'],
          },
          percent: { type: 'any' },
          utilization: { type: 'any' },
          resets_at: { type: 'any' },
          resetsAt: { type: 'any' },
          is_active: { type: 'any' },
          scope: {
            type: 'object',
            keys: {
              model: {
                type: 'object',
                keys: {
                  display_name: { type: 'any' },
                  id: { type: 'any' },
                  slug: { type: 'any' },
                },
              },
            },
          },
        },
      },
    },
  },
  defs: {
    legacyWindow: {
      type: 'object',
      // null is allowed at the parent (key present, value null) — handled by walker.
      keys: {
        utilization: { type: 'any' },
        resets_at: { type: 'any' },
      },
    },
  },
}

/**
 * Allowed JSON shape for ChatGPT/Codex usage (`/wham/usage` or `/api/codex/usage`).
 * Keep in sync with `codex.ts`. Expanded from live prolite probe (2026-07-15).
 */
export const CODEX_USAGE_SCHEMA: SchemaNode = {
  type: 'object',
  keys: {
    user_id: { type: 'any' },
    account_id: { type: 'any' },
    email: { type: 'any' },
    plan_type: { type: 'any' },
    planType: { type: 'any' },
    rate_limit: { type: 'ref', ref: 'rateLimit' },
    rateLimit: { type: 'ref', ref: 'rateLimit' },
    rate_limits: { type: 'ref', ref: 'rateLimit' },
    rateLimits: { type: 'ref', ref: 'rateLimit' },
    credits: { type: 'ref', ref: 'credits' },
    code_review_rate_limit: { type: 'ref', ref: 'rateLimit' },
    codeReviewRateLimit: { type: 'ref', ref: 'rateLimit' },
    additional_rate_limits: {
      type: 'array',
      item: { type: 'ref', ref: 'additionalLimit' },
    },
    additionalRateLimits: {
      type: 'array',
      item: { type: 'ref', ref: 'additionalLimit' },
    },
    rate_limit_reached_type: { type: 'any' },
    rateLimitReachedType: { type: 'any' },
    spend_control: { type: 'any' },
    promo: { type: 'any' },
    rate_limit_reset_credits: { type: 'any' },
  },
  defs: {
    rateLimit: {
      type: 'object',
      keys: {
        limit_id: { type: 'any' },
        limitId: { type: 'any' },
        limit_name: { type: 'any' },
        limitName: { type: 'any' },
        plan_type: { type: 'any' },
        planType: { type: 'any' },
        primary: { type: 'ref', ref: 'window' },
        secondary: { type: 'ref', ref: 'window' },
        primary_window: { type: 'ref', ref: 'window' },
        primaryWindow: { type: 'ref', ref: 'window' },
        secondary_window: { type: 'ref', ref: 'window' },
        secondaryWindow: { type: 'ref', ref: 'window' },
        credits: { type: 'ref', ref: 'credits' },
        rate_limit_reached_type: { type: 'any' },
        rateLimitReachedType: { type: 'any' },
        allowed: { type: 'any' },
        limit_reached: { type: 'any' },
        limitReached: { type: 'any' },
      },
    },
    additionalLimit: {
      type: 'object',
      keys: {
        metered_feature: { type: 'any' },
        meteredFeature: { type: 'any' },
        rate_limit: { type: 'ref', ref: 'rateLimit' },
        rateLimit: { type: 'ref', ref: 'rateLimit' },
        // Flat window fields sometimes appear on the entry itself.
        primary_window: { type: 'ref', ref: 'window' },
        secondary_window: { type: 'ref', ref: 'window' },
        limit_name: { type: 'any' },
      },
    },
    window: {
      type: 'object',
      keys: {
        used_percent: { type: 'any' },
        usedPercent: { type: 'any' },
        limit_window_seconds: { type: 'any' },
        window_duration_mins: { type: 'any' },
        windowDurationMins: { type: 'any' },
        reset_at: { type: 'any' },
        resets_at: { type: 'any' },
        resetsAt: { type: 'any' },
        resetAt: { type: 'any' },
        reset_after_seconds: { type: 'any' },
        resetAfterSeconds: { type: 'any' },
      },
    },
    credits: {
      type: 'object',
      keys: {
        has_credits: { type: 'any' },
        hasCredits: { type: 'any' },
        unlimited: { type: 'any' },
        balance: { type: 'any' },
        overage_limit_reached: { type: 'any' },
        overageLimitReached: { type: 'any' },
        approx_local_messages: { type: 'any' },
        approxLocalMessages: { type: 'any' },
        approx_cloud_messages: { type: 'any' },
        approxCloudMessages: { type: 'any' },
      },
    },
  },
}

/**
 * Allowed JSON shape for Cursor
 * `POST /api/dashboard/get-current-period-usage`. Keep in sync with `cursor.ts`.
 * Captured from live dashboard (2026-07).
 */
export const CURSOR_PERIOD_USAGE_SCHEMA: SchemaNode = {
  type: 'object',
  keys: {
    billingCycleStart: { type: 'any' },
    billingCycleEnd: { type: 'any' },
    planUsage: {
      type: 'object',
      keys: {
        totalSpend: { type: 'any' },
        includedSpend: { type: 'any' },
        remaining: { type: 'any' },
        limit: { type: 'any' },
        remainingBonus: { type: 'any' },
        bonusTooltip: { type: 'any' },
        autoPercentUsed: { type: 'any' },
        apiPercentUsed: { type: 'any' },
        totalPercentUsed: { type: 'any' },
      },
    },
    spendLimitUsage: {
      type: 'object',
      keys: {
        individualLimit: { type: 'any' },
        individualRemaining: { type: 'any' },
        limitType: { type: 'any' },
      },
    },
    displayThreshold: { type: 'any' },
    enabled: { type: 'any' },
    displayMessage: { type: 'any' },
    autoModelSelectedDisplayMessage: { type: 'any' },
    namedModelSelectedDisplayMessage: { type: 'any' },
    autoBucketModels: { type: 'any' },
  },
}

/** `POST /api/dashboard/get-hard-limit` */
export const CURSOR_HARD_LIMIT_SCHEMA: SchemaNode = {
  type: 'object',
  keys: {
    hardLimit: { type: 'any' },
    noUsageBasedAllowed: { type: 'any' },
  },
}

/**
 * Allowed JSON shape for Hugging Face
 * `GET /api/settings/billing/usage-v2`. Keep in sync with `huggingface.ts`.
 * Captured from live personal billing (2026-07).
 */
export const HUGGINGFACE_USAGE_SCHEMA: SchemaNode = {
  type: 'object',
  keys: {
    usage: {
      type: 'object',
      keys: {
        Spaces: { type: 'any' },
        Endpoints: { type: 'any' },
        inferenceProviders: {
          type: 'object',
          keys: {
            includedNanoUsd: { type: 'any' },
            limitNanoUsd: { type: 'any' },
            usedNanoUsd: { type: 'any' },
            numRequests: { type: 'any' },
            providerDetails: {
              type: 'array',
              item: {
                type: 'object',
                keys: {
                  provider: { type: 'any' },
                  numRequests: { type: 'any' },
                  totalCostNanoUsd: { type: 'any' },
                  totalDurationMs: { type: 'any' },
                },
              },
            },
            periodEnd: { type: 'any' },
            periodStart: { type: 'any' },
          },
        },
        jobs: {
          type: 'object',
          keys: {
            totalMinutes: { type: 'any' },
            usedMicroUsd: { type: 'any' },
            hardwareFlavorBreakdown: { type: 'any' },
          },
        },
        privateStorage: {
          type: 'object',
          keys: {
            totalTB: { type: 'any' },
            includedTB: { type: 'any' },
            totalCents: { type: 'any' },
            amountDueCents: { type: 'any' },
          },
        },
        zeroGpu: {
          type: 'object',
          keys: {
            billedSeconds: { type: 'any' },
          },
        },
      },
    },
  },
}

export type SchemaNode =
  | { type: 'any' }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'array'; item: SchemaNode }
  | { type: 'object'; keys: Record<string, SchemaNode>; defs?: Record<string, SchemaNode> }
  | { type: 'ref'; ref: string }

export interface UnknownFieldFinding {
  /** JSONPath-ish location, e.g. `limits[2].scope.model.family`. */
  path: string
  /** Why it was flagged. */
  kind: 'unknown_key' | 'unknown_enum' | 'unexpected_type'
  detail: string
}

type ConcreteSchema = Exclude<SchemaNode, { type: 'ref' }>

function resolveSchema(
  node: SchemaNode,
  defs: Record<string, SchemaNode> | undefined,
): ConcreteSchema {
  if (node.type !== 'ref') return node
  const resolved = defs?.[node.ref]
  if (!resolved) {
    throw new Error(`schema ref "${node.ref}" is not defined`)
  }
  return resolveSchema(resolved, defs)
}

function walk(
  value: unknown,
  schema: SchemaNode,
  path: string,
  defs: Record<string, SchemaNode> | undefined,
  out: UnknownFieldFinding[],
): void {
  if (value === null || value === undefined) return

  const node = resolveSchema(schema, defs)

  if (node.type === 'any') return

  if (node.type === 'enum') {
    if (typeof value !== 'string') {
      out.push({
        path,
        kind: 'unexpected_type',
        detail: `expected string enum, got ${typeof value}`,
      })
      return
    }
    if (!node.values.includes(value)) {
      out.push({
        path,
        kind: 'unknown_enum',
        detail: `value ${JSON.stringify(value)} not in [${node.values.join(', ')}]`,
      })
    }
    return
  }

  if (node.type === 'array') {
    if (!Array.isArray(value)) {
      out.push({
        path,
        kind: 'unexpected_type',
        detail: `expected array, got ${typeof value}`,
      })
      return
    }
    value.forEach((item, index) => {
      walk(item, node.item, `${path}[${String(index)}]`, defs, out)
    })
    return
  }

  // object (ref already resolved away)
  if (!isRecord(value)) {
    out.push({
      path,
      kind: 'unexpected_type',
      detail: `expected object, got ${Array.isArray(value) ? 'array' : typeof value}`,
    })
    return
  }

  const childDefs = node.defs ?? defs
  for (const [key, child] of Object.entries(value)) {
    const childSchema = node.keys[key]
    const childPath = path ? `${path}.${key}` : key
    if (!childSchema) {
      out.push({
        path: childPath,
        kind: 'unknown_key',
        detail: `key ${JSON.stringify(key)} is not in the known schema`,
      })
      continue
    }
    walk(child, childSchema, childPath, childDefs, out)
  }
}

/** Diff a provider payload against the known schema; returns unknown fields. */
export function findUnknownFields(value: unknown, schema: SchemaNode): UnknownFieldFinding[] {
  const out: UnknownFieldFinding[] = []
  walk(value, schema, '', schema.type === 'object' ? schema.defs : undefined, out)
  return out
}
