// Zero-dependency static site build: src/ -> dist/ (or --out <dir>).
// Resolves {{BASE}} / {{SITE_URL}} tokens, expands partials, fingerprints CSS/JS,
// and writes sitemap.xml, robots.txt, manifest.webmanifest, .nojekyll and CNAME.
import { readFile, writeFile, mkdir, readdir, rm, copyFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'src');
const argv = process.argv.slice(2);
const OUT = path.resolve(root, argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'dist');

const cfg = JSON.parse(await readFile(path.join(root, 'site.config.json'), 'utf8'));
const imgManifest = JSON.parse(await readFile(path.join(SRC, 'assets/img/manifest.json'), 'utf8'));

// ---------- site URL + base path ----------
const normBase = (p) => {
  const t = (p || '').replace(/\/+$/, '');
  return t === '' ? '' : t.startsWith('/') ? t : `/${t}`;
};

function resolveSite() {
  // Empty strings (for example from a skipped CI step) count as "not set".
  const envUrl = process.env.SITE_URL || undefined;
  const envBase = process.env.BASE_PATH || undefined;
  // An explicit non-empty BASE_PATH is a deliberate override (for example subpath testing).
  if (envBase !== undefined) {
    const origin = envUrl ? new URL(envUrl).origin : 'http://localhost:4173';
    const base = normBase(envBase);
    return { base, siteUrl: origin + base };
  }
  // A configured custom domain always wins: CI reports http:// until HTTPS is enforced.
  if (cfg.customDomain) return { base: '', siteUrl: `https://${cfg.customDomain}` };
  if (envUrl) {
    const u = new URL(envUrl);
    const base = normBase(u.pathname);
    return { base, siteUrl: u.origin + base };
  }
  if (cfg.siteUrl) {
    const u = new URL(cfg.siteUrl);
    const base = envBase !== undefined ? normBase(envBase) : normBase(u.pathname);
    return { base, siteUrl: u.origin + base };
  }
  const base = normBase(envBase);
  return { base, siteUrl: `http://localhost:4173${base}` };
}

const { base: BASE, siteUrl: SITE_URL } = resolveSite();
const BUILD_DATE = process.env.BUILD_DATE || new Date().toISOString().slice(0, 10);
const LIVE = Boolean(cfg.appStoreUrl);

// ---------- helpers ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);
const exists = async (p) => stat(p).then(() => true, () => false);

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,>])\s*/g, '$1')
    .replace(/:\s+/g, ':')
    .replace(/;}/g, '}')
    .trim();
}

function parseFrontMatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) throw new Error('Missing front matter');
  const data = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    data[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return { data, body: raw.slice(m[0].length) };
}

const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&rsquo;/g, '’').replace(/&nbsp;/g, ' ');
const textOf = (html) => decode(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// ---------- static assets (fingerprinted) ----------
await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, 'assets/css'), { recursive: true });
await mkdir(path.join(OUT, 'assets/js'), { recursive: true });

const assets = {};
for (const name of ['styles', 'nojs']) {
  const css = minifyCss(await readFile(path.join(SRC, `assets/css/${name}.css`), 'utf8'));
  const file = `${name}.${sha(css)}.css`;
  await writeFile(path.join(OUT, 'assets/css', file), css);
  assets[name] = `${BASE}/assets/css/${file}`;
}
{
  const js = await readFile(path.join(SRC, 'assets/js/main.js'), 'utf8');
  const file = `main.${sha(js)}.js`;
  await writeFile(path.join(OUT, 'assets/js', file), js);
  assets.js = `${BASE}/assets/js/${file}`;
}

// ---------- <picture> ----------
const SIZES = {
  hero: '(min-width: 900px) 400px, min(86vw, 360px)',
  feature: '(min-width: 900px) 340px, min(80vw, 320px)',
  gallery: '(min-width: 600px) 300px, 70vw',
  icon: '40px',
};

function pictureHtml(a) {
  const meta = imgManifest[a.id];
  if (!meta) throw new Error(`Unknown image id: ${a.id}`);
  const sizes = a.sizes?.startsWith('@') ? SIZES[a.sizes.slice(1)] : a.sizes || SIZES.feature;
  const set = (ext) => meta.widths.map((w) => `${BASE}/assets/img/${a.id}-${w}.${ext} ${w}w`).join(', ');
  const fallbackW = meta.widths.includes(640) ? 640 : meta.widths[meta.widths.length - 1];
  const loading = a.loading || 'lazy';
  const attrs = [
    `src="${BASE}/assets/img/${a.id}-${fallbackW}.${a.fallback || 'jpg'}"`,
    `srcset="${set(a.fallback || 'jpg')}"`,
    `sizes="${esc(sizes)}"`,
    `width="${meta.width}"`,
    `height="${meta.height}"`,
    `alt="${esc(a.alt ?? '')}"`,
    `loading="${loading}"`,
    `decoding="async"`,
  ];
  if (a.priority) attrs.push('fetchpriority="high"');
  if (a.class) attrs.push(`class="${esc(a.class)}"`);
  return `<picture><source type="image/avif" srcset="${set('avif')}" sizes="${esc(sizes)}">` +
    `<source type="image/webp" srcset="${set('webp')}" sizes="${esc(sizes)}"><img ${attrs.join(' ')}></picture>`;
}

