// Starts the server the way the suite does (server/test/run.js --serve) and a static server for www/ that points the client at it.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '../..');
const www = path.join(root, 'www');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function site(api) {
  return http.createServer((q, s) => {
    let p = decodeURIComponent(q.url.split('?')[0]);
    if (p === '/' || /^\/t\/[A-Za-z]{4}$/.test(p)) p = '/index.html';
    const f = path.join(www, p);
    if (!f.startsWith(www) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      s.writeHead(404);
      return s.end();
    }
    let b = fs.readFileSync(f);
    if (f.endsWith('.js')) b = Buffer.from(b.toString('utf8').replace(/localhost:8787/g, 'localhost:' + api));
    s.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    s.end(b);
  });
}

module.exports = async () => {
  fs.rmSync(path.join(__dirname, 'out', 'cutoff.txt'), { force: true });
  const info = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'amk-browser-')), 'serve.json');
  const logFile = path.join(path.dirname(info), 'wrangler.log');
  const dev = spawn(process.execPath, [path.join(root, 'server/test/run.js'), '--serve', info], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { AMK_WRANGLER_LOG: process.env.AMK_WRANGLER_LOG || logFile }),
    detached: process.platform !== 'win32',
  });
  let exited = false;
  dev.on('exit', () => { exited = true; });
  for (let i = 0; !fs.existsSync(info); i++) {
    if (exited || i > 600) {
      if (!exited) dev.kill('SIGTERM');
      throw new Error('the server did not come up (see its output above)');
    }
    await sleep(500);
  }
  const { port, hook, admin, persist } = JSON.parse(fs.readFileSync(info, 'utf8'));
  const web = site(port);
  await new Promise(r => web.listen(0, '127.0.0.1', r));
  process.env.AMK_WEB = 'http://localhost:' + web.address().port;
  process.env.AMK_API = 'http://localhost:' + port;
  process.env.AMK_HOOK = hook;
  process.env.AMK_ADMIN = admin;
  process.env.AMK_PERSIST = persist;

  return async () => {
    web.close();
    if (exited) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(dev.pid), '/T', '/F'], { stdio: 'ignore' });
    else {
      // run.js stops wrangler's own process group on SIGTERM
      dev.kill('SIGTERM');
      for (let i = 0; i < 40 && !exited; i++) await sleep(250);
    }
  };
};
