// The renderer ↔ main API protocol, frozen as a generated JSON Schema
// (issue #2312, step 1 — docs/api-protocol.md).
//
// The renderer reaches the main process only through `ApiClient`
// (`src/preload/api.d.ts`). The preload (`src/preload/index.ts`) binds every
// method of that interface to an IPC channel, and the sidecar's WebSocket
// bridge carries the same channels over a socket. This module reads both files
// with the TypeScript compiler API and emits one document that names:
//
//   - `client`   — every `ApiClient` namespace/method: its kind (invoke, send,
//                  subscribe), parameter and result schemas, and the channel the
//                  preload binds it to;
//   - `channels` — the wire surface those bindings produce: for each invoke /
//                  send / event channel, the argument tuple and result schema;
//   - `$defs`    — the named types the surface references, as JSON Schema.
//
// The published copy (`schemas/api-protocol.schema.json`) is what a transport
// or an external client codes against; `scripts/lib/api-protocol.test.ts`
// pins it so the surface only changes when someone regenerates and commits.
//
// Why generate from `api.d.ts` + the preload rather than `src/shared/types/ipc.ts`:
// the hand-written `IpcInvokeMap` / `IpcEventMap` in `ipc.ts` cover fewer than
// half of the channels the preload actually binds and nothing imports them, so
// they are not the source of truth. The preload is: it is typed `ApiClient`
// (so the facade cannot drift from the contract) and every channel it names has
// a literal `ipcMain.handle` in `src/main` (the test checks both).
import ts from 'typescript'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { isRecord } from '../../src/shared/unknown-value.mts'

// ── Public document shape ────────────────────────────────────────────────────

/** A JSON Schema fragment. Kept loose: the document is data, not a type. */
const jsonSchema = z.record(z.string(), z.unknown())
export type JsonSchema = z.infer<typeof jsonSchema>

const apiClientMethodSchema = z.object({
  kind: z.enum(['invoke', 'send', 'subscribe', 'sync']),
  /** The IPC channel the preload binds this method to (`null` when unbound). */
  channel: z.string().nullable(),
  /** Set when the `ApiClient` member itself is optional (`onShowTab?`). */
  optional: z.literal(true).optional(),
  description: z.string().optional(),
  /** Parameter tuple (invoke / send / sync) — a JSON Schema array schema. */
  params: jsonSchema.optional(),
  /** Resolved result for invoke / sync. */
  result: jsonSchema.optional(),
  /** Subscribe only: the tuple the handler is called with. */
  handlerParams: jsonSchema.optional(),
  /** Subscribe only: what the handler returns when it is not `void`. */
  handlerResult: jsonSchema.optional(),
  /**
   * Set when the preload does not pass the facade's arguments straight through
   * to the channel (it reshapes them), so `channels.*.args` for this channel
   * cannot be derived from `params` and is emitted as an open array.
   */
  'x-args-transformed': z.literal(true).optional(),
})
export type ApiClientMethod = z.infer<typeof apiClientMethodSchema>
export type ApiMethodKind = ApiClientMethod['kind']

const apiChannelSchema = z.object({
  /** The `ApiClient` member that binds this channel, as `namespace.method`. */
  'x-api': z.string(),
  args: jsonSchema,
  result: jsonSchema.optional(),
})
export type ApiChannel = z.infer<typeof apiChannelSchema>

const apiProtocolDocumentSchema = z.object({
  $schema: z.string(),
  title: z.string(),
  description: z.string(),
  version: z.number().int().positive(),
  channels: z.object({
    invoke: z.record(z.string(), apiChannelSchema),
    send: z.record(z.string(), apiChannelSchema),
    event: z.record(z.string(), apiChannelSchema),
  }),
  client: z.record(z.string(), z.record(z.string(), apiClientMethodSchema)),
  $defs: z.record(z.string(), jsonSchema),
})
export type ApiProtocolDocument = z.infer<typeof apiProtocolDocumentSchema>

export const API_PROTOCOL_SCHEMA_PATH = 'schemas/api-protocol.schema.json'

export interface GenerateOptions {
  /** Repository root; defaults to the current working directory. */
  root?: string
  /** The protocol version to stamp (normally `API_PROTOCOL_VERSION`). */
  version: number
}

// ── Program setup ────────────────────────────────────────────────────────────

const API_D_TS = 'src/preload/api.d.ts'
const PRELOAD = 'src/preload/index.ts'
const TSCONFIG = 'tsconfig.node.json'

