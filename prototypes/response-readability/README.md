# Response readability workshop

Standalone comparison workshop. The Reading treatment is now also integrated into
assistant prose in `src/renderer/styles/global/conversation.css`; the other variants
remain examples in this workshop.

Open `prototypes/response-readability/index.html` with Copse's Browser preview.
The page loads local Copse fonts and the actual theme tokens. Its sample messages
are illustrative, not claims about work performed in this repository.

## Compare

- **Current-style:** a static approximation of the previous 960px chat measure,
  15px prose, and 22px leading. It is not a live renderer capture.
- **Reading:** identical text and order, a 720px maximum measure, 16px prose,
  1.65 leading, and clearer section spacing.
- **Structured:** separately authored versions of the same facts. Changes use
  file rows, explanations use a flow, and reviews separate findings by priority.
  This is a content-design example, not an automatic markdown transformation.

Try all three examples, the activity disclosure, light/dark theme, and narrow split.
URLs preserve the example and treatment, e.g. `?example=explain#structured`.

## Design judgment

Reading is the initial product implementation. Its increased vertical space is
covered by the real renderer tests in `tests/demo/chat-reading-layout.demo.ts`,
including long markdown, narrow layouts, interface scale, and composer submission
through streamed tool activity and completion. Keep concise replies concise.

Structured answers are useful when the content has real structure. They need an
explicit authoring contract or a supported renderer surface. Do not infer passed
checks, file modifications, or severity from arbitrary prose. Keep limitations
visible and preserve the original answer for copying and accessibility.

This workshop does not validate streaming, native Electron sizing, arbitrary model
markdown, or automatic conversion. It uses hand-authored HTML specimens.

## Validation

The normal browser test server mounts `/prototypes` plus local styles/fonts.
Run with the repository's pinned Node and pnpm:

```sh
pnpm run test:demo --spec tests/demo/response-readability.demo.ts
```

The spec compares baseline/Reading text, checks actual geometry, drives the
controls and activity disclosure, verifies narrow/light layouts and deep links,
and saves focused screenshots under `tests/e2e/screenshots/response-readability-*.png`.
No demo build is required for this static workshop.
