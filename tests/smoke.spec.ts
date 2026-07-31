import { expect, test } from '@playwright/test';

test('serves the app, games, ranges, and WebDAV persistence', async ({ page, request }) => {
  const root = await request.get('/');
  expect(root.status()).toBe(200);

  const dataIndexResponse = await request.get('/data/index.json');
  expect(dataIndexResponse.status()).toBe(200);
  const dataIndex = await dataIndexResponse.json();
  expect(dataIndex.games).toEqual({});
  expect(JSON.stringify(dataIndex)).not.toContain('baseUrl');

  const gamesIndexResponse = await request.get('/data/games/index.json');
  expect(gamesIndexResponse.status()).toBe(200);
  const gamesIndex = await gamesIndexResponse.json();
  const fixtureDirectory = Object.keys(gamesIndex).find((name) => name.toLowerCase().includes('bass'));
  expect(fixtureDirectory).toBeTruthy();

  const fixtureIndexResponse = await request.get(`/data/games/${fixtureDirectory}/index.json`);
  expect(fixtureIndexResponse.status()).toBe(200);
  const fixtureIndex = await fixtureIndexResponse.json();
  const fixtureFile = Object.keys(fixtureIndex).find((name) => typeof fixtureIndex[name] === 'number');
  expect(fixtureFile).toBeTruthy();

  const gameRange = await request.get(
    `/data/games/${fixtureDirectory}/${encodeURIComponent(fixtureFile!)}`,
    { headers: { Range: 'bytes=0-1023' } },
  );
  expect(gameRange.status()).toBe(206);
  expect(gameRange.headers()['content-range']).toMatch(/^bytes 0-/);

  const symlinkEscape = await request.get('/data/games/symlink-escape');
  expect([403, 404]).toContain(symlinkEscape.status());

  const pluginIndexResponse = await request.get('/data/plugins/index.json');
  expect(pluginIndexResponse.status()).toBe(200);
  const pluginIndex = await pluginIndexResponse.json();
  const plugin = Object.keys(pluginIndex).find((name) => name.endsWith('.so'));
  expect(plugin).toBeTruthy();
  const pluginRange = await request.get(`/data/plugins/${plugin}`, {
    headers: { Range: 'bytes=0-1023' },
  });
  expect(pluginRange.status()).toBe(206);

  const catalogResponse = await request.get('/games.json');
  expect(catalogResponse.status()).toBe(200);
  const catalog = await catalogResponse.json();
  const skyEntries = catalog.filter((game: { id: string }) => game.id === 'sky:sky');
  expect(skyEntries.length).toBeGreaterThanOrEqual(2);
  const skyPaths = new Set(skyEntries.map((game: { relative_path: string }) => game.relative_path));
  expect(skyPaths.size).toBe(skyEntries.length);

  await page.goto('/games.html');
  const gameLink = page.locator('a.game-entry[href*="/data/games/"]').first();
  await expect(gameLink).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/cloud storage/i);
  expect(await gameLink.getAttribute('href')).toContain('scummvm.html#--path=/data/games/');
  const gamesScript = await request.get('/games.js');
  expect(await gamesScript.text()).not.toMatch(/kuendig\.(?:io|info)|Full Cloud support/);
  expect((await request.get('/games-limited.html')).status()).toBe(404);
  expect((await request.get('/games-full.html')).status()).toBe(404);
  expect((await request.get('/games-v2.css')).status()).toBe(404);
  expect((await request.get('/games-v2.js')).status()).toBe(404);
  expect((await request.get('/metadata.json')).status()).toBe(404);

  const put = await request.put('/persist/smoke.txt', { data: 'persisted' });
  expect(put.ok()).toBe(true);
  const persisted = await request.get('/persist/smoke.txt');
  expect(await persisted.text()).toBe('persisted');
  const deleted = await request.delete('/persist/smoke.txt');
  expect(deleted.ok()).toBe(true);

  const fatalErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /LinkError|abort\(|RuntimeError/i.test(message.text())) {
      fatalErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => fatalErrors.push(error.message));
  page.on('dialog', async (dialog) => {
    fatalErrors.push(dialog.message());
    await dialog.dismiss();
  });

  const wasmLoaded = page.waitForResponse(
    (response) => response.url().endsWith('/scummvm.wasm') && response.ok(),
  );
  await page.goto('/scummvm.html');
  await wasmLoaded;
  await expect(page.locator('#canvas')).toBeVisible();
  await page.waitForTimeout(10_000);
  expect(fatalErrors).toEqual([]);

  expect(await page.evaluate(() => (window as any).DAVFS.mountPoint)).toBe('/home/web_user');

  const configResponse = await request.get('/persist/scummvm.ini');
  expect(configResponse.status()).toBe(200);
  expect(await configResponse.text()).toContain('[scummvm]');

  await page.evaluate(async () => {
    const runtime = window as any;
    runtime.FS.writeFile('/home/web_user/davfs-empty.txt', new Uint8Array(0));
    await runtime.DAVFS.drain();
  });
  const emptyFile = await request.get('/persist/davfs-empty.txt');
  expect(emptyFile.status()).toBe(200);
  expect(await emptyFile.body()).toHaveLength(0);

  await page.evaluate(async () => {
    const runtime = window as any;
    runtime.FS.writeFile(
      '/home/web_user/davfs-empty.txt',
      new TextEncoder().encode('temporary contents'),
    );
    await runtime.DAVFS.drain();
    runtime.FS.writeFile('/home/web_user/davfs-empty.txt', new Uint8Array(0));
    await runtime.DAVFS.drain();
  });
  const truncatedFile = await request.get('/persist/davfs-empty.txt');
  expect(await truncatedFile.body()).toHaveLength(0);

  const putBodies: string[] = [];
  let releaseFirstPut!: () => void;
  const firstPutReleased = new Promise<void>((resolve) => {
    releaseFirstPut = resolve;
  });
  let firstPutStartedResolve!: () => void;
  const firstPutStarted = new Promise<void>((resolve) => {
    firstPutStartedResolve = resolve;
  });
  await page.route('**/persist/davfs-order.txt', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    putBodies.push(route.request().postData() ?? '');
    if (putBodies.length === 1) {
      firstPutStartedResolve();
      await firstPutReleased;
    }
    await route.continue();
  });

  await page.evaluate(() => {
    const runtime = window as any;
    runtime.FS.writeFile(
      '/home/web_user/davfs-order.txt',
      new TextEncoder().encode('first'),
    );
  });
  await firstPutStarted;
  await page.evaluate(() => {
    const runtime = window as any;
    runtime.FS.writeFile(
      '/home/web_user/davfs-order.txt',
      new TextEncoder().encode('second'),
    );
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
  });
  releaseFirstPut();
  await page.evaluate(async () => {
    await (window as any).DAVFS.drain();
  });
  await expect.poll(() => putBodies).toEqual(['first', 'second']);
  const orderedFile = await request.get('/persist/davfs-order.txt');
  expect(await orderedFile.text()).toBe('second');

  await request.delete('/persist/davfs-empty.txt');
  await request.delete('/persist/davfs-order.txt');

  const scriptResponse = await request.get('/scummvm.js');
  expect(scriptResponse.headers()['cache-control']).toContain('no-cache');
  const wasmResponse = await request.get('/scummvm.wasm');
  expect(wasmResponse.headers()['cache-control']).toContain('no-cache');

  // Regression: dlopen()ed engine plugins must load from clean origin-rooted
  // URLs. Without the locateFile patch Emscripten requests
  // "https://host//data/plugins/libsky.so" (double slash), which path-prefix
  // auth proxies such as Envoy ext_authz mangle into an unservable path.
  const doubleSlashRequests: string[] = [];
  page.on('request', (pageRequest) => {
    if (new URL(pageRequest.url()).pathname.startsWith('//')) {
      doubleSlashRequests.push(pageRequest.url());
    }
  });
  const pluginLoaded = page.waitForResponse(
    (response) => response.url().endsWith('/data/plugins/libsky.so') && response.ok(),
    { timeout: 90_000 },
  );
  await page.goto('/scummvm.html#--path=/data/games/BASS-Floppy-1.3 sky');
  await pluginLoaded;
  await page.waitForTimeout(5_000);
  expect(doubleSlashRequests).toEqual([]);
  expect(fatalErrors).toEqual([]);

  // Read-ahead: booting the game reads chunk 1 of sky.dsk (8.8 MB = 2 chunks),
  // which must trigger a background prefetch of chunk 2 into the chunk cache.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as any).FS.analyzePath('/.cache/data/games/BASS-Floppy-1.3/sky.dsk.002')
              .exists,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
});