// ---------- partial helpers ----------
const DL_ICON = '<svg class="btn__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>';

const helpers = {
  picture: (a) => pictureHtml(a),

  wordmark: () => {
    const m = imgManifest.wordmark;
    return `<picture><source type="image/webp" srcset="${BASE}/assets/img/wordmark-600.webp">` +
      `<img class="wordmark-img" src="${BASE}/assets/img/wordmark-600.png" width="${m.width}" height="${m.height}" alt="" decoding="async"></picture>`;
  },

  cta: (a) => {
    const cls = ['btn', a.variant === 'light' ? 'btn--light' : 'btn--primary', a.size === 'sm' ? 'btn--sm' : '', a.class || '']
      .filter(Boolean).join(' ');
    if (LIVE) {
      return `<a class="${cls}" href="${esc(cfg.appStoreUrl)}" rel="noopener">${DL_ICON}<span>${a.short ? 'Get the app' : 'Download on the App Store'}</span></a>`;
    }
    return `<button type="button" class="${cls}" disabled>${DL_ICON}<span>${a.short ? 'Coming soon' : 'Coming soon on the App Store'}</span></button>`;
  },

  'cta-note': () => (LIVE ? '' : '<p class="cta-note">Launching on the App Store soon. This page will link straight to it the moment it is live.</p>'),

  head: (a, ctx) => {
    const p = ctx.page;
    const canonical = `${SITE_URL}${p.path}`;
    const ogImage = `${SITE_URL}/assets/img/og-image.png`;
    const noindex = p.noindex === 'true';
    const out = [
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'">`,
      '<meta name="referrer" content="strict-origin-when-cross-origin">',
      `<title>${esc(p.title)}</title>`,
      `<meta name="description" content="${esc(p.description)}">`,
      noindex ? '<meta name="robots" content="noindex, nofollow">' : '<meta name="robots" content="index, follow, max-image-preview:large">',
      `<meta name="base-path" content="${BASE}">`,
      '<meta name="color-scheme" content="light dark">',
      '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">',
      '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0e1116">',
    ];
    if (!noindex) {
      out.push(`<link rel="canonical" href="${canonical}">`,
        `<link rel="alternate" hreflang="en-SG" href="${canonical}">`,
        `<link rel="alternate" hreflang="x-default" href="${canonical}">`);
    }
    if (p.path === '/' && cfg.appStoreId) out.push(`<meta name="apple-itunes-app" content="app-id=${esc(cfg.appStoreId)}">`);
    out.push(
      `<link rel="icon" href="${BASE}/assets/icons/favicon.ico" sizes="48x48">`,
      `<link rel="icon" type="image/png" sizes="32x32" href="${BASE}/assets/icons/favicon-32.png">`,
      `<link rel="icon" type="image/png" sizes="16x16" href="${BASE}/assets/icons/favicon-16.png">`,
      `<link rel="apple-touch-icon" href="${BASE}/assets/icons/apple-touch-icon.png">`,
      `<link rel="manifest" href="${BASE}/manifest.webmanifest">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:site_name" content="${esc(cfg.siteName)}">`,
      `<meta property="og:locale" content="en_SG">`,
      `<meta property="og:title" content="${esc(p.title)}">`,
      `<meta property="og:description" content="${esc(p.description)}">`,
      `<meta property="og:url" content="${canonical}">`,
      `<meta property="og:image" content="${ogImage}">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta property="og:image:alt" content="ChildrenGoWhere app showing weekend picks, nearby places and trending family spots in Singapore">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:title" content="${esc(p.title)}">`,
      `<meta name="twitter:description" content="${esc(p.description)}">`,
      `<meta name="twitter:image" content="${ogImage}">`,
      `<meta name="twitter:image:alt" content="ChildrenGoWhere app showing weekend picks, nearby places and trending family spots in Singapore">`,
    );
    if (p.preload) {
      const meta = imgManifest[p.preload];
      const srcset = meta.widths.map((w) => `${BASE}/assets/img/${p.preload}-${w}.avif ${w}w`).join(', ');
      out.push(`<link rel="preload" as="image" type="image/avif" imagesrcset="${srcset}" imagesizes="${esc(SIZES.hero)}" fetchpriority="high">`);
    }
    out.push(
      `<link rel="stylesheet" href="${assets.styles}">`,
      `<noscript><link rel="stylesheet" href="${assets.nojs}"></noscript>`,
      `<script src="${assets.js}" defer></script>`,
      '<!--@@JSONLD@@-->',
    );
    return out.join('\n');
  },
};

