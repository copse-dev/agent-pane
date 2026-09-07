# Third-party notices

Copse is licensed under AGPL-3.0-only. It also bundles or optionally loads
third-party components whose licenses require attribution. Those are listed here.

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
  (`src/main/services/pii-redactor.ts`). Optional dependency; loaded only when
  the user enables PII redaction in Settings → Experimental.
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
- **Modifications:** none. Version 1.5.0 is bundled as published.

The MPL applies at file level to noVNC's own files and does not change Copse's
AGPL-3.0-only license. noVNC's sources carry no "Incompatible With Secondary
Licenses" notice, so MPL-2.0 section 3.3 permits distributing it as part of a
Larger Work under the GNU licenses. The package's complete license text ships
with the package.
