// Captura screenshots de cada módulo de MOS (sin WMS) para el manual.
// Usa Playwright (cache de npx) + Edge del sistema (channel msedge).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3001';
const EMAIL = 'ceo.dashboard@prosper-mfg.com';
const PASSWORD = 'CEODash2024!';
const OUT = path.resolve(__dirname, '..', '..', 'ceo-dashboard', 'docs', 'manual-img');

// Rutas a capturar (excluye /wms y /pda). delay = ms extra de espera de datos.
const ROUTES = [
  { slug: '01-login',          url: '/',                     auth: false, delay: 1500 },
  { slug: '02-home',           url: '/home',                 delay: 2000 },
  { slug: '03-dashboard',      url: '/dashboard',            delay: 4000 },
  { slug: '04-operator',       url: '/operator',             delay: 3000 },
  { slug: '05-qc',             url: '/qc',                   delay: 3000 },
  { slug: '06-art',            url: '/art',                  delay: 3000 },
  { slug: '07-shipping',       url: '/shipping',             delay: 3000 },
  { slug: '08-packing',        url: '/packing',              delay: 3000 },
  { slug: '09-registros',      url: '/registros',            delay: 3000 },
  { slug: '10-agenda',         url: '/agenda',               delay: 3000 },
  { slug: '11-insights',       url: '/insights',             delay: 3000 },
  { slug: '12-ceo-dashboard',  url: '/ceo-dashboard',        delay: 4000 },
  { slug: '13-users',          url: '/users',                delay: 3000 },
  { slug: '14-catalog',        url: '/catalog-center',       delay: 3000 },
  { slug: '15-operators',      url: '/operators-center',     delay: 3000 },
  { slug: '16-automation',     url: '/automation-center',    delay: 3000 },
  { slug: '17-activity-log',   url: '/activity-log',         delay: 3000 },
  { slug: '18-reportes',       url: '/reportes-programados', delay: 3000 },
  { slug: '19-backups',        url: '/backups',              delay: 3000 },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.25 });
  const page = await context.newPage();
  const results = [];

  // --- Login ---
  console.log('Abriendo landing...');
  await page.goto(BASE + '/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1500);
  // Captura landing antes de loguear
  await page.screenshot({ path: path.join(OUT, '01-login.png') });
  results.push('01-login');

  console.log('Login...');
  await page.click('[data-testid="show-email-login-btn"]', { timeout: 10000 });
  await page.fill('[data-testid="login-email-input"]', EMAIL);
  await page.fill('[data-testid="login-password-input"]', PASSWORD);
  await page.click('[data-testid="login-email-submit-btn"]');
  await page.waitForURL('**/dashboard', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);
  console.log('Logueado. URL =', page.url());

  // --- Resto de rutas ---
  for (const r of ROUTES) {
    if (r.slug === '01-login') continue;
    try {
      console.log('Capturando', r.url);
      await page.goto(BASE + r.url, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {});
      await page.waitForTimeout(r.delay || 2500);
      await page.screenshot({ path: path.join(OUT, r.slug + '.png') });
      results.push(r.slug + ' (' + page.url() + ')');
    } catch (e) {
      console.log('  ! error en', r.url, e.message);
      results.push(r.slug + ' ERROR: ' + e.message);
    }
  }

  await browser.close();
  console.log('\n=== RESUMEN ===');
  results.forEach(x => console.log(' -', x));
  console.log('\nGuardado en:', OUT);
})();