function createProgram(root: string): ts.Program {
  const configPath = resolve(root, TSCONFIG)
  const read = ts.readConfigFile(configPath, (path) => readFileSync(path, 'utf8'))
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  // Only the compiler options matter; the program is rooted at the two
  // protocol sources, not the whole tsconfig `include`.
  const config: unknown = read.config
  const parsed = ts.parseJsonConfigFileContent(
    { ...(isRecord(config) ? config : {}), include: [], files: [] },
    ts.sys,
    dirname(configPath),
  )
  return ts.createProgram({
    rootNames: [resolve(root, API_D_TS), resolve(root, PRELOAD)],
    options: { ...parsed.options, noEmit: true },
  })
}

// ── TypeScript type-shape predicates ─────────────────────────────────────────
//
// The compiler API exposes `ObjectType` / `TypeReference` / `TupleType` only as
// interfaces to assert to. These predicates narrow by the fields those shapes
// carry instead, so no assertion is needed. Local, so they need no tests of
// their own beyond the generated document.

function isObjectType(type: ts.Type): type is ts.ObjectType {
  return (type.flags & ts.TypeFlags.Object) !== 0 && 'objectFlags' in type
}

function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return (
    isObjectType(type) && (type.objectFlags & ts.ObjectFlags.Reference) !== 0 && 'target' in type
  )
}

function isTupleTarget(type: ts.Type): type is ts.TupleType {
  return isObjectType(type) && 'elementFlags' in type
}

function typeArguments(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  return isTypeReference(type) ? checker.getTypeArguments(type) : []
}

// ── Type → JSON Schema ───────────────────────────────────────────────────────

interface SchemaContext {
  program: ts.Program
  checker: ts.TypeChecker
  root: string
  defs: Map<string, JsonSchema>
  nameOf: Map<ts.Type, string>
  depth: number
}

const MAX_DEPTH = 40

function typeText(ctx: SchemaContext, type: ts.Type): string {
  return ctx.checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)
}

function isLibDeclaration(ctx: SchemaContext, decl: ts.Declaration): boolean {
  const file = decl.getSourceFile()
  if (ctx.program.isSourceFileDefaultLibrary(file)) return true
  return !file.fileName.startsWith(ctx.root)
}

function symbolDescription(symbol: ts.Symbol, checker: ts.TypeChecker): string | undefined {
  const text = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim()
  return text === '' ? undefined : text
}

/** Stable, unique `$defs` key for a project-declared named type. */
function defName(ctx: SchemaContext, type: ts.Type, symbol: ts.Symbol): string {
  const existing = ctx.nameOf.get(type)
  if (existing !== undefined) return existing
  const taken = (name: string): boolean =>
    ctx.defs.has(name) || [...ctx.nameOf.values()].includes(name)
  const base = symbol.name
  let name = base
  if (taken(name)) {
    // Two different types share a name (`Thread` in two modules): qualify the
    // newcomer by its declaring file so both survive in the same document.
    const decl = symbol.declarations?.[0]
    const file = decl ? basename(decl.getSourceFile().fileName).replace(/\.d?\.ts$/, '') : 'anon'
    const qualifier = file.replace(/[^A-Za-z0-9_]/g, '_')
    name = `${base}__${qualifier}`
    for (let n = 2; taken(name); n++) name = `${base}__${qualifier}_${String(n)}`
  }
  ctx.nameOf.set(type, name)
  return name
}

/**
 * The symbol under which a type should be published as a named `$defs` entry,
 * or `null` to expand it structurally where it is used. Named: interfaces,
 * classes, enums, and type aliases declared in this repository and not generic
 * instantiations (`Partial<Thread>` expands; `Thread` is a def).
 */
function nameableSymbol(ctx: SchemaContext, type: ts.Type): ts.Symbol | null {
  const alias = type.aliasSymbol
  if (alias && !(type.aliasTypeArguments?.length ?? 0)) {
    const decl = alias.declarations?.[0]
    if (decl && !isLibDeclaration(ctx, decl)) return alias
    return null
  }
  const symbol = type.getSymbol()
  if (!symbol) return null
  if (symbol.name.startsWith('__')) return null
  if (!(symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.Enum))) {
    return null
  }
  const decl = symbol.declarations?.[0]
  if (!decl || isLibDeclaration(ctx, decl)) return null
  if (typeArguments(ctx.checker, type).length > 0) return null
  return symbol
}

function literalSchema(type: ts.Type): JsonSchema | null {
  if (type.isStringLiteral()) return { const: type.value }
  if (type.isNumberLiteral()) return { const: type.value }
  if (type.flags & ts.TypeFlags.BooleanLiteral) return { const: isTrueLiteral(type) }
  return null
}

