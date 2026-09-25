// Render docs/pet-shishi-preview.html to PNGs.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PAGE = process.env.SHISHI_URL || ('http://127.0.0.1:8711/pet-shishi-preview.html');
const OUT = path.join(ROOT, 'docs', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const EXEC =
  process.env.PW_EXEC ||
  [
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1200', 'chrome-win64', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1200', 'chrome-win', 'chrome'),
  ].find((p) => fs.existsSync(p));

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 800, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(PAGE, { waitUntil: 'load' });
  await page.waitForTimeout(500);

  const shots = [
    ['#hero', 'shishi-hero.png'],
    ['#real', 'shishi-real-size.png'],
    ['#moods', 'shishi-states.png'],
  ];
  for (const [sel, file] of shots) {
    const el = await page.$(sel);
    if (!el) { console.error('missing', sel); continue; }
    await el.screenshot({ path: path.join(OUT, file) });
    console.log('wrote', file);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });