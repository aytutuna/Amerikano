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

// the rules of www/_headers: a path on a line of its own, then its headers indented
function headerRules() {
  const rules = [];
  for (const l of fs.readFileSync(path.join(www, '_headers'), 'utf8').split('\n')) {
    if (!l.trim()) continue;
    if (l[0] !== ' ') rules.push({ path: l.trim(), headers: {} });
    else {
      const i = l.indexOf(':');
      rules[rules.length - 1].headers[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
  }
  return rules;
}

function site(api) {
  const rules = headerRules();
  // the page talks to the test server, which the policy does not know
  const own = h => h.replace('connect-src', 'connect-src http://localhost:' + api + ' ws://localhost:' + api);
  const send = (s, code, p, extra) => {
    const h = Object.assign({ 'Cache-Control': 'no-store' }, extra);
    for (const r of rules) {
      if (r.path !== '/*' && r.path !== p) continue;
      for (const [k, v] of Object.entries(r.headers)) h[k] = k === 'Content-Security-Policy' ? own(v) : v;
    }
    s.writeHead(code, h);
  };
  return http.createServer((q, s) => {
    let p = decodeURIComponent(q.url.split('?')[0]);
    const asked = p;
    if (p === '/' || /^\/t\/[A-Za-z]{4}$/.test(p)) p = '/index.html';
    let f = path.join(www, p);
    let code = 200;
    if (!f.startsWith(www) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      f = path.join(www, '404.html');
      code = 404;
    }
    let b = fs.readFileSync(f);
    if (f.endsWith('.js')) b = Buffer.from(b.toString('utf8').replace(/localhost:8787/g, 'localhost:' + api));
    send(s, code, asked, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
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
