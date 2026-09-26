# Third-party notices

Copse is licensed under AGPL-3.0-only. It also bundles or optionally loads
third-party components whose licenses require attribution. Those are listed here.

## The complete list ships with the app

Every build generates the full notice set from what it actually ships
(`scripts/write-third-party-licenses.mts`): packages esbuild compiles into the
bundles (read from the esbuild metafiles), the production `node_modules`
electron-builder copies into app.asar, and the vendored components (these fonts,
the gortex binary and the Go modules compiled into it, the Cursor skills snapshot,
copied source, and the Electron runtime). The build fails if any of them lacks its
licence text or is GPL-family only, and packaging (`scripts/after-pack.cjs`)
checks the real archive again. In the app the files are in
`Copse.app/Contents/Resources/app.asar.unpacked/dist/resources/licenses/`
(`THIRD_PARTY_LICENSES.txt`, `LICENSES.chromium.html.gz` for Chromium and Node.js,
and `LICENSE.txt`), and **Settings → About** lists every component with its
licence.

## Copse interface fonts

- **Pliant:** Jona Saucedo / Non Foundry — bundled as the interface and body
  typeface from the Google Fonts distribution.
- **Averia Serif Libre:** Dan Sayers — bundled as the display and heading
  typeface from the Google Fonts distribution.
- **License:** SIL Open Font License 1.1. The complete license texts are bundled
  in `assets/fonts/OFL-Pliant.txt` and
  `assets/fonts/OFL-Averia-Serif-Libre.txt`.
- **Modifications:** none.

## Rampart (@nationaldesignstudio/rampart)

- **Project:** Rampart — client-side PII detection and redaction.
- **Author:** National Design Studio.
- **Source:** https://github.com/nationaldesignstudio/rampart
- **License:** Creative Commons Attribution 4.0 International (CC BY 4.0) —
  https://creativecommons.org/licenses/by/4.0/
- **Used by:** the experimental on-device PII redaction feature
  (`src/main/services/security/pii-redactor.ts`). Optional dependency; loaded
  only when the user enables the PII redaction plugin in Settings → Plugins.
- **Modifications:** none. The package and its model are used as published.

CC BY 4.0 is a permissive, attribution-only license. It is not copyleft, and the
FSF lists it as compatible with GPLv3, so it may be combined into Copse's
AGPL-3.0-only work. It only obliges us to credit the author, link the license,
and note any changes — which this notice does.

## noVNC (@novnc/novnc)

- **Project:** noVNC — an HTML5 Remote Framebuffer (VNC) client.
- **Authors:** the noVNC authors.
- **Source:** https://github.com/novnc/noVNC
- **License:** Mozilla Public License 2.0 (MPL-2.0) —
  https://www.mozilla.org/MPL/2.0/
- **Used by:** the opt-in, read-only Remote Desktop pane. Copse supplies an
  IPC-backed channel; noVNC decodes and paints the RFB stream in the renderer.
- **Modifications:** none. Version 1.7.0 is bundled as published.

The MPL applies at file level to noVNC's own files and does not change Copse's
AGPL-3.0-only license. noVNC's sources carry no "Incompatible With Secondary
Licenses" notice, so MPL-2.0 section 3.3 permits distributing it as part of a
Larger Work under the GNU licenses. The build compiles noVNC into the renderer
bundle, so the packaged app does not contain the npm package or its license
file. As MPL-2.0 section 3.2 requires, this notice tells recipients of the app
where to get noVNC's source code: the unmodified upstream release linked above.

## Forge (node-forge)

- **Project:** Forge — a native JavaScript implementation of TLS and related
  cryptography tools.
- **Author:** Digital Bazaar, Inc.
- **Source:** https://github.com/digitalbazaar/forge
- **License:** dual-licensed `(BSD-3-Clause OR GPL-2.0)`. **Copse elects the
  BSD-3-Clause option** and does not distribute Forge under GPL-2.0.
- **Used by:** `@anthropic-ai/sandbox-runtime`, a runtime dependency. The
  sandbox's network proxy uses Forge to create its local TLS certificate
  authority and leaf certificates. Shipped in the app archive under
  `node_modules/node-forge/`.
- **Modifications:** none. Version 1.4.0 is shipped as published.

Under the BSD-3-Clause option, Copse keeps Digital Bazaar's copyright notice,
license conditions, and disclaimer. They ship with the package in
`node_modules/node-forge/LICENSE`. Copse does not use Digital Bazaar's name to
endorse or promote itself. The GPL-2.0 option is not used: GPL-2.0-only is not
compatible with Copse's AGPL-3.0-only license or with a proprietary license.

## Not shipped: sharp and libvips

`pnpm licenses list --prod` reports `sharp` (Apache-2.0) and its native
`@img/sharp-libvips-*` packages (LGPL-3.0-or-later). **Neither ships in the
packaged app**, so they do not need a notice here. They appear in the report
because of this dependency chain:

- `@nationaldesignstudio/rampart` is an optional dependency that ships.
- Rampart declares `@huggingface/transformers` only as an _optional peer_
  dependency. It has no `dependencies` or `optionalDependencies` of its own.
- pnpm auto-installs that optional peer, and `@huggingface/transformers`
  depends on `sharp` and `onnxruntime-node`. pnpm counts that chain as
  production, but electron-builder does not follow peer dependencies when it
  collects `node_modules` into the app archive.

Evidence: the 0.1.0-beta.8 release archive (`Copse.app/Contents/Resources/app.asar`
and `app.asar.unpacked`) contains Rampart but no `sharp`, `@img/*`,
`@huggingface/transformers`, or `onnxruntime-*` files. Since that release the
`build` configuration, `optionalDependencies`, and Rampart's resolution have not
changed in any way that affects this. The 0.1.0-beta.6 release notes and
[`docs/pii-redaction.md`](docs/pii-redaction.md) record removing the
Transformers/ONNX runtime from the base installer on purpose, and
`scripts/release-package-invariants.test.ts` fails if
`@huggingface/transformers` is added back as a direct optional dependency.

If a future change bundles the contextual PII model (for example, by adding
`@huggingface/transformers` as a direct dependency or listing it in `asarUnpack`),
this section must become a full entry before release. LGPL-3.0 section 4 would
then require all of the following: libvips must stay a separately loaded shared
library that the user can replace, its license text must ship with the app, and
this file must include a source offer for it.
