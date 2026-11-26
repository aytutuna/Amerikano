const FROM = 'Amerikano reports <reports@alazy.app>';
const TO = 'support@alazy.app';
const HOURLY = 20;
const HOUR = 3600000;

// the test server points this at a fake; a deployed Worker always talks to Resend
const base = env => (env.PACE && env.RESEND_BASE) || 'https://api.resend.com';

async function post(env, subject, text) {
  try {
    const r = await fetch(base(env) + '/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [TO], subject: subject, text: text })
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

// One mail to support. The row is written first, so a mail that cannot go out waits for the digest, and past 20 sent in
// an hour the rest wait there too. Without a key nothing is kept or sent. Never throws: a report must not fail on its mail.
export async function mail(env, kind, report, subject, text) {
  if (!env.RESEND_KEY) return;
  try {
    const now = Date.now();
    const row = await env.DB.prepare('INSERT INTO mail_log (at, kind, report, subject, body) VALUES (?, ?, ?, ?, ?)').bind(now, kind, report, subject, text).run();
    const { n } = await env.DB.prepare('SELECT count(*) AS n FROM mail_log WHERE sent > ?').bind(now - HOUR).first();
    if (n >= HOURLY) return;
    if (await post(env, subject, text)) await env.DB.prepare("UPDATE mail_log SET sent = ?, body = '' WHERE id = ?").bind(now, row.meta.last_row_id).run();
  } catch (e) {
    console.error('mail', e);
  }
}

// the hourly job: everything that was held, in one mail
export async function digest(env, now) {
  if (!env.RESEND_KEY) return;
  const { results } = await env.DB.prepare('SELECT id, at, subject, body FROM mail_log WHERE sent = 0 ORDER BY id LIMIT 200').all();
  if (!results.length) return;
  const text = results.map(x => new Date(x.at).toISOString() + ' ' + x.subject + '\n' + x.body).join('\n\n----\n\n');
  if (await post(env, 'Amerikano: ' + results.length + ' held report mails', text)) {
    // the digest counts as one mail against the hourly limit, the rows it folded in as none
    const last = results[results.length - 1].id;
    await env.DB.batch([
      env.DB.prepare("UPDATE mail_log SET sent = -1, body = '' WHERE sent = 0 AND id <= ?").bind(last),
      env.DB.prepare('UPDATE mail_log SET sent = ? WHERE id = ?').bind(now, last)
    ]);
  }
}
