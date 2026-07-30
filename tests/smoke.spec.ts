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
  expect(catalog.some((game: { id: string }) => game.id === 'sky:sky')).toBe(true);

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
});