function isTrueLiteral(type: ts.Type): boolean {
  return 'intrinsicName' in type && type.intrinsicName === 'true'
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (isRecord(entry)) {
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : 1)))
    }
    return entry
  })
}

function bySerialization(a: JsonSchema, b: JsonSchema): number {
  return stableStringify(a) < stableStringify(b) ? -1 : 1
}

function unionSchema(ctx: SchemaContext, type: ts.UnionType): JsonSchema {
  const members: JsonSchema[] = []
  let nullable = false
  let hasUndefined = false
  // `boolean` is `true | false` under the hood; keep it a single primitive.
  let sawTrue = false
  let sawFalse = false
  for (const member of type.types) {
    if (member.flags & ts.TypeFlags.Null) nullable = true
    else if (member.flags & ts.TypeFlags.Undefined) hasUndefined = true
    else if (member.flags & ts.TypeFlags.BooleanLiteral) {
      if (isTrueLiteral(member)) sawTrue = true
      else sawFalse = true
    } else members.push(typeToSchema(ctx, member))
  }
  if (sawTrue && sawFalse) members.push({ type: 'boolean' })
  else if (sawTrue) members.push({ const: true })
  else if (sawFalse) members.push({ const: false })

  let schema: JsonSchema
  const allConst = members.length > 0 && members.every((m) => Object.keys(m).join() === 'const')
  if (allConst) {
    const values = members
      .map((m) => m['const'])
      .sort((a, b) => (stableStringify(a) < stableStringify(b) ? -1 : 1))
    const kinds = new Set(values.map((v) => typeof v))
    schema = values.length === 1 ? { const: values[0] } : { enum: values }
    if (kinds.size === 1 && values.length > 1) schema = { type: [...kinds][0], ...schema }
    if (nullable) schema = { anyOf: [schema, { type: 'null' }] }
  } else if (members.length === 1) {
    schema = members[0] ?? {}
    const kind = schema['type']
    if (nullable) {
      schema =
        typeof kind === 'string'
          ? { ...schema, type: [kind, 'null'] }
          : { anyOf: [schema, { type: 'null' }] }
    }
  } else if (members.length === 0) {
    schema = nullable ? { type: 'null' } : {}
  } else {
    const sorted = [...members].sort(bySerialization)
    schema = { anyOf: nullable ? [...sorted, { type: 'null' }] : sorted }
  }
  if (hasUndefined) schema = { ...schema, 'x-optional': true }
  return schema
}

function withTitle(schema: JsonSchema, title: string | undefined): JsonSchema {
  return title === undefined ? schema : { title, ...schema }
}

function stripOptional(schema: JsonSchema): JsonSchema {
  if (!('x-optional' in schema)) return schema
  const { 'x-optional': _drop, ...rest } = schema
  return rest
}

function tupleSchema(ctx: SchemaContext, type: ts.TypeReference, target: ts.TupleType): JsonSchema {
  const elements = ctx.checker.getTypeArguments(type)
  const labels = target.labeledElementDeclarations ?? []
  const prefixItems: JsonSchema[] = []
  let required = 0
  let rest: JsonSchema | null = null
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index]
    if (!element) continue
    const flags = target.elementFlags[index] ?? ts.ElementFlags.Required
    const label = labels[index]?.name
    const title = label && ts.isIdentifier(label) ? label.text : undefined
    if (flags & ts.ElementFlags.Rest || flags & ts.ElementFlags.Variadic) {
      rest = withTitle(typeToSchema(ctx, element), title)
      continue
    }
    const item = withTitle(stripOptional(typeToSchema(ctx, element)), title)
    if (flags & ts.ElementFlags.Required) required = prefixItems.length + 1
    prefixItems.push(item)
  }
  return arraySchema(prefixItems, required, rest)
}

function arraySchema(
  prefixItems: JsonSchema[],
  required: number,
  rest: JsonSchema | null,
): JsonSchema {
  const schema: JsonSchema = { type: 'array', minItems: required }
  if (prefixItems.length > 0) schema['prefixItems'] = prefixItems
  if (rest) schema['items'] = rest
  else schema['maxItems'] = prefixItems.length
  return schema
}

