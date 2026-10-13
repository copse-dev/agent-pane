# Screenshot storage in R2

Git tracks `tests/e2e/screenshots/manifest.json`, not reference PNGs. Each entry
records a SHA-256 hash and byte length. Its immutable public object is
`screenshots/sha256/<hash>.png`; identical images share an object. Keep objects
referenced by older manifests so historical review and flap detection still work.

## Reads and tests

Public reads require no credentials or AWS CLI. The default bucket URL is
`https://pub-7ec931b58a7b480ba1cd3e535dc12f3c.r2.dev`.
`SCREENSHOT_R2_PUBLIC_URL` can override it with another HTTPS public endpoint.

WebdriverIO and the e2e runner hydrate references before running tests. Missing
files are restored from the manifest; existing rendered candidates are preserved.
Every download and cache hit is checked against its hash and byte length. The
ignored `.cache/screenshots/sha256` cache deduplicates reads. Downloads run four
at a time and report progress. CI caches these immutable objects and requires a
separate baseline hydration/check job, including for screenshot-only changes.

The noise filter compares per-image manifest hashes and prepares historical R2
objects before classifying candidates. Older commits that still contain PNGs
remain readable from Git. Reference PNGs in the working tree are ignored.

## Upload credentials

Uploads require a bucket-scoped R2 Object Read & Write token's **S3 access key ID**
and **secret access key**. The Cloudflare API “Token value” is not used. Store these
in GitHub Actions secrets, never in Git:

```text
SCREENSHOT_R2_ACCOUNT_ID=<Cloudflare account ID>
SCREENSHOT_R2_ACCESS_KEY_ID=<R2 S3 access key ID>
SCREENSHOT_R2_SECRET_ACCESS_KEY=<R2 S3 secret access key>
```

The account ID also accepts a repository variable. The bucket defaults to
`copse-screenshots`, overridable with `SCREENSHOT_R2_BUCKET`. Local uploads need
these environment variables and AWS CLI v2 with conditional put-object support.
Uploads use conditional writes and verify each object's S3 bytes. They run four
AWS processes at a time, with progress and a three-minute command timeout.

## CI review and acceptance

CI collects changed rendered PNGs as an artifact. The trusted candidate publisher
validates the artifact, builds the new hashes, uploads and verifies its R2 objects,
and then publishes a compare commit containing only manifest updates and any
corresponding README screenshot URL replacement. R2 credentials are scoped to
that upload step. Pull-request code and dependency installation do not receive
them; policy scripts come from the trusted workflow revision.

The parent PR comment shows immutable R2 before/after previews. Accept-all and
checkbox selection retain their head, permission, and compare-tree checks.
Selection commits only the selected entries, preserving the remaining baselines.
For manual acceptance of a reviewed subset:

```bash
git fetch origin screenshot-compare/pr-<N>/<sha12>
pnpm screenshots:accept --from FETCH_HEAD <name>.png <other-name>.png
# Inspect, then commit the manifest and README changes.
```

Manual acceptance verifies selected public objects before updating metadata.
The storage workflow verifies accepted manifests on main. Its manual `upload`
operation hydrates the selected manifest before uploading; `verify` needs no
upload credentials. The manifest is authoritative and is not regenerated on main.

## Local commands

```bash
pnpm screenshots:hydrate  # Restore missing references; verify cached/downloaded bytes
pnpm screenshots:changed # List rendered PNGs that differ from the committed hashes
pnpm screenshots:manifest # Merge rendered hashes into the manifest; update README image URL
pnpm screenshots:check   # Check all local files against the manifest
pnpm screenshots:upload  # Upload immutable objects and verify their S3 bytes
pnpm screenshots:verify  # Verify every public R2 object without changing local PNGs
```

For a locally accepted update, hydrate, run the focused tests and noise filter,
inspect the images, refresh the manifest, upload, then commit metadata. Missing
local files do not delete manifest entries. Never commit the ignored PNGs.

## Git cleanup

The cutover untracks reference PNGs without changing their pixels. Application
assets and image fixtures remain in Git. This removes PNGs from future commits;
it does not reduce existing Git history. A historical blob purge is a separate,
coordinated history rewrite affecting commit IDs, existing branches, and clones.
