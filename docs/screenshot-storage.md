# Screenshot storage in R2

The migration starts with a versioned SHA-256 manifest at
`tests/e2e/screenshots/manifest.json`. Each entry records the PNG's hash and byte
length; its immutable R2 key is `screenshots/sha256/<hash>.png`. Identical PNGs
share one object. Keep objects referenced by older manifests for historical review.

## Current migration stage

The storage commands prepare and verify the R2 copy. PNGs are still tracked:
the existing candidate publication, selection, freshness, ownership, flap detection,
and README workflows currently depend on PNG blobs in Git. Do not remove or ignore
the PNGs until those consumers have migrated. Uploading alone does not change that
contract. No bucket or credentials are embedded in the manifest.

## Configure storage

Install a current AWS CLI v2 with conditional `s3api put-object --if-none-match`
support. Create an R2 bucket named `copse-screenshots` and a bucket-scoped Object Read & Write API token.
Set these variables in your local environment or CI secrets (never commit them):

```text
SCREENSHOT_R2_ACCOUNT_ID=<Cloudflare account ID>
SCREENSHOT_R2_BUCKET=copse-screenshots
SCREENSHOT_R2_ACCESS_KEY_ID=<R2 S3 access key ID>
SCREENSHOT_R2_SECRET_ACCESS_KEY=<R2 S3 secret access key>
```

Uploads use the R2 S3 endpoint and region `auto`. The upload command validates all
local manifest entries before writing, uses conditional writes to preserve existing
hash objects, and downloads each uploaded object to verify its hash and length.
It never removes local files or changes Git's index.

For public reads, enable public access on the bucket and set
`SCREENSHOT_R2_PUBLIC_URL=https://<your bucket's public hostname>.r2.dev`.
No custom domain is required; a public custom domain can also be used. Download and verify
then require no credentials or AWS CLI. Omit the public URL to read privately
through the S3 API with bucket-scoped read credentials. Upload verification always
uses S3, avoiding public cache propagation delays.

## Commands

### GitHub Actions

Store `SCREENSHOT_R2_ACCESS_KEY_ID` and `SCREENSHOT_R2_SECRET_ACCESS_KEY` under
**Settings → Secrets and variables → Actions → Repository secrets**. Store
`SCREENSHOT_R2_ACCOUNT_ID` there too (a repository variable is also supported).
The workflow defaults to bucket `copse-screenshots` and public URL
`https://pub-7ec931b58a7b480ba1cd3e535dc12f3c.r2.dev`; override them with matching
repository secrets or variables if necessary.

The **Screenshot storage** workflow runs automatically when screenshot references
or storage tooling change on `main`. It also supports **Actions → Screenshot storage
→ Run workflow → upload** for a selected branch.
Uploads first generate a fresh manifest from the committed PNGs, check it, upload
each unique object, verify the S3 bytes, and save the manifest as run evidence.
Accepted PNG-only updates are therefore published without a manual dispatch or
manifest refresh. The verified artifact records the manifest for that exact commit;
generation does not commit the manifest back to Git. PNGs remain authoritative
until the review workflow cutover. The job does not delete PNGs.
Choose `verify` to check the public copy later, without passing upload credentials.
The upload job uses the AWS CLI v2 provided by GitHub's hosted Ubuntu runner.

GitHub Actions secrets cannot be read back into a local Codex environment.
Uploads run on GitHub; no local secret copy is needed. The workflow is
triggered only by `main` changes or an explicit dispatch and has read-only Git permissions. R2 upload credentials are scoped to
the preflight and upload steps rather than dependency installation.

### Local commands

```bash
pnpm screenshots:manifest  # Generate a deterministic manifest from local PNGs
pnpm screenshots:check     # Verify local hashes and detect stale/missing entries
pnpm screenshots:upload   # Upload deduplicated immutable objects, then verify
pnpm screenshots:verify   # Verify all remote objects without changing local files
pnpm screenshots:download # Restore missing PNGs and verify their contents
```

Download refuses to overwrite a file whose bytes differ from the manifest, so a
freshly rendered candidate is preserved. All downloads are checked before being
installed. The manifest contains filenames, hashes and lengths, never signed URLs.

## Cutover and Git cleanup

After configuring R2, uploading and verifying every reference, migrate the Git
consumers together: hydrate references in CI, compare manifest entries for screenshot
changes, resolve historical hashes through R2, publish R2 previews, and commit only
selected manifest updates during acceptance. Update README image URLs at cutover.
Then untrack the reference PNGs and ignore the local hydrated copies. Scope cleanup
to reference screenshots; application assets and image fixtures stay in Git.

Untracking removes PNGs from future commits; it does not reduce existing Git
history. Purging historical blobs requires a coordinated history rewrite, changes
commit IDs and affects existing branches and clones. Do that separately after the
R2 copy and historical retention requirements have been verified.