function objectSchema(ctx: SchemaContext, type: ts.Type): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const prop of ctx.checker.getPropertiesOfType(type)) {
    const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0
    const propType = ctx.checker.getTypeOfSymbol(prop)
    let schema = typeToSchema(ctx, propType)
    const description = symbolDescription(prop, ctx.checker)
    if (optional || 'x-optional' in schema) schema = stripOptional(schema)
    else required.push(prop.name)
    if (description !== undefined && !('$ref' in schema)) {
      schema = { description, ...schema }
    }
    properties[prop.name] = schema
  }
  const schema: JsonSchema = { type: 'object' }
  if (Object.keys(properties).length > 0) schema['properties'] = sortedRecord(properties)
  if (required.length > 0) schema['required'] = [...required].sort()
  const indexInfos = ctx.checker.getIndexInfosOfType(type)
  const index =
    indexInfos.find((info) => info.keyType.flags & ts.TypeFlags.String) ??
    indexInfos.find((info) => info.keyType.flags & ts.TypeFlags.Number)
  if (index) schema['additionalProperties'] = typeToSchema(ctx, index.type)
  return schema
}

function unwrapPromise(ctx: SchemaContext, type: ts.Type): ts.Type | null {
  const symbol = type.getSymbol()
  if (!symbol || symbol.name !== 'Promise') return null
  return typeArguments(ctx.checker, type)[0] ?? null
}

const BINARY_TYPES = new Set(['Uint8Array', 'ArrayBuffer', 'Buffer', 'ArrayBufferLike'])
const OPAQUE_LIB_TYPES = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Iterator', 'Generator'])

function typeToSchema(ctx: SchemaContext, type: ts.Type): JsonSchema {
  if (ctx.depth > MAX_DEPTH) return { 'x-ts-type': typeText(ctx, type), 'x-truncated': true }
  const flags = type.flags

  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    return { 'x-ts-type': flags & ts.TypeFlags.Any ? 'any' : 'unknown' }
  }
  if (flags & ts.TypeFlags.Never) return { not: {} }
  if (flags & ts.TypeFlags.Null) return { type: 'null' }
  if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
    return { 'x-ts-type': flags & ts.TypeFlags.Void ? 'void' : 'undefined' }
  }
  const literal = literalSchema(type)
  if (literal) return literal
  if (flags & ts.TypeFlags.Boolean) return { type: 'boolean' }
  if (flags & ts.TypeFlags.String) return { type: 'string' }
  if (flags & ts.TypeFlags.Number) return { type: 'number' }
  if (flags & ts.TypeFlags.BigInt) return { type: 'integer', 'x-ts-type': 'bigint' }
  if (flags & ts.TypeFlags.TemplateLiteral) {
    return { type: 'string', 'x-ts-type': typeText(ctx, type) }
  }

  // Named, project-declared types become `$defs` entries referenced by `$ref`;
  // this is checked before union/object expansion so an aliased union
  // (`RightPanelMode`) and an enum are published once under their own name.
  const named = nameableSymbol(ctx, type)
  if (named) {
    const name = defName(ctx, type, named)
    if (!ctx.defs.has(name)) {
      ctx.defs.set(name, { 'x-pending': true })
      const expanded = expandType({ ...ctx, depth: ctx.depth + 1 }, type)
      const description = symbolDescription(named, ctx.checker)
      ctx.defs.set(name, description === undefined ? expanded : { description, ...expanded })
    }
    return { $ref: `#/$defs/${name}` }
  }
  return expandType({ ...ctx, depth: ctx.depth + 1 }, type)
}

/** Structural expansion (no naming) — the body of a def or an anonymous type. */
function expandType(ctx: SchemaContext, type: ts.Type): JsonSchema {
  if (type.isUnion()) return unionSchema(ctx, type)
  if (type.isIntersection()) {
    return { allOf: type.types.map((member) => typeToSchema(ctx, member)) }
  }
  if (type.flags & ts.TypeFlags.EnumLiteral) {
    const literal = literalSchema(type)
    if (literal) return literal
  }
  if (!isObjectType(type)) return { 'x-ts-type': typeText(ctx, type) }

  const symbol = type.getSymbol()
  const symbolName = symbol?.name ?? ''
  if (BINARY_TYPES.has(symbolName)) {
    return { type: 'string', contentEncoding: 'base64', 'x-ts-type': symbolName }
  }
  if (symbolName === 'Date') return { type: 'string', format: 'date-time', 'x-ts-type': 'Date' }
  const promised = unwrapPromise(ctx, type)
  if (promised) return typeToSchema(ctx, promised)

  if (isTypeReference(type) && ctx.checker.isTupleType(type) && isTupleTarget(type.target)) {
    return tupleSchema(ctx, type, type.target)
  }
  if (ctx.checker.isArrayType(type)) {
    const [item] = typeArguments(ctx.checker, type)
    return { type: 'array', items: item ? typeToSchema(ctx, item) : {} }
  }
  if (ctx.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) {
    // A function has no wire representation; record the fact and the shape so
    // a change to it still shows up in the frozen document.
    return { 'x-ts-type': typeText(ctx, type), 'x-unrepresentable': 'function' }
  }
  const decl = symbol?.declarations?.[0]
  if (OPAQUE_LIB_TYPES.has(symbolName) && decl && isLibDeclaration(ctx, decl)) {
    return { 'x-ts-type': typeText(ctx, type), 'x-unrepresentable': symbolName }
  }
  return objectSchema(ctx, type)
}

