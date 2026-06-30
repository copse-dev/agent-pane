# Third-party notices

Copse is licensed under Apache-2.0. It also bundles or optionally loads
third-party components whose licenses require attribution. Those are listed here.

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

CC BY 4.0 is a permissive, attribution-only license. It is not copyleft and does
not change Copse's own Apache-2.0 license; it only obliges us to credit the
author, link the license, and note any changes — which this notice does.
