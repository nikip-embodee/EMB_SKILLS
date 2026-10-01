#!/usr/bin/env node
// Upload files (Playwright .webm evidence) to a password-protected Nextcloud public share
// over the public WebDAV endpoint. Dependency-free: Node 18+ fetch only.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_EXTENSIONS = ['.webm'];
const MKCOL_OK = new Set([200, 201, 204, 405]); // 405 = collection already exists
const PUT_OK = new Set([200, 201, 204]);
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const USAGE = `Upload files to a password-protected Nextcloud public share.

Usage:
  node upload-nextcloud.mjs [options] <file-or-dir>...

Options:
  --base-url <url>      Nextcloud origin, e.g. https://cloud.example.com (env NEXTCLOUD_BASE_URL)
  --token <token>       Public share token (env NEXTCLOUD_SHARE_TOKEN, or derived from --share-link)
  --share-link <url>    Public share link; origin and token are derived from it
                        (env NEXTCLOUD_SHARED_FOLDER_LINK)
  --password <value>    Share password (prefer --password-env or --password-stdin)
  --password-env <name> Read the share password from this variable
  --password-stdin      Read the share password from the first line of stdin
  --no-auth             Skip authentication (public share without a password)
  --nickname <value>    Send X-NC-Nickname, required by Nextcloud "file request" shares
                        (env NEXTCLOUD_UPLOAD_NICKNAME; omitted by default)
  --remote-dir <path>   Destination folder inside the share (default: share root)
  --include <ext>       Only upload this extension when a directory is scanned
                        (repeatable, default: .webm)
  --flat                Upload every file into --remote-dir without keeping sub-folders
  --legacy              Use the pre-Nextcloud-29 endpoint /public.php/webdav with the token as username
  --verify              PROPFIND each uploaded file and compare the remote size
  --dry-run             Print the planned MKCOL/PUT requests without sending them
  --json                Print a JSON report instead of text
  --quiet               Suppress per-file progress lines
  --timeout <ms>        Per-request timeout (default 60000)
  --retries <n>         Retries for network errors and 5xx/429 responses (default 2)

Password lookup order: --password-stdin, --password, --password-env,
NEXTCLOUD_SHARE_PASSWORD, NEXTCLOUD_SHARED_PASS.

Exit codes: 0 all files uploaded, 1 upload failures, 2 configuration error.`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    files: [],
    include: [],
    remoteDir: '',
    timeoutMs: 60000,
    retries: 2,
    json: false,
    quiet: false,
    dryRun: false,
    legacy: false,
    flat: false,
    verify: false,
    noAuth: false,
    passwordStdin: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) fail(`missing value for ${arg}`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
        break;
      case '--base-url': opts.baseUrl = value(); break;
      case '--token': opts.token = value(); break;
      case '--share-link': opts.shareLink = value(); break;
      case '--password': opts.password = value(); break;
      case '--password-env': opts.passwordEnv = value(); break;
      case '--password-stdin': opts.passwordStdin = true; break;
      case '--no-auth': opts.noAuth = true; break;
      case '--nickname': opts.nickname = value(); break;
      case '--remote-dir': opts.remoteDir = value(); break;
      case '--include': opts.include.push(value()); break;
      case '--flat': opts.flat = true; break;
      case '--legacy': opts.legacy = true; break;
      case '--verify': opts.verify = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--timeout': opts.timeoutMs = Number(value()); break;
      case '--retries': opts.retries = Number(value()); break;
      default:
        if (arg.startsWith('--')) fail(`unknown option: ${arg}`);
        opts.files.push(arg);
    }
  }
  return opts;
}

const firstNonEmpty = (...values) => values.find((v) => typeof v === 'string' && v.length > 0) ?? '';

function tokenFromShareLink(link) {
  if (!link) return '';
  let url;
  try {
    url = new URL(link);
  } catch {
    return '';
  }
  const match = url.pathname.match(/\/s\/([^/]+)/);
  if (match) return decodeURIComponent(match[1]);
  return url.searchParams.get('token') ?? '';
}

function originFromShareLink(link) {
  if (!link) return '';
  try {
    return new URL(link).origin;
  } catch {
    return '';
  }
}