// ── The preload's channel bindings ───────────────────────────────────────────

export interface Binding {
  op: 'invoke' | 'send' | 'on'
  channel: string
  /** Whether the call forwards the enclosing method's parameters verbatim. */
  passThrough: boolean
}

export interface PreloadMethodBinding {
  /** Literal-channel `ipcRenderer` calls inside the method body. */
  bindings: Binding[]
  /** For subscriptions: the listener forwards its payload to the handler verbatim. */
  listenerPassThrough: boolean
}

type FunctionLike = ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration

/** Placeholder for a call argument that is not a plain identifier. */
const NOT_AN_IDENTIFIER = '<expression>'

function unwrapTypeWrappers(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isSatisfiesExpression(current) || ts.isAsExpression(current)) {
    current = current.expression
  }
  return current
}

/** The object literal a top-level `const <name> = {...}` initialises, if any. */
function findTopLevelObject(
  source: ts.SourceFile,
  name: string,
): ts.ObjectLiteralExpression | undefined {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== name || !decl.initializer) continue
      const init = unwrapTypeWrappers(decl.initializer)
      if (ts.isObjectLiteralExpression(init)) return init
    }
  }
  return undefined
}

/**
 * The object the preload exposes as `window.api`: either passed inline to
 * `exposeInMainWorld('api', {...})` or bound first to a typed `const api`.
 */
function findApiObjectLiteral(source: ts.SourceFile): ts.ObjectLiteralExpression {
  const visit = (node: ts.Node): ts.ObjectLiteralExpression | undefined => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'exposeInMainWorld' &&
      node.arguments.length === 2
    ) {
      const [name, arg] = node.arguments
      if (name && arg && ts.isStringLiteral(name) && name.text === 'api') {
        const literal = unwrapTypeWrappers(arg)
        if (ts.isObjectLiteralExpression(literal)) return literal
        if (ts.isIdentifier(literal)) return findTopLevelObject(source, literal.text)
      }
    }
    return ts.forEachChild(node, visit)
  }
  const found = visit(source)
  if (!found) throw new Error(`${PRELOAD}: could not find exposeInMainWorld('api', {...})`)
  return found
}

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  const name = node.name
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  return null
}

/** The `{ name: <fn> | {...} }` members of an object literal in the preload. */
function preloadMembers(
  literal: ts.ObjectLiteralExpression,
): Map<string, ts.ObjectLiteralExpression | FunctionLike> {
  const out = new Map<string, ts.ObjectLiteralExpression | FunctionLike>()
  for (const prop of literal.properties) {
    const name = propertyName(prop)
    if (name === null) continue
    if (ts.isPropertyAssignment(prop)) {
      const init = unwrapTypeWrappers(prop.initializer)
      if (ts.isObjectLiteralExpression(init)) out.set(name, init)
      else if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) out.set(name, init)
    } else if (ts.isMethodDeclaration(prop)) {
      out.set(name, prop)
    }
  }
  return out
}

function parameterNames(fn: ts.SignatureDeclarationBase): string[] {
  return fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : NOT_AN_IDENTIFIER))
}

function identifierNames(args: ts.NodeArray<ts.Expression>): string[] {
  return args.map((arg) => (ts.isIdentifier(arg) ? arg.text : NOT_AN_IDENTIFIER))
}

function sameNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i])
}

/** Every literal-channel `ipcRenderer.invoke/send/on` call inside a method body. */
function collectBindings(fn: FunctionLike): Binding[] {
  const bindings: Binding[] = []
  const params = parameterNames(fn)
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'ipcRenderer'
    ) {
      const op = node.expression.name.text
      const [channel, ...rest] = node.arguments
      if ((op === 'invoke' || op === 'send' || op === 'on') && channel) {
        if (!ts.isStringLiteral(channel)) {
          throw new Error(
            `${PRELOAD}: non-literal ipcRenderer.${op}( channel at offset ${String(node.pos)}`,
          )
        }
        const forwarded = rest.map((arg) => (ts.isIdentifier(arg) ? arg.text : NOT_AN_IDENTIFIER))
        const passThrough = op === 'on' || sameNames(forwarded, params)
        bindings.push({ op, channel: channel.text, passThrough })
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(fn, visit)
  return bindings
}

function findLocalInitializer(fn: FunctionLike, name: string): ts.Expression | undefined {
  const visit = (node: ts.Node): ts.Expression | undefined => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      return node.initializer
    }
    return ts.forEachChild(node, visit)
  }
  return ts.forEachChild(fn, visit)
}

