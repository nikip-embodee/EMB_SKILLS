#!/usr/bin/env node
// Self-test for upload-nextcloud.mjs against a local mock of the Nextcloud public WebDAV endpoint.
// Verifies auth, the X-Requested-With requirement, MKCOL/PUT semantics, path encoding,
// dry-run, legacy endpoint, size verification, and secret redaction.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const UPLOADER = path.join(HERE, 'upload-nextcloud.mjs');
const TOKEN = 'test-token-123';
const PASSWORD = 'super-secret-pw';
const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : ` -> ${detail}`}`);
}

function startMock(mode = 'share') {
  const fileDrop = mode === 'fileDrop';
  const state = { collections: new Set(), files: new Map(), requests: [] };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const record = {
        method: req.method,
        pathname: url.pathname,
        headers: req.headers,
        body,
        segments,
      };
      state.requests.push(record);

      const legacy = segments[0] === 'public.php' && segments[1] === 'webdav';
      const modern = segments[0] === 'public.php' && segments[1] === 'dav' && segments[2] === 'files';
      if (!legacy && !modern) {
        res.writeHead(404).end('not found');
        return;
      }
      const expectedAuth = `Basic ${Buffer.from(`${legacy ? TOKEN : 'anonymous'}:${PASSWORD}`).toString('base64')}`;
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"message":"Current user is not logged in"}');
        return;
      }
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'XMLHttpRequest') {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"message":"CSRF check not passed"}');
        return;
      }

      const rel = (legacy ? segments.slice(2) : segments.slice(4)).join('/');
      if (fileDrop) {
        // Upload-only share: PUT/MKCOL only, nickname required for subfolders, and Nextcloud
        // (bug #57021) answers 409 because the nickname collection is never created.
        if (req.method === 'PROPFIND') {
          res.writeHead(405).end('Only PUT is allowed on files drop');
          return;
        }
        if (req.method === 'MKCOL') {
          if (req.headers['x-nc-nickname']) {
            state.collections.add(rel);
            res.writeHead(201).end();
          } else {
            res.writeHead(400).end('<s:message>A nickname header is required when uploading subfolders</s:message>');
          }
          return;
        }
        if (req.method === 'PUT') {
          if (req.headers['x-nc-nickname'] || rel.includes('/')) {
            res.writeHead(409).end('Files cannot be created in non-existent collections');
            return;
          }
          const existedFlat = state.files.has(rel);
          state.files.set(rel, body);
          res.writeHead(existedFlat ? 204 : 201).end();
          return;
        }
        res.writeHead(405).end();
        return;
      }
      if (req.method === 'MKCOL') {
        const parent = rel.split('/').slice(0, -1).join('/');
        if (state.collections.has(rel)) res.writeHead(405).end();
        else if (parent && !state.collections.has(parent)) res.writeHead(409).end('parent missing');
        else {
          state.collections.add(rel);
          res.writeHead(201).end();
        }
        return;
      }
      if (req.method === 'PUT') {
        const existed = state.files.has(rel);
        state.files.set(rel, body);
        res.writeHead(existed ? 204 : 201).end();
        return;
      }
      if (req.method === 'PROPFIND') {
        const stored = state.files.get(rel);
        if (!stored) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(207, { 'Content-Type': 'application/xml' }).end(
          `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop>` +
            `<d:getcontentlength>${stored.length}</d:getcontentlength></d:prop></d:propstat></d:response></d:multistatus>`,
        );
        return;
      }
      res.writeHead(405).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

function runUploader(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [UPLOADER, ...args], {
      env: { PATH: process.env.PATH, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function makeFixtures(root) {
  const runDir = path.join(root, 'test-results');
  const a = path.join(runDir, 'TC-031 Layouts (chromium)', 'video.webm');
  const b = path.join(runDir, 'TC-032 Collection (chromium)', 'video.webm');
  const c = path.join(runDir, 'notes.txt');
  await mkdir(path.dirname(a), { recursive: true });
  await mkdir(path.dirname(b), { recursive: true });
  await writeFile(a, Buffer.from('fake-webm-a'.repeat(64)));
  await writeFile(b, Buffer.from('fake-webm-b'.repeat(32)));
  await writeFile(c, 'ignore me');
  return { runDir, a, b };
}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'nc-selftest-'));
const { server, state, origin } = await startMock();
try {
  const { runDir, a, b } = await makeFixtures(tmp);

  // 1. Nested directory upload: MKCOL per folder, PUT per .webm, X-Requested-With on every request.
  let run = await runUploader(
    ['--base-url', origin, '--token', TOKEN, '--password-env', 'NC_PW', '--remote-dir', 'bugzy/run-1', '--verify', '--json', runDir],
    { NC_PW: PASSWORD },
  );
  let report = JSON.parse(run.stdout);
  check('nested upload exits 0', run.code === 0, `${run.stderr}${JSON.stringify(report.failures)}`);
  check('both videos uploaded', report.files.filter((f) => f.status === 'created').length === 2, JSON.stringify(report.files));
  check(
    'mkcol mirrored the scanned root and both run folders',
    state.collections.has('bugzy/run-1/test-results') &&
      state.collections.has('bugzy/run-1/test-results/TC-031 Layouts (chromium)') &&
      state.collections.has('bugzy/run-1/test-results/TC-032 Collection (chromium)'),
    [...state.collections].join(' | '),
  );
  check('non-matching extension skipped', state.files.has('bugzy/run-1/test-results/notes.txt') === false && report.skipped === 1);
  check(
    'bytes stored match local file',
    state.files.get('bugzy/run-1/test-results/TC-031 Layouts (chromium)/video.webm')?.equals(await readFile(a)),
  );
  check('every request carried X-Requested-With', state.requests.every((r) => r.headers['x-requested-with'] === 'XMLHttpRequest'));
  check('no nickname header sent unless requested', state.requests.every((r) => r.headers['x-nc-nickname'] === undefined));
  check(
    'every request used anonymous basic auth',
    state.requests.every((r) => r.headers.authorization === `Basic ${Buffer.from(`anonymous:${PASSWORD}`).toString('base64')}`),
    state.requests.filter((r) => r.headers.authorization !== `Basic ${Buffer.from(`anonymous:${PASSWORD}`).toString('base64')}`).map((r) => `${r.method} ${r.pathname}`).join(', '),
  );
  check('PUT sent an explicit Content-Length', state.requests.filter((r) => r.method === 'PUT').every((r) => Number(r.headers['content-length']) === r.body.length));
  check('encoded spaces and parentheses in the URL', state.requests.some((r) => r.pathname.includes('TC-031%20Layouts%20(chromium)')));
  check('--verify reported verified files', report.files.filter((f) => f.status !== 'skipped (dry run)').every((f) => f.verified === true));
  check('no password in stdout/stderr', !`${run.stdout}${run.stderr}`.includes(PASSWORD));

  // 2. Idempotent re-run: MKCOL 405 tolerated, PUT overwrite returns 204.
  run = await runUploader(['--base-url', origin, '--token', TOKEN, '--password', PASSWORD, '--remote-dir', 'bugzy/run-1', '--json', runDir]);
  report = JSON.parse(run.stdout);
  check('re-run exits 0 despite MKCOL 405', run.code === 0, run.stderr);
  check('overwrite reported as replaced', report.files.every((f) => f.status === 'replaced'));

  // 3. Wrong password: non-zero exit, actionable hint, password never echoed.
  const wrongRun = await runUploader(['--base-url', origin, '--token', TOKEN, '--password', 'wrong-password', '--remote-dir', 'bugzy/run-2', a]);
  const wrongOutput = `${wrongRun.stdout}${wrongRun.stderr}`;
  check('wrong password exits 1', wrongRun.code === 1, `code=${wrongRun.code}`);
  check('wrong password reports an auth hint', /401/.test(wrongOutput) && /share password/i.test(wrongOutput), wrongOutput.trim());
  check('wrong password is not echoed', !wrongOutput.includes('wrong-password'));

  // 4. dry-run performs no requests.
  const before = state.requests.length;
  run = await runUploader(['--base-url', origin, '--token', TOKEN, '--password', PASSWORD, '--remote-dir', 'bugzy/run-3', '--dry-run', '--json', runDir]);
  report = JSON.parse(run.stdout);
  // 5 MKCOL (bugzy, bugzy/run-3, test-results and the two test folders) + 2 PUT
  check('dry-run exits 0 and plans work', run.code === 0 && report.files.length === 7, JSON.stringify(report.files.length));
  check('dry-run sent no HTTP requests', state.requests.length === before);

  // 5. Legacy pre-29 endpoint uses the token as the basic-auth username.
  state.requests.length = 0;
  run = await runUploader(['--base-url', origin, '--token', TOKEN, '--password', PASSWORD, '--legacy', '--remote-dir', 'legacy-run', b]);
  check('legacy upload exits 0', run.code === 0, run.stderr);
  check('legacy requests target /public.php/webdav', state.requests.every((r) => r.pathname.startsWith('/public.php/webdav/')));
  check('legacy requests authenticate with the token', state.requests.every((r) => r.headers.authorization === `Basic ${Buffer.from(`${TOKEN}:${PASSWORD}`).toString('base64')}`));

  // 6. Config resolution from the share link alone (NEXTCLOUD_SHARED_FOLDER_LINK).
  state.requests.length = 0;
  run = await runUploader([b], { NEXTCLOUD_SHARED_FOLDER_LINK: `${origin}/s/${TOKEN}`, NEXTCLOUD_SHARED_PASS: PASSWORD });
  check('share-link + NEXTCLOUD_SHARED_PASS resolve origin and token', run.code === 0 && state.requests.length > 0, run.stderr);

  // 7. Unsafe remote dir and missing config are rejected before any request.
  const unsafe = await runUploader(['--base-url', origin, '--token', TOKEN, '--password', PASSWORD, '--remote-dir', '../escape', a]);
  check('traversal remote-dir rejected', unsafe.code === 2 && /unsafe/.test(unsafe.stderr), unsafe.stderr.trim());
  const missing = await runUploader([a], {});
  check('missing config exits 2', missing.code === 2 && /missing Nextcloud base URL/.test(missing.stderr), missing.stderr.trim());

  // 8. --nickname sends the header required by Nextcloud "file request" shares.
  state.requests.length = 0;
  run = await runUploader(['--base-url', origin, '--token', TOKEN, '--password', PASSWORD, '--nickname', 'BugzyQA', '--remote-dir', 'nick-run', a]);
  check(
    '--nickname adds X-NC-Nickname to every write',
    run.code === 0 && state.requests.filter((r) => r.method !== 'PROPFIND').every((r) => r.headers['x-nc-nickname'] === 'BugzyQA'),
    run.stderr,
  );

  // 9. Upload-only (file drop) share: structured uploads fail with an actionable hint, --flat works,
  //    and size verification degrades to "not verifiable" instead of a hard failure.
  const drop = await startMock('fileDrop');
  try {
    let dropRun = await runUploader(['--base-url', drop.origin, '--token', TOKEN, '--password', PASSWORD, '--remote-dir', 'run-x', '--json', a]);
    let dropReport = JSON.parse(dropRun.stdout);
    check(
      'file-drop: structured upload fails and points at --flat',
      dropRun.code === 1 && /--flat/.test(JSON.stringify(dropReport.failures)),
      `${dropRun.code} ${JSON.stringify(dropReport.failures)}`,
    );

    dropRun = await runUploader(['--base-url', drop.origin, '--token', TOKEN, '--password', PASSWORD, '--flat', '--verify', '--json', a]);
    dropReport = JSON.parse(dropRun.stdout);
    check('file-drop: flat upload exits 0', dropRun.code === 0, `${dropRun.stderr}${JSON.stringify(dropReport.failures)}`);
    check('file-drop: file stored at the share root', drop.state.files.has(path.basename(a)));
    check(
      'file-drop: verification degrades to null instead of failing',
      dropReport.verifiable === false && dropReport.files.every((f) => f.verified === null),
      JSON.stringify(dropReport.files),
    );
    check('file-drop: no nickname header sent by default', drop.state.requests.every((r) => r.headers['x-nc-nickname'] === undefined));
  } finally {
    drop.server.close();
  }

  // 10. The mock really enforces the X-Requested-With rule (guards assertion 1).
  const raw = await fetch(`${origin}/public.php/dav/files/${TOKEN}/no-header.txt`, {
    method: 'PUT',
    headers: { Authorization: `Basic ${Buffer.from(`anonymous:${PASSWORD}`).toString('base64')}` },
    body: 'x',
  });
  check('mock rejects PUT without X-Requested-With', raw.status === 401, `status=${raw.status}`);
} finally {
  server.close();
  await rm(tmp, { recursive: true, force: true });
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