async function readStdinLine() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.includes('\n')) break;
  }
  return data.split(/\r?\n/)[0].trim();
}

function normalizeRemoteDir(input) {
  const segments = input.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.some((s) => s === '..' || s.includes('\\'))) {
    fail(`unsafe --remote-dir segment in "${input}"`);
  }
  return segments.join('/');
}

function joinRemote(dir, rel) {
  const clean = String(rel)
    .split('/')
    .filter((s) => s.length > 0 && s !== '.')
    .join('/');
  return dir ? `${dir}/${clean}` : clean;
}

async function collectFiles(targets, { include, flat, remoteDir }) {
  const allowed = new Set(
    (include.length ? include : DEFAULT_EXTENSIONS).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()),
  );
  const found = [];
  const skipped = [];

  const walk = async (current, subPath) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, joinRemote(subPath, entry.name));
      } else if (entry.isFile()) {
        if (!allowed.has(path.extname(entry.name).toLowerCase())) {
          skipped.push(absolute);
          continue;
        }
        found.push({
          localPath: absolute,
          remotePath: flat ? joinRemote(remoteDir, entry.name) : joinRemote(remoteDir, joinRemote(subPath, entry.name)),
        });
      }
    }
  };

  for (const target of targets) {
    let info;
    try {
      info = await stat(target);
    } catch (err) {
      fail(`cannot read ${target}: ${err.code ?? err.message}`);
    }
    if (info.isDirectory()) {
      // Mirror the directory itself, so `--remote-dir run-1 test-results` uploads to run-1/test-results/...
      await walk(target, path.basename(path.resolve(target)));
    } else if (info.isFile()) {
      found.push({ localPath: target, remotePath: joinRemote(remoteDir, path.basename(target)) });
    }
  }
  return { found, skipped };
}

