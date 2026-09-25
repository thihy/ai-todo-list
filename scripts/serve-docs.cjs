// Tiny static server for docs/ — used only to preview shishi-pet.js over HTTP
// (file:// ESM is blocked by CORS in this Chromium).
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'docs');
const PORT = 8711;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/pet-shishi-preview.html';
  const full = path.join(ROOT, urlPath);
  if (!full.startsWith(ROOT) || !fs.existsSync(full)) {
    res.statusCode = 404;
    return res.end(`not found: ${urlPath}`);
  }
  res.setHeader('Content-Type', MIME[path.extname(full)] || 'application/octet-stream');
  fs.createReadStream(full).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));