function findCallTo(body: ts.Node, callee: string): ts.CallExpression | undefined {
  const visit = (node: ts.Node): ts.CallExpression | undefined => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === callee) return node
    }
    return ts.forEachChild(node, visit)
  }
  return visit(body)
}

/**
 * For a subscription (`on`), whether the listener forwards its event payload
 * to the handler unchanged: `(_e, a, b) => handler(a, b)`. When it reshapes
 * the payload the event's wire args cannot be read off the handler's type.
 */
function listenerPassesThrough(fn: FunctionLike): boolean {
  const handlerName = parameterNames(fn)[0]
  if (handlerName === undefined) return false
  const visit = (node: ts.Node): boolean | undefined => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'on' &&
      node.arguments.length >= 2
    ) {
      const listenerArg = node.arguments[1]
      if (!listenerArg) return false
      const listener = ts.isIdentifier(listenerArg)
        ? findLocalInitializer(fn, listenerArg.text)
        : listenerArg
      if (!listener || !(ts.isArrowFunction(listener) || ts.isFunctionExpression(listener))) {
        return false
      }
      const call = findCallTo(listener.body, handlerName)
      if (!call) return false
      return sameNames(identifierNames(call.arguments), parameterNames(listener).slice(1))
    }
    return ts.forEachChild(node, visit)
  }
  return ts.forEachChild(fn, visit) ?? false
}

/**
 * Every `namespace.method` the preload's `window.api` object defines, with the
 * channels it binds. Exported for the unit tests, which feed it synthetic
 * preload sources to pin the pass-through rules.
 */
export function analyzePreloadApi(source: ts.SourceFile): Map<string, PreloadMethodBinding> {
  const out = new Map<string, PreloadMethodBinding>()
  for (const [ns, nsLiteral] of preloadMembers(findApiObjectLiteral(source))) {
    if (!ts.isObjectLiteralExpression(nsLiteral)) continue
    for (const [method, impl] of preloadMembers(nsLiteral)) {
      if (ts.isObjectLiteralExpression(impl)) continue
      out.set(`${ns}.${method}`, {
        bindings: collectBindings(impl),
        listenerPassThrough: listenerPassesThrough(impl),
      })
    }
  }
  return out
}

export function analyzePreloadSource(text: string): Map<string, PreloadMethodBinding> {
  return analyzePreloadApi(ts.createSourceFile('preload.ts', text, ts.ScriptTarget.ES2022, true))
}

// ── ApiClient (the client facade) ────────────────────────────────────────────

function signatureParams(ctx: SchemaContext, sig: ts.Signature): JsonSchema {
  const prefixItems: JsonSchema[] = []
  let required = 0
  let rest: JsonSchema | null = null
  for (const param of sig.getParameters()) {
    const decl = param.valueDeclaration
    const type = decl
      ? ctx.checker.getTypeOfSymbolAtLocation(param, decl)
      : ctx.checker.getTypeOfSymbol(param)
    const paramDecl = decl && ts.isParameter(decl) ? decl : undefined
    if (paramDecl?.dotDotDotToken) {
      const [item] = ctx.checker.isArrayType(type) ? typeArguments(ctx.checker, type) : []
      rest = withTitle(item ? typeToSchema(ctx, item) : {}, param.name)
      continue
    }
    const optional =
      (paramDecl !== undefined && ctx.checker.isOptionalParameter(paramDecl)) ||
      (param.flags & ts.SymbolFlags.Optional) !== 0
    const schema = withTitle(stripOptional(typeToSchema(ctx, type)), param.name)
    if (!optional) required = prefixItems.length + 1
    prefixItems.push(schema)
  }
  return arraySchema(prefixItems, required, rest)
}

function isVoidLike(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0
}