function encodeRemotePath(remotePath) {
  return String(remotePath)
    .split('/')
    .filter((s) => s.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildRequest(cfg, { remotePath = '', headers = {}, dir = false }) {
  const pathPart = encodeRemotePath(remotePath);
  const base = cfg.legacy
    ? `${cfg.origin}/public.php/webdav`
    : `${cfg.origin}/public.php/dav/files/${encodeURIComponent(cfg.token)}`;
  const url = dir ? `${base}/${pathPart}/` : `${base}/${pathPart}`;
  const requestHeaders = { 'X-Requested-With': 'XMLHttpRequest', ...headers };
  if (cfg.authorization && !requestHeaders.Authorization) requestHeaders.Authorization = cfg.authorization;
  if (cfg.nickname && !requestHeaders['X-NC-Nickname']) requestHeaders['X-NC-Nickname'] = cfg.nickname;
  return { url, headers: requestHeaders };
}

function authHeader(cfg) {
  if (!cfg.password) return '';
  const user = cfg.legacy ? cfg.token : 'anonymous';
  return `Basic ${Buffer.from(`${user}:${cfg.password}`, 'utf8').toString('base64')}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function send(cfg, options) {
  const { url, headers } = buildRequest(cfg, options);
  const attempts = Math.max(1, cfg.retries + 1);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body ? options.body() : undefined,
        signal: AbortSignal.timeout(cfg.timeoutMs),
        ...(options.body ? { duplex: 'half' } : {}),
      });
      if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
        await response.arrayBuffer().catch(() => {});
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
    }
  }
  throw new Error(`request to ${url} failed: ${lastError?.message ?? 'unknown error'}`);
}

function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('***');
  }
  return out;
}

function hintFor(status) {
  switch (status) {
    case 400:
      return 'bad request: an upload-only (file drop) share requires a nickname for subfolders and refuses uploads into subfolders - re-run with --flat to write into the share root';
    case 401:
      return 'authentication rejected: verify the share password and that the share still exists (a missing X-Requested-With header also returns 401)';
    case 403:
      return 'forbidden: public uploads may be disabled for this share';
    case 404:
      return 'not found: wrong share token, or the parent folder does not exist';
    case 405:
      return 'method not allowed: upload-only (file drop) shares accept only PUT/MKCOL, so listing and verification are unavailable - use --flat';
    case 409:
      return 'conflict: the parent collection is missing. Nextcloud file-drop shares cannot create files in collections they never created - re-run with --flat';
    case 507:
      return 'insufficient storage on the Nextcloud instance';
    default:
      return '';
  }
}

function emit(report, opts) {
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const uploaded = report.files.filter((f) => f.status === 'created' || f.status === 'replaced').length;
  const totalBytes = report.files.filter((f) => f.bytes).reduce((sum, f) => sum + f.bytes, 0);
  console.log('');
  console.log(`share:    ${report.shareUrl}`);
  console.log(`endpoint: ${report.endpoint}`);
  console.log(`folder:   ${report.remoteDir}`);
  console.log(
    `result:   ${uploaded}/${report.files.length} files uploaded (${totalBytes} bytes)` +
      `${report.skipped ? `, ${report.skipped} local file(s) skipped by extension filter` : ''}`,
  );
  if (!report.verifiable) {
    console.log('note:     the share is upload-only (file drop), so uploads cannot be listed or size-verified');
  }
  if (report.failures.length > 0) {
    console.log('');
    console.log(`failures: ${report.failures.length}`);
    for (const failure of report.failures) {
      console.log(
        `  - ${failure.remotePath ?? failure.localPath ?? ''} ${failure.error ?? ''}${failure.hint ? ` (${failure.hint})` : ''}`,
      );
    }
  }
}

// Returns true/false when the server reports a size, and null when the share cannot be read
// back at all (upload-only file-drop shares answer PROPFIND with 405).
async function verifyRemoteSize(cfg, remotePath, expectedSize) {
  const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/></d:prop></d:propfind>';
  const response = await send(cfg, {
    method: 'PROPFIND',
    remotePath,
    headers: { Depth: '0', 'Content-Type': 'application/xml' },
    body: () => body,
  }).catch(() => null);
  if (!response) return false;
  if (response.status === 405 || response.status === 403 || response.status === 400) return null;
  if (response.status !== 207) return false;
  const text = await response.text().catch(() => '');
  const match = text.match(/<[^>]*getcontentlength[^>]*>(\d+)</i);
  return match ? Number(match[1]) === expectedSize : false;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.files.length === 0) fail(`no input files given\n\n${USAGE}`);

  const env = process.env;
  const shareLink = firstNonEmpty(opts.shareLink ?? '', env.NEXTCLOUD_SHARED_FOLDER_LINK ?? '');
  const origin = firstNonEmpty(opts.baseUrl ?? '', env.NEXTCLOUD_BASE_URL ?? '', originFromShareLink(shareLink));
  const token = firstNonEmpty(opts.token ?? '', env.NEXTCLOUD_SHARE_TOKEN ?? '', tokenFromShareLink(shareLink));
  const nickname = firstNonEmpty(opts.nickname ?? '', env.NEXTCLOUD_UPLOAD_NICKNAME ?? '');
  const password = opts.passwordStdin
    ? await readStdinLine()
    : firstNonEmpty(
        opts.password ?? '',
        env[opts.passwordEnv ?? 'NEXTCLOUD_SHARE_PASSWORD'] ?? '',
        env.NEXTCLOUD_SHARE_PASSWORD ?? '',
        env.NEXTCLOUD_SHARED_PASS ?? '',
      );

  if (!origin) fail('missing Nextcloud base URL: pass --base-url/--share-link or set NEXTCLOUD_BASE_URL');
  if (!token) fail('missing share token: pass --token/--share-link or set NEXTCLOUD_SHARE_TOKEN');
  if (!opts.noAuth && !password) {
    fail('missing share password: use --password-stdin/--password, set NEXTCLOUD_SHARE_PASSWORD, or pass --no-auth for an unprotected share');
  }
  if (!/^https?:\/\//.test(origin)) fail(`invalid base URL "${origin}"`);

  const remoteDir = normalizeRemoteDir(opts.remoteDir);
  const { found, skipped } = await collectFiles(opts.files, {
    include: opts.include,
    flat: opts.flat,
    remoteDir,
  });
  const secrets = [password, token];
  const cfg = {
    origin,
    token,
    password: opts.noAuth ? '' : password,
    legacy: opts.legacy,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    nickname,
  };
  cfg.authorization = authHeader(cfg);

  const report = {
    ok: true,
    verifiable: true,
    origin,
    shareUrl: `${origin}/s/${token}`,
    endpoint: opts.legacy ? 'public.php/webdav (legacy)' : 'public.php/dav/files (Nextcloud 29+)',
    remoteDir: remoteDir ? `/${remoteDir}` : '/',
    nickname: nickname || null,
    files: [],
    failures: [],
    skipped: skipped.length,
    dryRun: opts.dryRun,
  };

  if (found.length === 0) {
    report.ok = false;
    report.failures.push({
      error: 'no files matched the requested extensions',
      hint: `matched: ${(opts.include.length ? opts.include : DEFAULT_EXTENSIONS).join(', ')}`,
    });
    emit(report, opts);
    process.exit(1);
  }

  // Every ancestor must exist before its children; Nextcloud answers 409 for a MKCOL whose parent is missing.
  const neededDirs = [
    ...new Set(
      found.flatMap((file) => {
        const parts = path.posix.dirname(file.remotePath).split('/').filter((p) => p !== '' && p !== '.');
        return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
      }),
    ),
  ].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  if (opts.dryRun) {
    for (const dir of neededDirs) {
      report.files.push({ remotePath: `/${dir}/`, method: 'MKCOL', status: 'skipped (dry run)' });
    }
    for (const file of found) {
      report.files.push({ localPath: file.localPath, remotePath: `/${file.remotePath}`, method: 'PUT', status: 'skipped (dry run)' });
    }
    emit(report, opts);
    return;
  }

  for (const dir of neededDirs) {
    let response;
    try {
      response = await send(cfg, { method: 'MKCOL', remotePath: dir, dir: true });
    } catch (err) {
      report.ok = false;
      report.failures.push({ remotePath: `/${dir}/`, method: 'MKCOL', error: redact(err.message, secrets) });
      continue;
    }
    if (!MKCOL_OK.has(response.status)) {
      const detail = await response.text().catch(() => '');
      report.ok = false;
      report.failures.push({
        remotePath: `/${dir}/`,
        method: 'MKCOL',
        httpStatus: response.status,
        error: redact(`${response.status} ${response.statusText} ${detail}`.trim(), secrets),
        hint: hintFor(response.status),
      });
    }
  }

  for (const file of found) {
    const info = await stat(file.localPath);
    const entry = { localPath: file.localPath, remotePath: `/${file.remotePath}`, bytes: info.size };
    try {
      const response = await send(cfg, {
        method: 'PUT',
        remotePath: file.remotePath,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(info.size),
        },
        body: () => createReadStream(file.localPath),
      });
      entry.httpStatus = response.status;
      if (!PUT_OK.has(response.status)) {
        const detail = await response.text().catch(() => '');
        entry.status = 'failed';
        entry.error = redact(`${response.status} ${response.statusText} ${detail}`.trim(), secrets);
        entry.hint = hintFor(response.status);
        report.failures.push({ ...entry });
        report.ok = false;
      } else {
        entry.status = response.status === 201 ? 'created' : 'replaced';
        if (opts.verify) {
          entry.verified = await verifyRemoteSize(cfg, file.remotePath, info.size);
          report.verifiable = report.verifiable && entry.verified !== null;
          if (entry.verified === false) {
            entry.hint = 'remote size differs from the local file';
            report.failures.push({ ...entry, error: 'size mismatch after upload' });
            report.ok = false;
          }
        }
      }
    } catch (err) {
      entry.status = 'failed';
      entry.error = redact(err.message, secrets);
      report.failures.push({ ...entry });
      report.ok = false;
    }
    report.files.push(entry);
    if (!opts.quiet && !opts.json) {
      const label = entry.status === 'failed' ? 'FAIL' : 'OK  ';
      const verified =
        entry.verified === undefined ? '' : entry.verified === null ? ' (not verifiable on this share)' : entry.verified ? ' (verified)' : ' (size mismatch)';
      console.error(`${label} ${entry.remotePath} ${entry.bytes} bytes${verified}`);
    }
  }

  emit(report, opts);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) =>
  fail(
    redact(err.message, [
      process.env.NEXTCLOUD_SHARE_PASSWORD,
      process.env.NEXTCLOUD_SHARED_PASS,
      process.env.NEXTCLOUD_SHARE_TOKEN,
    ]),
  ),
);
