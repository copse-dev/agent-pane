## Risk-rating calibration: posted

Ratings from posted; truth from verified outcomes within 7 days of merge (eval v1).
Scored 43; unrated 38; awaiting verdicts 0.

### All scored cases (43 cases)

| predicted ↓ / truth → | low | medium | high |
| --------------------- | --: | -----: | ---: |
| low | 10 | 0 | 0 |
| medium | 19 | 2 | 0 |
| high | 11 | 0 | 1 |

- Exact: 13 (30%); over-rated: 30 (70%); under-rated: 0 (0%).
- Changes that caused a regression: 1; rated below High: 0.

### Mature cases (full 7-day window) (0 cases)

| predicted ↓ / truth → | low | medium | high |
| --------------------- | --: | -----: | ---: |
| low | 0 | 0 | 0 |
| medium | 0 | 0 | 0 |
| high | 0 | 0 | 0 |

- Exact: 0 (n/a); over-rated: 0 (n/a); under-rated: 0 (n/a).
- Changes that caused a regression: 0; rated below High: 0.

### Rating by change size (source lines)

| size | rated low | rated medium | rated high | truth low | truth medium | truth high |
| ---- | --------: | -----------: | ---------: | --------: | -----------: | ---------: |
| small | 10 | 11 | 2 | 22 | 1 | 0 |
| medium | 0 | 9 | 7 | 15 | 0 | 1 |
| large | 0 | 1 | 3 | 3 | 1 | 0 |

### High-risk rubric clauses cited in the reason

| clause | cited | rated high | over-rated | under-rated | small changes |
| ------ | ----: | ---------: | ---------: | ----------: | ------------: |
| cross-cutting | 13 | 4 | 11 | 0 | 2 |
| process-ipc | 12 | 6 | 11 | 0 | 3 |
| dependency-build | 12 | 7 | 8 | 0 | 7 |
| permissions-sandboxing | 11 | 4 | 7 | 0 | 6 |
| persisted-data | 7 | 4 | 6 | 0 | 2 |
| auth-secrets | 4 | 3 | 4 | 0 | 2 |
| security | 2 | 2 | 2 | 0 | 0 |
| concurrency | 1 | 0 | 1 | 0 | 1 |

### Cases

| PR | rated | truth | size | clauses | outcome |
| -- | ----- | ----- | ---- | ------- | ------- |
| #3079 | high ↑ | low (immature) | 289 | persisted-data, process-ipc | — |
| #3097 | medium ↑ | low (immature) | 56 | cross-cutting | — |
| #3106 | low | low (immature) | 0 | permissions-sandboxing | — |
| #3121 | medium ↑ | low (immature) | 416 | process-ipc | — |
| #3123 | medium ↑ | low (immature) | 204 | cross-cutting | — |
| #3124 | medium ↑ | low (immature) | 57 | — | — |
| #3128 | medium | medium (immature) | 583 | permissions-sandboxing, cross-cutting | reference #3227 |
| #3129 | medium ↑ | low (immature) | 239 | — | — |
| #3130 | medium ↑ | low (immature) | 346 | cross-cutting | — |
| #3132 | medium ↑ | low (immature) | 465 | cross-cutting | — |
| #3133 | low | low (immature) | 0 | — | — |
| #3135 | medium ↑ | low (immature) | 385 | cross-cutting | — |
| #3137 | medium ↑ | low (immature) | 222 | process-ipc, cross-cutting | — |
| #3144 | high ↑ | low (immature) | 109 | persisted-data, process-ipc | — |
| #3145 | high ↑ | low (immature) | 382 | process-ipc, cross-cutting | — |
| #3181 | medium | medium (immature) | 85 | permissions-sandboxing, process-ipc, cross-cutting | reference #3247 |
| #3184 | high ↑ | low (immature) | 133 | security, dependency-build, cross-cutting | — |
| #3189 | low | low (immature) | 0 | — | — |
| #3190 | high ↑ | low (immature) | 1502 | security, auth-secrets, dependency-build, cross-cutting | — |
| #3191 | medium ↑ | low (immature) | 82 | permissions-sandboxing | — |
| #3192 | medium ↑ | low (immature) | 0 | — | — |
| #3193 | low | low (immature) | 5 | — | — |
| #3195 | medium ↑ | low (immature) | 77 | process-ipc | — |
| #3202 | high ↑ | low (immature) | 30 | permissions-sandboxing, auth-secrets, dependency-build | — |
| #3207 | medium ↑ | low (immature) | 154 | process-ipc | — |
| #3208 | high ↑ | low (immature) | 190 | persisted-data, process-ipc, cross-cutting | — |
| #3209 | low | low (immature) | 0 | — | — |
| #3210 | medium ↑ | low (immature) | 8 | — | — |
| #3211 | low | low (immature) | 5 | persisted-data | — |
| #3212 | medium ↑ | low (immature) | 108 | permissions-sandboxing, persisted-data, cross-cutting | — |
| #3213 | low | low (immature) | 0 | dependency-build | — |
| #3214 | low | low (immature) | 0 | — | — |
| #3215 | high ↑ | low (immature) | 367 | auth-secrets, persisted-data, process-ipc, dependency-build | — |
| #3228 | medium ↑ | low (immature) | 81 | auth-secrets, dependency-build | — |
| #3229 | low | low (immature) | 0 | dependency-build | — |
| #3230 | high ↑ | low (immature) | 4 | dependency-build | — |
| #3231 | high | high (immature) | 209 | permissions-sandboxing, dependency-build | reference #3246; reference #3235; reference #3234 |
| #3234 | medium ↑ | low (immature) | 17 | permissions-sandboxing, dependency-build | — |
| #3237 | low | low (immature) | 0 | dependency-build | — |
| #3244 | medium ↑ | low (immature) | 22 | concurrency | — |
| #3246 | high ↑ | low (immature) | 1015 | permissions-sandboxing, dependency-build | — |
| #3248 | high ↑ | low (immature) | 568 | permissions-sandboxing, process-ipc | — |
| #3250 | medium ↑ | low (immature) | 13 | permissions-sandboxing, persisted-data, process-ipc | — |