function describeMethod(
  ctx: SchemaContext,
  member: ts.Symbol,
  bound: PreloadMethodBinding | undefined,
): ApiClientMethod {
  const decl = member.valueDeclaration ?? member.declarations?.[0]
  if (!decl) throw new Error(`ApiClient member ${member.name} has no declaration`)
  let type = ctx.checker.getTypeOfSymbolAtLocation(member, decl)
  if (member.flags & ts.SymbolFlags.Optional) type = ctx.checker.getNonNullableType(type)
  const [sig] = ctx.checker.getSignaturesOfType(type, ts.SignatureKind.Call)
  if (!sig) throw new Error(`ApiClient member ${member.name} is not a function`)
  const returnType = ctx.checker.getReturnTypeOfSignature(sig)
  const params = sig.getParameters()
  const bindings = bound?.bindings ?? []

  const on = bindings.find((b) => b.op === 'on')
  const invoke = bindings.find((b) => b.op === 'invoke')
  const send = bindings.find((b) => b.op === 'send')
  const description = symbolDescription(member, ctx.checker)
  const base: ApiClientMethod = { kind: 'sync', channel: null }
  if (member.flags & ts.SymbolFlags.Optional) base.optional = true
  if (description !== undefined) base.description = description

  // subscribe: `(handler: (...payload) => R) => () => void`
  const returnSigs = ctx.checker.getSignaturesOfType(returnType, ts.SignatureKind.Call)
  const firstParam = params[0]
  const firstParamType = firstParam?.valueDeclaration
    ? ctx.checker.getTypeOfSymbolAtLocation(firstParam, firstParam.valueDeclaration)
    : null
  const handlerSig = firstParamType
    ? ctx.checker.getSignaturesOfType(firstParamType, ts.SignatureKind.Call)[0]
    : undefined
  if (returnSigs.length > 0 && params.length === 1 && handlerSig) {
    const method: ApiClientMethod = { ...base, kind: 'subscribe', channel: on?.channel ?? null }
    method.handlerParams = signatureParams(ctx, handlerSig)
    const handlerReturn = ctx.checker.getReturnTypeOfSignature(handlerSig)
    if (!isVoidLike(handlerReturn)) method.handlerResult = typeToSchema(ctx, handlerReturn)
    if (on && !(bound?.listenerPassThrough ?? false)) method['x-args-transformed'] = true
    return method
  }

  const promised = unwrapPromise(ctx, returnType)
  if (promised) {
    const method: ApiClientMethod = { ...base, kind: 'invoke', channel: invoke?.channel ?? null }
    method.params = signatureParams(ctx, sig)
    method.result = typeToSchema(ctx, promised)
    if (invoke && !invoke.passThrough) method['x-args-transformed'] = true
    return method
  }

  if (isVoidLike(returnType)) {
    const via = send ?? invoke
    const method: ApiClientMethod = { ...base, kind: 'send', channel: via?.channel ?? null }
    method.params = signatureParams(ctx, sig)
    if (via && !via.passThrough) method['x-args-transformed'] = true
    return method
  }

  const method: ApiClientMethod = { ...base, kind: 'sync', channel: invoke?.channel ?? null }
  method.params = signatureParams(ctx, sig)
  method.result = typeToSchema(ctx, returnType)
  return method
}

// ── Document assembly ────────────────────────────────────────────────────────

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)))
}

/**
 * Build the protocol document from the current sources. Deterministic: every
 * map is emitted sorted by key, so reordering members in `api.d.ts` does not
 * count as a protocol change while renaming or retyping one does.
 */
export function generateApiProtocol(options: GenerateOptions): ApiProtocolDocument {
  const root = resolve(options.root ?? '.')
  const program = createProgram(root)
  const checker = program.getTypeChecker()
  const apiSource = program.getSourceFile(resolve(root, API_D_TS))
  const preloadSource = program.getSourceFile(resolve(root, PRELOAD))
  if (!apiSource || !preloadSource) throw new Error('protocol sources are not in the program')

  const apiDecl = apiSource.statements.find(
    (s): s is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(s) && s.name.text === 'ApiClient',
  )
  if (!apiDecl) throw new Error(`${API_D_TS}: no ApiClient interface`)
  const apiType = checker.getTypeAtLocation(apiDecl)

  const ctx: SchemaContext = {
    program,
    checker,
    root,
    defs: new Map(),
    nameOf: new Map(),
    depth: 0,
  }
  const preloadApi = analyzePreloadApi(preloadSource)

  const client: ApiProtocolDocument['client'] = {}
  const channels: ApiProtocolDocument['channels'] = { invoke: {}, send: {}, event: {} }
  const openArgs: JsonSchema = { type: 'array', 'x-args-transformed': true }

  for (const namespace of checker.getPropertiesOfType(apiType)) {
    const nsDecl = namespace.valueDeclaration ?? namespace.declarations?.[0]
    if (!nsDecl) continue
    const nsType = checker.getTypeOfSymbolAtLocation(namespace, nsDecl)
    const methods: Record<string, ApiClientMethod> = {}
    for (const member of checker.getPropertiesOfType(nsType)) {
      const api = `${namespace.name}.${member.name}`
      const method = describeMethod(ctx, member, preloadApi.get(api))
      methods[member.name] = method
      if (method.channel === null) continue
      const transformed = method['x-args-transformed'] === true
      if (method.kind === 'subscribe') {
        channels.event[method.channel] = {
          'x-api': api,
          args: transformed ? openArgs : (method.handlerParams ?? {}),
        }
      } else if (method.kind === 'send') {
        channels.send[method.channel] = {
          'x-api': api,
          args: transformed ? openArgs : (method.params ?? {}),
        }
      } else {
        const entry: ApiChannel = {
          'x-api': api,
          args: transformed ? openArgs : (method.params ?? {}),
        }
        if (method.result) entry.result = method.result
        channels.invoke[method.channel] = entry
      }
    }
    client[namespace.name] = sortedRecord(methods)
  }

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Copse renderer API protocol',
    description:
      'The renderer ↔ main API surface (ApiClient in src/preload/api.d.ts) and the IPC channels ' +
      'the preload binds it to. Generated by scripts/gen-api-protocol.mts; do not edit by hand.',
    version: options.version,
    channels: {
      invoke: sortedRecord(channels.invoke),
      send: sortedRecord(channels.send),
      event: sortedRecord(channels.event),
    },
    client: sortedRecord(client),
    $defs: sortedRecord(Object.fromEntries(ctx.defs)),
  }
}

