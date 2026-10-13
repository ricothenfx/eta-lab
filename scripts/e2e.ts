/**
 * E2E smoke test: loads the app in headless Chrome, waits for the map to be
 * fully rendered, runs the BEFORE/AFTER comparison end-to-end and takes
 * screenshots. Uses the system Chrome via puppeteer-core.
 *
 *   npm run e2e            — against http://localhost:3100
 *   BASE_URL=http://… npm run e2e
 */
import puppeteer, { type Page } from 'puppeteer-core';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:3100';
const OUT = path.resolve(import.meta.dirname, '../e2e-out');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForResults(page: Page, timeoutMs = 240_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const done = await page.evaluate(() =>
      Boolean(document.querySelector('table') && document.body.innerText.includes('ETA error')),
    );
    if (done) return;
    await sleep(1500);
  }
  throw new Error('results table did not appear in time');
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--enable-unsafe-swiftshader',
      '--window-size=1600,900',
    ],
    defaultViewport: { width: 1600, height: 900 },
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: unknown) => errors.push(`pageerror: ${e instanceof Error ? e.message : String(e)}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('ReadPixels')) errors.push(`console: ${m.text()}`);
  });

  console.log('1. load', BASE);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction('window.__etaMap != null', { timeout: 60_000 });
  console.log('2. map instance ready — waiting for idle render…');
  await page.evaluate(() => (window as any).__etaMap.once('idle'));
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, '01-map-initial.png') });
  // NOTE: readPixels on a composited WebGL canvas is always transparent, so we
  // verify rendering via the composited screenshot size instead (blank ≈ 45 KiB,
  // rendered basemap ≈ 300+ KiB).
  const initialShot = statSync(path.join(OUT, '01-map-initial.png')).size;
  console.log(`3. initial screenshot ${(initialShot / 1024).toFixed(0)} KiB`);

  console.log('4. clicking Run BEFORE vs AFTER…');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Run BEFORE vs AFTER'),
    );
    if (!btn) throw new Error('run button not found');
    (btn as HTMLButtonElement).click();
  });

  // live progress peek
  await sleep(4000);
  const progressPeek = await page.evaluate(() => document.body.innerText.match(/[BA][EFLOT: 0-9/]+orders.*/)?.[0] ?? '');
  if (progressPeek) console.log('   progress:', progressPeek.trim().slice(0, 80));

  console.log('5. waiting for both runs to finish…');
  await waitForResults(page);
  await sleep(1200);
  await page.screenshot({ path: path.join(OUT, '02-after-results.png') });

  console.log('6. switch to BEFORE view and replay end');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'BEFORE');
    (btn as HTMLButtonElement).click();
  });
  await sleep(500);
  await page.evaluate(() => {
    const range = document.querySelector('input[type="range"]') as HTMLInputElement | null;
    if (!range) throw new Error('replay slider not found');
    range.value = String(Number(range.max) * 0.45);
    range.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(700);
  await page.screenshot({ path: path.join(OUT, '03-before-replay.png') });

  const summary = await page.evaluate(() => {
    const table = document.querySelector('table');
    return table ? table.innerText.replace(/\t/g, ' | ') : 'NO TABLE';
  });
  console.log('7. results table:\n' + summary);

  writeFileSync(path.join(OUT, 'console-errors.json'), JSON.stringify(errors, null, 2));
  console.log(`8. console errors (non-noise): ${errors.length}`);
  if (errors.length) console.log(errors.slice(0, 10).join('\n'));

  await browser.close();

  const renderedShot = statSync(path.join(OUT, '03-before-replay.png')).size;
  if (initialShot < 120 * 1024 || renderedShot < 120 * 1024) {
    throw new Error(`screenshots suspiciously small (${initialShot}/${renderedShot} B) — basemap did not render`);
  }
  console.log('E2E PASSED ✓');
}

main().catch((e) => {
  console.error('E2E FAILED:', e.message);
  process.exit(1);
});
