const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const ROOT = 'D:/03_Git/thihy_todolist';
const EXEC = [
  path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1200', 'chrome-win64', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1200', 'chrome-win', 'chrome'),
].find((p) => fs.existsSync(p));

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto('http://127.0.0.1:8711/pet-shishi-preview.html', { waitUntil: 'load' });
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => {
    const ears = Array.from(document.querySelectorAll('.ear'));
    return ears.map((e) => {
      const bb = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return {
        cls: e.getAttribute('class'),
        attrTransform: e.getAttribute('transform'),
        computedTransform: cs.transform,
        cssTransformBox: cs.transformBox,
        cssTransformOrigin: cs.transformOrigin,
        rect: { x: Math.round(bb.x), y: Math.round(bb.y), w: Math.round(bb.width), h: Math.round(bb.height) },
      };
    });
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });