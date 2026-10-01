---
name: playwright-video-nextcloud
description: Record Playwright test runs as video and upload the recordings to a password-protected Nextcloud public share. Use when test-run evidence must be recorded and delivered to a Nextcloud folder or shared with the team.
---

# Playwright Video → Nextcloud

Use this skill when a Playwright run must be recorded and its videos delivered to a password-protected Nextcloud public share. It bundles a dependency-free uploader and documents the recording, collection, upload, and reporting steps. If credentials, network access, or the Node runtime are unavailable, report the blocker without exposing secrets.

## Bundled CLI

`cli/upload-nextcloud.mjs` (Node 18+, no dependencies) uploads files over the Nextcloud public-share WebDAV endpoint. Run it from this skill directory; it resolves credentials from flags, then from the team environment variables.

```bash
node cli/upload-nextcloud.mjs --help
node cli/upload-nextcloud.mjs --dry-run --remote-dir "bugzy/<run-id>" test-results
node cli/upload-nextcloud.mjs --remote-dir "bugzy/<run-id>" --verify --json test-results
```

`cli/selftest.mjs` verifies the uploader against a local mock of the Nextcloud endpoint (32 checks, no network):

```bash
node cli/selftest.mjs
```

## Configuration

Resolved in this order (first hit wins):

1. Flags: `--base-url`, `--token`, `--share-link`, `--password`/`--password-env`/`--password-stdin`.
2. `NEXTCLOUD_BASE_URL` + `NEXTCLOUD_SHARE_TOKEN` + `NEXTCLOUD_SHARE_PASSWORD` — this is how the team's share is configured, so no extra setup is needed.
3. Optional alternative, for teams that store a share link instead of separate fields: `NEXTCLOUD_SHARED_FOLDER_LINK` (origin and token are parsed out of the `/s/<token>` link) + `NEXTCLOUD_SHARED_PASS`. Not configured for this team.

Rules:

- Never print, log, echo, or commit the share password or token. Prefer `--password-env` or `--password-stdin` over `--password` so the value stays out of the process list.
- Never commit recorded videos or credentials to a repository; `*.webm` is gitignored in the QA repo.
- Do not hardcode a share URL or token in test code. If the variables are missing, ask for them.

## Workflow

### Step 1: Confirm the destination

Check that a base URL and token resolve, and confirm the remote folder naming with the user when it is not implied by the request (a dated run folder such as `bugzy/2026-10-01-smoke` is a good default). Use `--dry-run` to print the planned `MKCOL`/`PUT` calls before sending anything.

### Step 2: Make sure the run records video

Video must be enabled for the run; Playwright has no `--video` CLI flag.

- Project config: `use: { video: 'on' }` records every test (`'retain-on-failure'` and `'on-first-retry'` are the cheaper alternatives). The Embodee QA repo (`nikip-embodee/EMB_QA`) already sets `video: 'on'`.
- Per-run override without editing the project config: add a wrapper config that spreads the project config and forces video, then run with `--config`. See [references/playwright-video-recording.md](references/playwright-video-recording.md).
- Videos are written per test into that test's output directory under `outputDir` (default `test-results/`). API-only tests launch no browser and produce no video.

### Step 3: Run the tests

Execute the suite normally (for the QA repo see `tests/CLAUDE.md` and the `run-tests` skill: `workers: 1`, no `networkidle` waits, no `waitForTimeout`). Keep the run's console output; it is the source of the pass/fail verdict.

### Step 4: Collect the recordings

```bash
find test-results -name '*.webm' -newermt '-2 hours' | sort
```

Do not delete or move the local videos — they are the primary evidence artifact. Uploading must never change the test verdict.

### Step 5: Upload

