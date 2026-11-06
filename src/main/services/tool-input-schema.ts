/**
 * The one path from a registered tool to the input schema a model sees.
 *
 * `ToolRegistry` exports every tool twice: as MCP tools (JSON Schema draft
 * 2020-12) for the ACP bridge, and as provider tools (OpenAPI 3.0) for Copse's
 * own model loop. Both go through {@link modelFacingInputSchema}, so the bridge
 * and the native providers cannot drift apart on what they accept.
 *
 * The rule both enforce is the strictest consumer's: the Anthropic API takes a
 * tool only when its input schema has `type: "object"` at the top level and no
 * top-level `anyOf`/`oneOf`/`allOf`. Claude Code goes further and drops every
 * tool of an MCP server that offers one such schema, which is how a single
 * `z.union` hid all of Copse's tools from Claude (#4142).
 */
import { z } from 'zod'
import { errorMessage } from '@shared/errors.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { isDefined } from '@copse/std/nullish.ts'

/** The JSON Schema flavours a registered tool's input is exported in. */
export type ToolSchemaDialect = 'draft-2020-12' | 'openapi-3.0'

/** Every dialect a tool is exported in; a first-party tool must pass in each. */
export const TOOL_SCHEMA_DIALECTS: readonly ToolSchemaDialect[] = ['draft-2020-12', 'openapi-3.0']

/** The parts of a tool definition its input schema is built from. */
export interface ToolSchemaSource {
  parameters: z.ZodType
  rawParameters?: Record<string, unknown>
}

const TOP_LEVEL_COMBINATORS = ['anyOf', 'oneOf', 'allOf'] as const

/**
 * Why an agent could not list a tool with this input schema, as a phrase that
 * completes "… can't be offered to agents: ", or null when it can.
 */
export function agentInputSchemaProblem(schema: Record<string, unknown>): string | null {
  if (schema['type'] !== 'object') return 'its input schema is not a top-level object'
  for (const key of TOP_LEVEL_COMBINATORS) {
    if (Object.hasOwn(schema, key)) return `its input schema has a top-level "${key}"`
  }
  return null
}

/** Whether an agent can list a tool with this input schema (see {@link agentInputSchemaProblem}). */
export function isAgentInputSchema(schema: Record<string, unknown>): boolean {
  return agentInputSchemaProblem(schema) === null
}

/**
 * The input schema a tool declares in `dialect`: its pre-built `rawParameters`
 * as they are, or one derived from its zod `parameters`. Throws when zod cannot
 * convert the schema.
 */
export function toolInputSchema(
  tool: ToolSchemaSource,
  dialect: ToolSchemaDialect,
): Record<string, unknown> {
  if (tool.rawParameters) return tool.rawParameters
  return dialect === 'openapi-3.0'
    ? { ...z.toJSONSchema(tool.parameters, { target: 'openapi-3.0' }) }
    : { ...z.toJSONSchema(tool.parameters) }
}

/**
 * The input schema models are shown for a tool in `dialect`, or the reason no
 * agent could use it: zod could not convert the schema, or it is not a plain
 * top-level object (see {@link agentInputSchemaProblem}).
 */
export function modelFacingInputSchema(
  tool: ToolSchemaSource,
  dialect: ToolSchemaDialect,
): { schema: Record<string, unknown> } | { problem: string } {
  let schema: Record<string, unknown>
  try {
    schema = toolInputSchema(tool, dialect)
  } catch (err) {
    return { problem: `its parameters can't be converted to JSON Schema (${errorMessage(err)})` }
  }
  const problem = agentInputSchemaProblem(schema)
  return problem === null ? { schema } : { problem }
}

interface ObjectBranch {
  properties: Record<string, unknown>
  required: readonly string[]
}

/** The object shapes a converted union is made of, or null when any branch is not an object. */
function objectBranches(schema: Record<string, unknown>): ObjectBranch[] | null {
  if (schema['type'] === 'object') {
    const properties = isRecord(schema['properties']) ? schema['properties'] : {}
    const required = Array.isArray(schema['required'])
      ? schema['required'].filter((key) => typeof key === 'string')
      : []
    return [{ properties, required }]
  }
  const union = schema['oneOf'] ?? schema['anyOf']
  if (!Array.isArray(union) || union.length === 0) return null
  const branches: ObjectBranch[] = []
  for (const member of union) {
    const nested = isRecord(member) ? objectBranches(member) : null
    if (!nested) return null
    branches.push(...nested)
  }
  return branches
}

/** A string literal as zod converts it: `{ type: "string", const: "list" }`. */
function stringConstant(schema: unknown): string | null {
  if (!isRecord(schema) || schema['type'] !== 'string' || typeof schema['const'] !== 'string') {
    return null
  }
  return Object.keys(schema).length === 2 ? schema['const'] : null
}

/** One property's definitions across the shapes that declare it, as one schema. */
function mergedProperty(definitions: readonly unknown[]): unknown {
  const distinct = [
    ...new Map(definitions.map((definition) => [JSON.stringify(definition), definition])).values(),
  ]
  if (distinct.length === 1) return distinct[0]
  const constants = distinct.map(stringConstant)
  if (constants.every((constant) => constant !== null)) return { type: 'string', enum: constants }
  return { anyOf: distinct }
}

/**
 * A flat object schema for `parameters` declared as a union of object shapes,
 * typically one per `action`. Agents list a tool only when its input schema is
 * a top-level object, so such a tool advertises this envelope as its
 * `rawParameters` while `parameters` still validates each shape's exact fields
 * when the tool is called.
 *
 * Each property takes every shape's definition of it: one definition as it is,
 * a discriminator's string literals as one `enum`, other differences as an
 * `anyOf`. Only properties every shape requires stay required. Throws when a
 * member of the union is not an object shape.
 */
export function objectEnvelopeOf(parameters: z.ZodType): Record<string, unknown> {
  const schema: Record<string, unknown> = { ...z.toJSONSchema(parameters) }
  const branches = objectBranches(schema)
  if (!branches) throw new Error('objectEnvelopeOf needs parameters made of object shapes')
  const keys = [...new Set(branches.flatMap((branch) => Object.keys(branch.properties)))]
  const properties = Object.fromEntries(
    keys.map((key) => [
      key,
      mergedProperty(branches.map((branch) => branch.properties[key]).filter(isDefined)),
    ]),
  )
  const required = keys.filter((key) => branches.every((branch) => branch.required.includes(key)))
  return {
    type: 'object',
    ...(typeof schema['description'] === 'string' ? { description: schema['description'] } : {}),
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}