// ---------- template expansion ----------
const INC_RE = /\{\{>\s*([\w-]+)((?:\s+[\w-]+=(?:"[^"]*"|[^\s}]+))*)\s*\}\}/g;
const parseArgs = (s) => {
  const o = {};
  for (const m of s.matchAll(/([\w-]+)=(?:"([^"]*)"|([^\s}]+))/g)) o[m[1]] = m[2] ?? m[3];
  return o;
};

async function expand(html, ctx, depth = 0) {
  if (depth > 6) throw new Error('Partial nesting too deep');
  let out = '';
  let last = 0;
  for (const m of html.matchAll(INC_RE)) {
    out += html.slice(last, m.index);
    last = m.index + m[0].length;
    const [, name, rawArgs] = m;
    const args = parseArgs(rawArgs);
    if (helpers[name]) {
      out += helpers[name](args, ctx);
    } else {
      const file = path.join(SRC, 'partials', `${name}.html`);
      if (!(await exists(file))) throw new Error(`Missing partial: ${name}`);
      const part = (await readFile(file, 'utf8')).replace(/\{\{@([\w-]+)\}\}/g, (_, k) => args[k] ?? '');
      out += await expand(part, ctx, depth + 1);
    }
  }
  return out + html.slice(last);
}

function applyVars(html, vars) {
  return html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => (key in vars ? vars[key] : m));
}

// ---------- JSON-LD ----------
function faqFromHtml(html) {
  const items = [];
  const re = /<details class="faq-item">\s*<summary>([\s\S]*?)<\/summary>\s*<div class="faq-answer">([\s\S]*?)<\/div>\s*<\/details>/g;
  for (const m of html.matchAll(re)) items.push({ q: textOf(m[1]), a: textOf(m[2]) });
  return items;
}

function buildJsonLd(page, html) {
  const types = (page.schema || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!types.length) return '';
  const canonical = `${SITE_URL}${page.path}`;
  const org = { '@type': 'Organization', '@id': `${SITE_URL}/#org`, name: cfg.siteName, url: `${SITE_URL}/`,
    logo: { '@type': 'ImageObject', url: `${SITE_URL}/assets/icons/icon-512.png`, width: 512, height: 512 },
    email: cfg.contactEmail,
    contactPoint: { '@type': 'ContactPoint', contactType: 'customer support', email: cfg.contactEmail, areaServed: 'SG', availableLanguage: ['en'] } };
  const graph = [];
  if (types.includes('org')) graph.push(org);
  if (types.includes('website')) {
    graph.push({ '@type': 'WebSite', '@id': `${SITE_URL}/#website`, url: `${SITE_URL}/`, name: cfg.siteName, inLanguage: 'en-SG', publisher: { '@id': `${SITE_URL}/#org` } });
  }
  if (types.includes('app')) {
    const shots = Object.keys(imgManifest).filter((k) => /^shot-\d\d-full$/.test(k)).sort();
    const app = {
      '@type': 'MobileApplication', '@id': `${SITE_URL}/#app`, name: cfg.siteName, url: `${SITE_URL}/`,
      description: page.description, operatingSystem: 'iOS', softwareRequirements: 'Requires iOS 18.0 or later',
      applicationCategory: 'LifestyleApplication', inLanguage: 'en-SG', isAccessibleForFree: true,
      image: `${SITE_URL}/assets/img/og-image.png`,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'SGD' },
      screenshot: shots.map((id) => `${SITE_URL}/assets/img/${id}-960.jpg`),
      featureList: ['Filter by age, budget, distance and category', 'Quick filters such as Rainy Day and Free Entry',
        'Opening hours, best time to visit and weekly crowd levels', 'Directions in Apple Maps',
        'Family events with one-tap add to calendar', 'Favourites and collections'],
      publisher: { '@id': `${SITE_URL}/#org` },
    };
    if (LIVE) app.installUrl = cfg.appStoreUrl;
    graph.push(app);
  }
  if (types.includes('webpage')) {
    const wp = { '@type': 'WebPage', '@id': `${canonical}#webpage`, url: canonical, name: page.title, description: page.description,
      inLanguage: 'en-SG', isPartOf: { '@id': `${SITE_URL}/#website` } };
    if (page.modified) wp.dateModified = page.modified;
    graph.push(wp);
  }
  if (types.includes('breadcrumb')) {
    graph.push({ '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
      { '@type': 'ListItem', position: 2, name: page.breadcrumb, item: canonical }] });
  }
  if (types.includes('faq')) {
    const faq = faqFromHtml(html);
    if (!faq.length) throw new Error(`${page.file}: faq schema requested but no FAQ items found`);
    graph.push({ '@type': 'FAQPage', mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
  }
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

// ---------- render pages ----------
const PAGES = ['index.html', 'privacy/index.html', 'support/index.html', '404.html'];
const written = []; // { rel, text }
const sitemapEntries = [];

for (const rel of PAGES) {
  const raw = await readFile(path.join(SRC, rel), 'utf8');
  const { data, body } = parseFrontMatter(raw);
  for (const [k, v] of Object.entries(data)) {
    const ref = v.match(/^cfg\.(\w+)$/);
    if (ref) data[k] = String(cfg[ref[1]]);
  }
  const pagePath = rel === 'index.html' ? '/' : rel === '404.html' ? '/404.html' : `/${rel.replace(/index\.html$/, '')}`;
  const page = { ...data, path: pagePath, file: rel };
  const vars = {
    BASE, SITE_URL, BUILD_DATE, YEAR: BUILD_DATE.slice(0, 4),
    ...Object.fromEntries(Object.entries(cfg).map(([k, v]) => [`cfg.${k}`, String(v)])),
    ...Object.fromEntries(Object.entries(page).map(([k, v]) => [`page.${k}`, esc(v)])),
  };
  const ctx = { page };
  const shell = await readFile(path.join(SRC, 'partials/layout.html'), 'utf8');
  let html = shell.replace('{{@content}}', () => body).replace('{{@bodyClass}}', () => page.bodyClass || '');
  html = await expand(html, ctx);
  html = applyVars(html, vars);
  html = html.replace(/ data-nav="([^"]*)"/g, (_, v) => (v === page.path ? ' aria-current="page"' : ''));
  const jsonLd = buildJsonLd(page, html);
  html = html.replace('<!--@@JSONLD@@-->', () => jsonLd);
  const outFile = path.join(OUT, rel);
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, html);
  written.push({ rel, text: html });
  if (page.noindex !== 'true') {
    sitemapEntries.push({ loc: `${SITE_URL}${pagePath}`, lastmod: page.modified || BUILD_DATE });
  }
}

// ---------- generated files ----------
const manifest = {
  id: `${BASE}/`,
  name: cfg.siteName,
  short_name: cfg.siteName,
  description: cfg.tagline,
  lang: 'en-SG',
  start_url: `${BASE}/`,
  scope: `${BASE}/`,
  display: 'browser',
  theme_color: '#2978f5',
  background_color: '#ffffff',
  icons: [
    { src: `${BASE}/assets/icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
    { src: `${BASE}/assets/icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
  ],
};
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  sitemapEntries.map((e) => `  <url>\n    <loc>${e.loc}</loc>\n    <lastmod>${e.lastmod}</lastmod>\n  </url>`).join('\n') + '\n</urlset>\n';
const robots = `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;

for (const [name, text] of [['manifest.webmanifest', JSON.stringify(manifest, null, 2) + '\n'], ['sitemap.xml', sitemap], ['robots.txt', robots]]) {
  await writeFile(path.join(OUT, name), text);
  written.push({ rel: name, text });
}
await writeFile(path.join(OUT, '.nojekyll'), '');
if (cfg.customDomain) await writeFile(path.join(OUT, 'CNAME'), `${cfg.customDomain}\n`);

// ---------- copy only referenced images/icons ----------
const corpus = written.map((w) => w.text).join('\n');
const wanted = new Set();
for (const m of corpus.matchAll(/assets\/(img|icons)\/([\w.\-]+)/g)) wanted.add(`${m[1]}/${m[2]}`);
for (const f of ['icons/favicon.ico', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png']) wanted.add(f);
let copied = 0;
for (const rel of wanted) {
  const from = path.join(SRC, 'assets', rel);
  if (!(await exists(from))) throw new Error(`Referenced asset missing from src: assets/${rel}`);
  await mkdir(path.dirname(path.join(OUT, 'assets', rel)), { recursive: true });
  await copyFile(from, path.join(OUT, 'assets', rel));
  copied++;
}

// ---------- guard rails ----------
for (const w of written) {
  const left = w.text.match(/\{\{[^}]*\}\}|@@\w+@@/);
  if (left) throw new Error(`Unresolved token "${left[0]}" in ${w.rel}`);
}

let bytes = 0;
const walk = async (dir) => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else bytes += (await stat(p)).size;
  }
};
await walk(OUT);
console.log(`Built ${PAGES.length} pages, ${copied} assets -> ${path.relative(root, OUT) || '.'}`);
console.log(`  SITE_URL = ${SITE_URL}`);
console.log(`  BASE     = "${BASE}"`);
console.log(`  App Store link: ${LIVE ? 'live' : 'coming-soon state'}`);
console.log(`  Output size: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
