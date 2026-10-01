# Nextcloud public-share WebDAV

Reference for `cli/upload-nextcloud.mjs`. Based on the Nextcloud 29+ public-share WebDAV endpoint and
verified against `https://nextcloud.embodee.com`.

## Endpoint and authentication

| | Nextcloud 29+ | Legacy (pre-29) |
| --- | --- | --- |
| URL | `{origin}/public.php/dav/files/{share_token}/{remote_path}` | `{origin}/public.php/webdav/{remote_path}` |
| Basic auth username | `anonymous` | the share token |
| Basic auth password | the share password | the share password |

- The share token belongs in the URL path, not in the Basic-auth username (except in legacy mode).
- Non-GET requests to `/public.php/dav` require `X-Requested-With: XMLHttpRequest`; omitting it returns
  `401 Not Authenticated`. `curl` against the team instance also needs `--http1.1` (HTTP/2 uploads fail
  with `PROTOCOL_ERROR`).
- Public shares without a password need no `Authorization` header (`--no-auth`).
- Uploading to an existing path replaces the file (`204`), except on upload-only shares (below).

## Folder creation

The destination's parents must already exist. Create them with `MKCOL`, deepest last, using the same
authentication and header. `201 Created` means created and `405 Method Not Allowed` means the folder
already exists — both are success. A `MKCOL` whose parent is missing returns `409`, so the CLI expands
every ancestor path before uploading.

## Upload-only ("file drop") shares

Verified behavior on the team's share:

- `PUT` to the share **root** without a nickname header → `201`.
- `MKCOL` without `X-NC-Nickname` → `400 A nickname header is required when uploading subfolders`.
- `MKCOL` **with** `X-NC-Nickname` → `201`, but a following `PUT` into that folder → `409 Files cannot be
  created in non-existent collections` (Nextcloud issue
  [#57021](https://github.com/nextcloud/server/issues/57021)); the same `409` is returned for any `PUT`
  that carries a nickname header.
- `PROPFIND`/listing → `405 Only PUT is allowed on files drop`; `DELETE` → `405` as well.

Consequences for this share: use `--flat` to write into the share root, expect no read-back verification,
expect a repeat upload to create a second copy with a numeric suffix (no overwrite), and delete stale
evidence in the Nextcloud web UI because the API cannot.

The nickname header name in the server implementation is `X-NC-Nickname`
(`apps/dav/lib/Files/Sharing/FilesDropPlugin.php`). Nextcloud "file request" shares require it; on the
team's share it breaks uploads, so the CLI only sends it when `--nickname` is passed explicitly.

## Related upstream reports

- [#56338](https://github.com/nextcloud/server/issues/56338) — "nickname header is required" despite the header being present.
- [#57021](https://github.com/nextcloud/server/issues/57021) — files cannot be created in non-existent collections on file drop.
