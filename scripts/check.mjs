// Link / asset / SEO / CSP sanity checks against a built site. Zero dependencies.
// Usage: node scripts/check.mjs [--dir dist]
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argIdx = process.argv.indexOf('--dir');
const DIR = path.resolve(root, argIdx > -1 ? process.argv[argIdx + 1] : 'dist');

const errors = [];
const warnings = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);

const files = [];
const walk = async (d) => {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) await walk(p);
    else files.push(p);
  }
};
await walk(DIR);
const rel = (p) => path.relative(DIR, p).split(path.sep).join('/');
const fileSet = new Set(files.map(rel));
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const htmlCache = new Map();
for (const f of htmlFiles) htmlCache.set(rel(f), await readFile(f, 'utf8'));

// ---------- site identity (read back from the built home page) ----------
const home = htmlCache.get('index.html');
if (!home) { console.error('dist/index.html missing'); process.exit(1); }
const BASE = home.match(/<meta name="base-path" content="([^"]*)"/)?.[1] ?? '';
const canonicalHome = home.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? '';
const SITE_URL = canonicalHome.replace(/\/$/, '');

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const textOf = (h) => h.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

// Map a URL path (already without origin) to a file in dist, or null if it is outside this site.
function localFileFor(urlPath, from) {
  if (BASE && urlPath !== BASE && !urlPath.startsWith(`${BASE}/`)) return { outside: true };
  let p = BASE ? urlPath.slice(BASE.length) || '/' : urlPath;
  p = p.split('?')[0];
  if (p.endsWith('/')) p += 'index.html';
  const key = p.replace(/^\//, '');
  if (!/\.[a-z0-9]+$/i.test(key)) {
    if (fileSet.has(`${key}/index.html`)) return { missingSlash: true };
    return { key, exists: false };
  }
  return { key, exists: fileSet.has(key) };
}

function checkUrl(page, rawUrl, kind) {
  const u = rawUrl.trim();
  if (!u || /^(mailto:|tel:|data:|javascript:)/i.test(u)) return;
  if (/^https?:\/\//i.test(u)) {
    if (SITE_URL && (u === SITE_URL || u.startsWith(`${SITE_URL}/`) || u.startsWith(`${SITE_URL}#`))) {
      const rest = u.slice(SITE_URL.length) || '/';
      return checkUrl(page, `${BASE}${rest}`, kind);
    }
    return; // external
  }
  if (u.startsWith('#')) {
    const id = decodeURIComponent(u.slice(1));
    if (id && id !== 'top' && !htmlCache.get(page)?.includes(`id="${id}"`)) err(page, `${kind} anchor ${u} has no matching id`);
    return;
  }
  if (!u.startsWith('/')) return err(page, `${kind} uses a relative URL "${u}" (use {{BASE}}-prefixed paths)`);
  const [pathPart, frag] = u.split('#');
  const res = localFileFor(pathPart, page);
  if (res.outside) return err(page, `${kind} "${u}" is root-absolute and ignores the base path "${BASE}"`);
  if (res.missingSlash) return err(page, `${kind} "${u}" is missing a trailing slash`);
  if (!res.exists) return err(page, `${kind} "${u}" -> missing file ${res.key}`);
  if (frag && res.key.endsWith('.html')) {
    const target = htmlCache.get(res.key);
    if (frag !== 'top' && target && !target.includes(`id="${decodeURIComponent(frag)}"`)) {
      err(page, `${kind} "${u}" points to missing id #${frag} in ${res.key}`);
    }
  }
}

// ---------- per-page checks ----------
const seenTitles = new Map();
const seenDescriptions = new Map();

for (const [page, html] of htmlCache) {
  const noindex = /<meta name="robots" content="noindex/.test(html);
  const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
  const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1];
  const decodeAmp = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

  if (!/^<!doctype html>/i.test(html)) err(page, 'missing <!doctype html>');
  if (!/<html lang="en-SG"/.test(html)) err(page, 'html lang should be en-SG');
  if (!title) err(page, 'missing <title>');
  if (!description) err(page, 'missing meta description');
  if (!/<meta name="viewport"/.test(html)) err(page, 'missing viewport meta');
  if (!/Content-Security-Policy/.test(html)) err(page, 'missing CSP meta');

  if (title) {
    const t = decodeAmp(title);
    if (!noindex && (t.length < 50 || t.length > 60)) err(page, `title is ${t.length} chars (want 50-60): "${t}"`);
    if (seenTitles.has(t)) err(page, `duplicate title with ${seenTitles.get(t)}`);
    seenTitles.set(t, page);
  }
  if (description) {
    const d = decodeAmp(description);
    if (!noindex && (d.length < 140 || d.length > 160)) err(page, `meta description is ${d.length} chars (want 140-160)`);
    if (seenDescriptions.has(d)) err(page, `duplicate description with ${seenDescriptions.get(d)}`);
    seenDescriptions.set(d, page);
  }

  if (!noindex) {
    const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
    const pagePath = page === 'index.html' ? '/' : `/${page.replace(/index\.html$/, '')}`;
    if (canonical !== `${SITE_URL}${pagePath}`) err(page, `canonical "${canonical}" != "${SITE_URL}${pagePath}"`);
    for (const tag of ['og:title', 'og:description', 'og:url', 'og:image', 'og:type', 'og:locale']) {
      if (!html.includes(`property="${tag}"`)) err(page, `missing ${tag}`);
    }
    if (!html.includes('name="twitter:card"')) err(page, 'missing twitter:card');
    if (!/hreflang="en-SG"/.test(html) || !/hreflang="x-default"/.test(html)) err(page, 'missing hreflang alternates');
  } else if (!html.includes('content="noindex')) {
    err(page, 'noindex page must have robots noindex');
  }

  const h1s = html.match(/<h1\b/g) || [];
  if (h1s.length !== 1) err(page, `expected exactly one <h1>, found ${h1s.length}`);
  let prev = 0;
  for (const m of html.matchAll(/<h([1-6])\b/g)) {
    const lvl = Number(m[1]);
    if (prev && lvl > prev + 1) err(page, `heading level jumps from h${prev} to h${lvl}`);
    prev = lvl;
  }

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) err(page, `duplicate ids: ${[...new Set(dup)].join(', ')}`);

  // CSP-compatibility: no inline script/style/handlers.
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
    const a = attrs(m[0]);
    if (!a.src && a.type !== 'application/ld+json') err(page, 'inline <script> would violate CSP');
  }
  if (/<style[\s>]/.test(html)) err(page, 'inline <style> would violate CSP');
  if (/\sstyle="/.test(html)) err(page, 'inline style="" attribute would violate CSP');
  if (/\son[a-z]+="/i.test(html)) err(page, 'inline event handler attribute');
  if (/target="_blank"/.test(html)) warn(page, 'target="_blank" used');

  // Images.
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (!('alt' in a)) err(page, `<img> without alt: ${a.src}`);
    if (!a.width || !a.height) err(page, `<img> without width/height: ${a.src}`);
  }

  // Links and assets.
  for (const m of html.matchAll(/<(a|link|script|img|source|iframe)\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a.href && m[1] !== 'a' && !/^https?:/.test(a.href) || (m[1] === 'a' && a.href)) checkUrl(page, a.href.replace(/&amp;/g, '&'), `<${m[1]} href>`);
    if (a.src) checkUrl(page, a.src, `<${m[1]} src>`);
    for (const key of ['srcset', 'imagesrcset']) {
      if (a[key]) for (const part of a[key].split(',')) checkUrl(page, part.trim().split(/\s+/)[0], `<${m[1]} ${key}>`);
    }
  }
  for (const m of html.matchAll(/<meta\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if ((a.property === 'og:image' || a.name === 'twitter:image' || a.property === 'og:url') && a.content) checkUrl(page, a.content, `<meta ${a.property || a.name}>`);
  }

  // Accessible names for links/buttons.
  for (const m of html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const a = attrs(`<x ${m[2]}>`);
    const inner = m[3];
    const hasImgAlt = /<img\b[^>]*alt="[^"]+"/.test(inner);
    if (!textOf(inner) && !a['aria-label'] && !hasImgAlt) err(page, `<${m[1]}> has no accessible name`);
  }

  // JSON-LD.
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (!noindex && ld.length === 0) err(page, 'no JSON-LD found');
  for (const block of ld) {
    let data;
    try { data = JSON.parse(block[1]); } catch (e) { err(page, `invalid JSON-LD: ${e.message}`); continue; }
    const strings = [];
    (function collect(v) {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    })(data);
    for (const s of strings) if (SITE_URL && s.startsWith(`${SITE_URL}/`) && /\.\w{2,5}$/.test(s)) checkUrl(page, s, 'JSON-LD url');
    const faq = (data['@graph'] || []).find((n) => n['@type'] === 'FAQPage');
    if (faq) {
      const visible = (html.match(/<details class="faq-item">/g) || []).length;
      if (faq.mainEntity.length !== visible) err(page, `FAQPage has ${faq.mainEntity.length} items but page shows ${visible}`);
    }
  }
}