```bash
# One batch of runs -> one TEST-RUN-YYYY-MM-DD-HH-mm folder holding that batch's videos and traces
node cli/upload-nextcloud.mjs --verify --json --include webm --include zip \
  --remote-dir TEST-RUN-2026-10-01-15-27 ./run-artifacts

# Structured: mirror the local tree into a dated run folder
node cli/upload-nextcloud.mjs --remote-dir "bugzy/2026-10-01-smoke" --verify --json test-results

# Upload-only ("file drop") share: flat into the share root
node cli/upload-nextcloud.mjs --flat --json test-results
```

Batch convention used by the QA team: each run batch is uploaded to a folder named `TEST-RUN-YYYY-MM-DD-HH-mm`,
holding one video per test named `<TC-id>-<slug>.webm` plus the matching `<TC-id>-<slug>.zip` trace. The
Zephyr execution comment for a case references that relative path, e.g.
`TEST-RUN-2026-10-01-15-30/TC-031-create-new-layout-with-name-number-name-elements-cm-centered.webm`,
so keep the folder label and the file names exactly as reported by the run.

- Directory arguments are mirrored including their own name: `--remote-dir bugzy/run-1 test-results` uploads to `bugzy/run-1/test-results/<test>/video.webm`. Every parent folder is created with `MKCOL` before the file is written.
- `--include` defaults to `.webm`; add `--include zip` to send traces in the same pass.
- `--flat` writes every file directly into `--remote-dir`; needed only for upload-only shares, where subfolder writes are rejected.
- `--verify` re-reads each file with `PROPFIND` and compares the size. On upload-only shares verification is impossible (`PROPFIND` → 405) and the report says so instead of failing.
- Re-running is safe: `MKCOL` on an existing folder (`405`) is tolerated and an existing file is replaced. On upload-only shares Nextcloud instead stores a second copy with a numeric suffix — check before re-uploading.
- Exit codes: `0` all files uploaded, `1` upload failures (details in `failures[]`), `2` configuration error.

### Step 6: Report

State the share link, the remote folder, uploaded/failed counts, the local → remote mapping, and any upload failure with its HTTP status and hint. Never include the password or token. Report upload problems separately from test results so a delivery failure is never mistaken for a product failure.

## Failure handling

| Symptom | Meaning | Action |
| --- | --- | --- |
| `401` | Password wrong, share removed, or a missing `X-Requested-With: XMLHttpRequest` header | Re-check the password and the share; the bundled CLI always sends the header |
| `400 A nickname header is required when uploading subfolders` | Upload-only share; subfolder writes need a nickname | Use `--flat` (or `--nickname` for Nextcloud "file request" shares) |
| `409 Files cannot be created in non-existent collections` | Nextcloud file-drop bug ([#57021](https://github.com/nextcloud/server/issues/57021)): the nickname collection is never created | Use `--flat` |
| `405 Only PUT is allowed on files drop` | Upload-only share: listing/`PROPFIND` is unavailable | Expected; `--verify` reports "not verifiable" |
| `409` on a folder `MKCOL` | An ancestor folder is missing | The CLI creates all ancestors; re-check the token and remote path |
| `507` | Nextcloud storage full | Ask the share owner to free space |
| Connection timeout | Server or proxy unreachable | Retry once; report the blocker rather than dropping the evidence |

## Notes

- The team's share (`https://nextcloud.embodee.com/s/<token>`) is a normal public share with **upload + edit** permission: subfolders work (`MKCOL` plus `PUT` inside) and `--verify` works. `DELETE` returns `403`, so obsolete evidence has to be removed in the Nextcloud UI. Verified 2026-10-01 with 96 files across seven `TEST-RUN-…` folders, all created and size-verified.
- If a share is switched back to upload-only ("File drop"), subfolder writes fail (`400 A nickname header is required when uploading subfolders`, or `409 Files cannot be created in non-existent collections` when `X-NC-Nickname` is sent — Nextcloud also files such uploads under a folder named after the nickname). Use `--flat` on those shares.
- Endpoint, header, and legacy-endpoint details: [references/nextcloud-public-webdav.md](references/nextcloud-public-webdav.md).
