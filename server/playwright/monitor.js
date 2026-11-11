import { chromium } from 'playwright';

const targetUrl = process.env.NRVI_MONITOR_URL;
const durationMs = Number(process.env.NRVI_MONITOR_DURATION_MS || 10000);

if (!targetUrl) {
  throw new Error('Configura NRVI_MONITOR_URL con la URL que quieras monitorear.');
}

if (!/^https?:\/\//i.test(targetUrl)) {
  throw new Error('NRVI_MONITOR_URL debe usar http:// o https://.');
}

const events = [];
const record = (type, details = {}) => {
  events.push({ timestamp: new Date().toISOString(), type, ...details });
};

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('console', message => record('console', {
    level: message.type(),
    text: message.text()
  }));
  page.on('pageerror', error => record('pageerror', { error: error.message }));
  page.on('requestfailed', request => record('requestfailed', {
    url: request.url(),
    method: request.method(),
    error: request.failure()?.errorText || 'unknown'
  }));
  page.on('response', response => {
    if (response.status() >= 400) {
      record('http-error', {
        url: response.url(),
        status: response.status(),
        method: response.request().method()
      });
    }
  });

  const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  record('page-loaded', {
    url: page.url(),
    status: response?.status() || null,
    title: await page.title()
  });
  await page.waitForTimeout(durationMs);
  record('monitor-finished', { durationMs, url: page.url() });
  process.stdout.write(`${JSON.stringify({ ok: true, targetUrl, events }, null, 2)}\n`);
} finally {
  await browser.close();
}
