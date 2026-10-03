// Tiny static server that behaves like GitHub Pages, including project-site subpaths.
// Usage: node scripts/serve.mjs [--dir dist] [--port 4173] [--base /repo-name] [--pages-cache]
// By default responses are sent with no-cache so rebuilds show up immediately;
// --pages-cache mimics GitHub Pages' 10-minute cache.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const DIR = path.resolve(root, arg('dir', 'dist'));
const PORT = Number(arg('port', process.env.PORT || 4173));
const BASE = (arg('base', process.env.BASE_PATH || '') || '').replace(/\/+$/, '');
const CACHE = process.argv.includes('--pages-cache') ? 'max-age=600' : 'no-cache';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

const isFile = (p) => stat(p).then((s) => s.isFile(), () => false);
const isDir = (p) => stat(p).then((s) => s.isDirectory(), () => false);

// GitHub Pages compresses text responses; do the same so local audits match.
const COMPRESSIBLE = /^(text\/|application\/(json|xml|manifest\+json|javascript)|image\/svg)/;
function respond(req, res, status, type, body) {
  const headers = { 'Content-Type': type, 'Cache-Control': CACHE, Vary: 'Accept-Encoding' };
  if (COMPRESSIBLE.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    body = gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

async function notFound(req, res) {
  const body = await readFile(path.join(DIR, '404.html')).catch(() => Buffer.from('Not found'));
  respond(req, res, 404, TYPES['.html'], body);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);

  if (BASE) {
    if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404: this host serves the project site only under ' + BASE + '/');
    }
    pathname = pathname.slice(BASE.length) || '/';
  }

  const target = path.normalize(path.join(DIR, pathname));
  if (!target.startsWith(DIR)) return notFound(req, res);

  if (await isDir(target)) {
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { Location: `${BASE}${pathname}/${url.search}` });
      return res.end();
    }
    const index = path.join(target, 'index.html');
    if (await isFile(index)) return send(req, res, index);
    return notFound(req, res);
  }
  if (await isFile(target)) return send(req, res, target);
  return notFound(req, res);
}).listen(PORT, () => {
  console.log(`Serving ${path.relative(root, DIR)} at http://localhost:${PORT}${BASE}/`);
});

async function send(req, res, file) {
  respond(req, res, 200, TYPES[path.extname(file)] || 'application/octet-stream', await readFile(file));
}