export function serializeApiProtocol(doc: ApiProtocolDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

/** Parse a serialized document, validating the fields the tooling reads. */
export function parseApiProtocol(text: string): ApiProtocolDocument {
  const parsed = apiProtocolDocumentSchema.safeParse(JSON.parse(text))
  if (!parsed.success) throw new Error(`not an API protocol document: ${parsed.error.message}`)
  return parsed.data
}

// ── Compatibility classification ─────────────────────────────────────────────

export interface ApiProtocolDiff {
  /** Channels or client methods removed, or whose shape changed. */
  breaking: string[]
  /** Channels or client methods that only appeared. */
  additive: string[]
}

/** Inline every `$ref` so two documents compare by shape, not by def naming. */
function resolveRefs(doc: ApiProtocolDocument, value: unknown, seen: string[]): unknown {
  if (Array.isArray(value)) return value.map((entry: unknown) => resolveRefs(doc, entry, seen))
  if (!isRecord(value)) return value
  const ref = value['$ref']
  if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
    const name = ref.slice('#/$defs/'.length)
    if (seen.includes(name)) return { 'x-recursive': name }
    return resolveRefs(doc, doc.$defs[name] ?? { 'x-missing-def': name }, [...seen, name])
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, resolveRefs(doc, entry, seen)]),
  )
}

function shapeOf(doc: ApiProtocolDocument, value: unknown): string {
  return stableStringify(resolveRefs(doc, value, []))
}

/**
 * Classify the change from `before` to `after`. Anything that would break a
 * client built against `before` — a removed channel or method, or a changed
 * argument/result shape — is breaking and needs a version bump; new channels
 * and methods are additive. Def renames alone are neither (refs are inlined).
 */
export function compareApiProtocol(
  before: ApiProtocolDocument,
  after: ApiProtocolDocument,
): ApiProtocolDiff {
  const breaking: string[] = []
  const additive: string[] = []
  for (const kind of ['invoke', 'send', 'event'] as const) {
    const prev = before.channels[kind]
    const next = after.channels[kind]
    for (const [channel, entry] of Object.entries(prev)) {
      const label = `channels.${kind}.${channel}`
      const nextEntry = next[channel]
      if (!nextEntry) breaking.push(`${label}: removed`)
      else if (shapeOf(before, entry) !== shapeOf(after, nextEntry)) {
        breaking.push(`${label}: shape changed`)
      }
    }
    for (const channel of Object.keys(next)) {
      if (!(channel in prev)) additive.push(`channels.${kind}.${channel}: added`)
    }
  }
  for (const [ns, methods] of Object.entries(before.client)) {
    for (const [name, method] of Object.entries(methods)) {
      const label = `client.${ns}.${name}`
      const nextMethod = after.client[ns]?.[name]
      if (!nextMethod) breaking.push(`${label}: removed`)
      else if (shapeOf(before, method) !== shapeOf(after, nextMethod)) {
        breaking.push(`${label}: shape changed`)
      }
    }
  }
  for (const [ns, methods] of Object.entries(after.client)) {
    for (const name of Object.keys(methods)) {
      if (!before.client[ns]?.[name]) additive.push(`client.${ns}.${name}: added`)
    }
  }
  return { breaking: breaking.sort(), additive: additive.sort() }
}
