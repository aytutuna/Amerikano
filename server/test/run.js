// Runs the server suite the way a person would by hand: free ports, throwaway keys and env file, a fresh local
// database, wrangler dev, play.js, then everything is stopped. Extra arguments go to play.js.
// With --serve <file> it stops after wrangler dev is up: it writes the ports and the webhook key to <file> as JSON, answers
// as RevenueCat on its port and runs until it is killed, for the browser tests.
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const server = path.join(__dirname, '..');
const wrangler = path.join(server, 'node_modules/wrangler/bin/wrangler.js');
const adminKey = crypto.randomBytes(24).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// all the ports are held open together, so no two of them can be the same
async function freePorts(n) {
  const held = [];
  for (let i = 0; i < n; i++) {
    const s = net.createServer();
    await new Promise(res => s.listen(0, res));
    held.push(s);
  }
  const ports = held.map(s => s.address().port);
  await Promise.all(held.map(s => new Promise(res => s.close(res))));
  return ports;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amk-test-'));
const persist = path.join(tmp, 'state');
const logFile = process.env.AMK_WRANGLER_LOG || path.join(tmp, 'wrangler.log');
let dev, play;
let stopping = false;

function kill(p) {
  if (!p) return;
  if (process.platform === 'win32') {
    if (p.exitCode === null && !p.signalCode) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    // the group outlives its leader, so signal it even when the leader has already exited
    try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { /* group already gone */ }
  }
}

// children whose parent died are out of reach of taskkill /T, so find what is left by the temp dir in its command line
function sweep() {
  if (process.platform !== 'win32') return;
  const q = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" + path.basename(tmp) + "*' -and $_.ProcessId -ne $PID -and $_.ProcessId -ne " + process.pid + " } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
  spawnSync('powershell', ['-NoProfile', '-Command', q], { stdio: 'ignore', timeout: 30000 });
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  kill(play);
  kill(dev);
  sweep();
  if (code) {
    let tail = '';
    try { tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n'); } catch (e) { /* no log yet */ }
    console.error('--- end of ' + logFile + '\n' + tail);
  } else {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* wrangler may still hold a file */ }
  }
  process.exit(code);
}
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(process.argv[2] === '--serve' ? 0 : 143));

function devVars(p) {
  const ec = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const fcm = { type: 'service_account', client_email: 'push-test@amerikano-test.iam.gserviceaccount.com', private_key: rsa };
  const host = k => 'http://localhost:' + p[k];
  return [
    'PACE=0.02',
    'APPLE_BASE=' + host('APPLE'),
    'APPLE_KEY=' + ec(),
    'APNS_KEY=' + ec(),
    'APNS_KEY_ID=testkid',
    'APNS_BASE=' + host('APNS'),
    'APNS_SANDBOX=' + host('SANDBOX'),
    'FCM_BASE=' + host('FCM'),
    'FCM_TOKEN_URL=' + host('FCM') + '/token',
    'FCM_KEY=\'' + JSON.stringify(fcm) + '\'',
    'GOOGLE_BASE=' + host('GOOGLE'),
    'GOOGLE_CLIENTS=web.apps.googleusercontent.com,ios.apps.googleusercontent.com',
    'REALTIME_APP_ID=testapp',
    'REALTIME_APP_TOKEN=testtoken',
    'RTC_BASE=' + host('SFU'),
    'RC_WEBHOOK_AUTH=test-hook-auth',
    'RC_SECRET_KEY=sk_test',
    'RC_API=' + host('RC'),
    'ADMIN_KEY=' + adminKey,
    'HUB_SILENT=30',
    '',
  ].join('\n');
}

async function up(url, limit) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (dev.exitCode !== null) throw new Error('wrangler dev exited with ' + dev.exitCode);
    try {
      await fetch(url, { signal: AbortSignal.timeout(3000) });
      return;
    } catch (e) { await sleep(500); }
  }
  throw new Error('the worker did not answer on ' + url + ' within ' + limit / 1000 + ' s');
}

(async () => {
  const names = ['WORKER', 'INSPECTOR', 'APPLE', 'APNS', 'SANDBOX', 'FCM', 'GOOGLE', 'SFU', 'RC'];
  const ports = Object.fromEntries((await freePorts(names.length)).map((p, i) => [names[i], p]));
  const vars = path.join(tmp, 'dev.vars');
  fs.writeFileSync(vars, devVars(ports));

  const log = fs.openSync(logFile, 'a');
  const mig = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'amerikano', '--local', '--persist-to', persist], { cwd: server, stdio: ['ignore', log, log], timeout: 180000 });
  if (mig.status !== 0) throw new Error('migrations failed (' + (mig.status === null ? 'timeout' : mig.status) + ')');

  const opts = { cwd: server, stdio: ['ignore', log, log], detached: process.platform !== 'win32' };
  dev = spawn(process.execPath, [wrangler, 'dev', '--port', ports.WORKER, '--inspector-port', ports.INSPECTOR, '--env-file', vars, '--test-scheduled', '--persist-to', persist], opts);
  await up('http://localhost:' + ports.WORKER + '/api/me', 120000);

  if (process.argv[2] === '--serve') {
    // no purchases of its own: the browser tests credit them through the webhook, so the sync call finds nothing new
    http.createServer((q, r) => r.writeHead(200, { 'Content-Type': 'application/json' }).end('{"subscriber":{}}')).listen(ports.RC);
    fs.writeFileSync(process.argv[3] + '.tmp', JSON.stringify({ port: ports.WORKER, hook: 'test-hook-auth', admin: adminKey }));
    fs.renameSync(process.argv[3] + '.tmp', process.argv[3]);
    return;
  }

  const env = Object.assign({}, process.env, { PERSIST: persist, DEV_VARS: vars, ADMIN_KEY: adminKey, URL: 'ws://localhost:' + ports.WORKER });
  for (const k of names) env['PORT_' + k] = ports[k];
  play = spawn(process.execPath, [path.join(__dirname, 'play.js'), ...process.argv.slice(2)], { cwd: server, stdio: 'inherit', env, detached: process.platform !== 'win32' });
  const code = await new Promise(res => play.on('exit', (c, sig) => res(c === null ? 1 : c)));
  stop(code);
})().catch(e => {
  console.error(e.message);
  stop(1);
});