// ---------- site-wide checks ----------
for (const f of files) {
  const k = rel(f);
  const size = (await stat(f)).size;
  if (size > 1024 * 1024) err(k, `file is ${(size / 1024 / 1024).toFixed(2)} MB (limit 1 MB)`);
  if (k !== 'CNAME' && k !== k.toLowerCase()) err(k, 'path must be lowercase (GitHub Pages is case-sensitive)');
  if (/iphone65/.test(k)) err(k, 'original screenshot must not be published');
  if (/^(node_modules|scripts|source-images)\//.test(k)) err(k, 'source folder leaked into dist');
}
if (!fileSet.has('.nojekyll')) err('.nojekyll', 'missing');
if (!fileSet.has('404.html')) err('404.html', 'missing');

if (fileSet.has('sitemap.xml')) {
  const sm = await readFile(path.join(DIR, 'sitemap.xml'), 'utf8');
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (!locs.length) err('sitemap.xml', 'no URLs');
  for (const l of locs) {
    if (!l.startsWith(SITE_URL)) err('sitemap.xml', `URL outside SITE_URL: ${l}`);
    else checkUrl('sitemap.xml', `${BASE}${l.slice(SITE_URL.length) || '/'}`, '<loc>');
    if (/404/.test(l)) err('sitemap.xml', '404 page must not be listed');
  }
} else err('sitemap.xml', 'missing');

if (fileSet.has('robots.txt')) {
  const robots = await readFile(path.join(DIR, 'robots.txt'), 'utf8');
  if (!robots.includes(`Sitemap: ${SITE_URL}/sitemap.xml`)) err('robots.txt', 'missing/incorrect Sitemap line');
} else err('robots.txt', 'missing');

if (fileSet.has('manifest.webmanifest')) {
  try {
    const mf = JSON.parse(await readFile(path.join(DIR, 'manifest.webmanifest'), 'utf8'));
    if (mf.start_url !== `${BASE}/`) err('manifest.webmanifest', `start_url "${mf.start_url}" != "${BASE}/"`);
    for (const icon of mf.icons) checkUrl('manifest.webmanifest', icon.src, 'icon');
  } catch (e) { err('manifest.webmanifest', `invalid JSON: ${e.message}`); }
} else err('manifest.webmanifest', 'missing');

let total = 0;
for (const f of files) total += (await stat(f)).size;
if (total > 15 * 1024 * 1024) warn('dist', `total size ${(total / 1024 / 1024).toFixed(1)} MB exceeds the 15 MB target`);

// ---------- report ----------
console.log(`Checked ${htmlFiles.length} pages, ${files.length} files (${(total / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  BASE="${BASE}"  SITE_URL=${SITE_URL}`);
for (const w of warnings) console.log(`  warn: ${w}`);
if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  x ${e}`);
  process.exit(1);
}
console.log('  All checks passed.');
