# Recording Playwright test runs

Playwright records video per test. There is no `--video` CLI flag — video is set in configuration.

## Enable it

Project config (every test records):

```ts
export default defineConfig({
  use: { video: 'on' },
});
```

Cheaper options: `'retain-on-failure'` (keeps video only for failures) and `'on-first-retry'`.
Video capture requires a browser context, so API-only tests (`{ request }` fixture) produce none.

## Override for a single run

Keep the project config untouched by adding a wrapper that spreads it:

```js
// playwright.video.config.js
const base = require('./playwright.config.js');
module.exports = { ...base, outputDir: 'video-runs', use: { ...base.use, video: 'on' } };
```

```bash
npx playwright test --config playwright.video.config.js
```

For a TypeScript project config, use `playwright.video.config.ts` with `import base from './playwright.config'`.
If the project config exports a function, call it first: `const base = require('./playwright.config').default()`.
A single spec can also opt in with `test.use({ video: 'on' })`.

## Where the files land

Each test gets its own output directory under `outputDir` (default `test-results/`) containing
`video.webm` alongside trace and failure screenshots:

```text
test-results/
  demo-demo-video-evidence/video.webm
```

```bash
find test-results -name '*.webm'
```

`--output <dir>` on the CLI or `outputDir` in the config changes the root. Videos stay on disk until the
next run reuses the directory, so collect them before re-running, and never delete them to make an upload
step simpler.
