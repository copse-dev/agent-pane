# Native local-model tool schema rejection

## Task brief and acceptance

A real, read-only Copse Git/CI evaluation using the already-loaded local Qwen model stopped before
any inference or tool calls. The authenticated LM Studio compatible endpoint rejected the tool list
with HTTP 400: tool 37's parameter schema lacked the required object type. Base:
`d57af855e16db5534ae1781317b9ea1e8cc16269`.

Acceptance:

- The actual native tool list has an object parameter envelope after transport normalization.
- A nested union of object alternatives exposes its fields and common requirements without
  changing the original alternatives or caller-owned schema.
- Scalar alternatives and unions nested inside ordinary properties retain their existing behavior.
- Strict-schema qualification still inspects the original union. Execution still validates against
  the original Zod schema; required coordinates and strict unknown-field rejection remain intact.
- The real local-model Git/CI scenario gets beyond request validation and can use native tools.
- Running the scenario must not switch the developer checkout's branch.

## Reproduction and fix

`isolated_copse` combines a `start` object with a discriminated union of screenshot/input/stop
objects. Its generated JSON schema is an `anyOf` containing an object and another `oneOf`.
The transport normalizer only recognized one layer of objects. This one schema therefore poisoned
the entire request, including unrelated Git and CI tools. The registry regression fails on the
original code and identifies `isolated_copse`.

Collect object leaves recursively when inferring a root object envelope. Preserve the original
`anyOf`/`oneOf` structure, union the exposed property alternatives, and keep only requirements common
to every object leaf. Do not infer an object when any nested alternative permits another type.
This adjusts the provider's schema representation; it does not change tool execution, authorization,
VM control or strict-schema qualification.

The first eval also exposed fixture interference: opening an empty project in the current workspace
selected that checkout's default branch. The Git/CI scenario now uses its existing disposable-project
option and copies only the current origin for GitHub resolution, as the CI-diagnosis scenario already
does. It can query remote merge history and CI without activating the developer checkout. A focused
fixture check verifies that the project is separate and retains the origin. No autonomy or permission
mode is broadened.

## Validation

Provider/normalizer, real-registry and scenario checks, standard gates, build and repeated real-model
evaluation results are recorded in the PR. A deterministic schema test alone does not establish
model behavior. Preserve raw eval exports locally and inspect actual tool results and the final answer
before claiming the workflow passed.