### What predicts outcomes: mature (full 7-day window), 38 cases (no rater involved)

| changes that… | cases | truth low | truth medium | truth high | medium or high |
| ------------- | ----: | --------: | -----------: | ---------: | -------------: |
| all | 38 | 27 | 7 | 4 | 29% |
| touches no high-risk surface | 16 | 11 | 4 | 1 | 31% |
| touches a high-risk surface | 22 | 16 | 3 | 3 | 27% |
|   security | 5 | 3 | 1 | 1 | 40% |
|   permissions-sandboxing | 4 | 2 | 1 | 1 | 50% |
|   auth-secrets | 2 | 1 | 0 | 1 | 50% |
|   persisted-data | 5 | 4 | 0 | 1 | 20% |
|   process-ipc | 12 | 8 | 3 | 1 | 33% |
|   dependency-build | 8 | 7 | 0 | 1 | 13% |
|   cross-cutting | 11 | 7 | 1 | 3 | 36% |
| small (source lines) | 14 | 10 | 4 | 0 | 29% |
| medium (source lines) | 17 | 10 | 3 | 4 | 41% |
| large (source lines) | 7 | 7 | 0 | 0 | 0% |
| mostly additive | 27 | 18 | 5 | 4 | 33% |
| rewrites existing code (≥25% deletions) | 11 | 9 | 2 | 0 | 18% |
| touches a surface, under 100 source lines | 3 | 3 | 0 | 0 | 0% |
| touches a surface, 100 or more source lines | 19 | 13 | 3 | 3 | 32% |

### What predicts outcomes: all merged, 81 cases (no rater involved)

| changes that… | cases | truth low | truth medium | truth high | medium or high |
| ------------- | ----: | --------: | -----------: | ---------: | -------------: |
| all | 81 | 67 | 9 | 5 | 17% |
| touches no high-risk surface | 41 | 36 | 4 | 1 | 12% |
| touches a high-risk surface | 40 | 31 | 5 | 4 | 23% |
|   security | 7 | 4 | 2 | 1 | 43% |
|   permissions-sandboxing | 9 | 5 | 3 | 1 | 44% |
|   auth-secrets | 4 | 2 | 1 | 1 | 50% |
|   persisted-data | 8 | 7 | 0 | 1 | 13% |
|   process-ipc | 16 | 12 | 3 | 1 | 25% |
|   dependency-build | 16 | 14 | 0 | 2 | 13% |
|   cross-cutting | 15 | 10 | 2 | 3 | 33% |
| small (source lines) | 37 | 32 | 5 | 0 | 14% |
| medium (source lines) | 33 | 25 | 3 | 5 | 24% |
| large (source lines) | 11 | 10 | 1 | 0 | 9% |
| mostly additive | 57 | 46 | 6 | 5 | 19% |
| rewrites existing code (≥25% deletions) | 24 | 21 | 3 | 0 | 13% |
| touches a surface, under 100 source lines | 9 | 8 | 1 | 0 | 11% |
| touches a surface, 100 or more source lines | 31 | 23 | 4 | 4 | 26% |
