// Renders src/icons/icon.svg to the PNG sizes Chrome uses. The PNGs are
// committed, so this only needs to run after changing the SVG:
//   node scripts/icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const dir = path.resolve(import.meta.dirname, '..', 'src', 'icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');

// Chrome Web Store guidelines: the 128px icon keeps a 16px transparent margin.
const sizes = { 16: 0, 32: 0, 48: 2, 128: 16 };

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [size, margin] of Object.entries(sizes)) {
  await page.setViewportSize({ width: Number(size), height: Number(size) });
  await page.setContent(
    `<body style="margin:0;background:transparent">
       <div id="icon" style="width:${size}px;height:${size}px;padding:${margin}px;box-sizing:border-box">
         ${svg.replace('<svg ', '<svg width="100%" height="100%" ')}
       </div>
     </body>`,
  );
  await page.locator('#icon').screenshot({ path: path.join(dir, `icon${size}.png`), omitBackground: true });
  console.log(`icon${size}.png`);
}
await browser.close();
