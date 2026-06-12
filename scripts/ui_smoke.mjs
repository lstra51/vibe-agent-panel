import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const username = process.env.VIBE_WEB_USER;
const password = process.env.VIBE_WEB_PASSWORD;
const baseURL = process.env.VIBE_WEB_URL || 'http://101.42.200.52/';
const output = process.env.VIBE_SCREENSHOT || 'output/playwright/vibe-remote-dashboard.png';

if (!username || !password) {
  throw new Error('VIBE_WEB_USER and VIBE_WEB_PASSWORD are required');
}

mkdirSync(output.split('/').slice(0, -1).join('/'), { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 980 },
  httpCredentials: { username, password },
});
await page.goto(baseURL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('text=Vibe Remote', { timeout: 30000 });
await page.waitForSelector('text=远程 Vibe Coding 控制台', { timeout: 30000 });
await page.screenshot({ path: output, fullPage: true });
const title = await page.locator('h1').first().textContent();
const cards = await page.locator('.metric').count();
const panels = await page.locator('.panel').count();
console.log(JSON.stringify({ title, cards, panels, output }));
await browser.close();
