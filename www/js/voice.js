var Voice = (function () {
  const ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }];
  const AUDIO = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
  const node = Cards.node;
  const muted = new Set();
  let sfu = false;
  let table = null;
  let call = null;
  let ring = null;
  let barEl = null;
  let stream = null;
  let mic = false;
  let deaf = false;
  let ctx = null;
  let beat = 0;

  const plug = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AudioRoute;
  const who = seed => Names.text(seed, I18n.lang());
  const $ = id => document.getElementById(id);

  const V = {};

  V.can = () => sfu && !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  V.on = () => V.can() && !!Account.me() && Account.me().voice !== false;
  V.muted = pid => muted.has(pid);

  // the phone has to send the sound out of the loudspeaker while the microphone is live
  function route() {
    const p = plug();
    if (p) p[stream || (call && call.stream) ? 'start' : 'stop']().catch(() => {});
  }

  async function grab() {
    return navigator.mediaDevices.getUserMedia(AUDIO);
  }

  function release(s) {
    if (s) for (const x of s.getTracks()) x.stop();
  }

  function gathered(pc) {
    return new Promise(res => {
      if (pc.iceGatheringState === 'complete') return res();
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') res(); });
      setTimeout(res, 2500);
    });
  }

  // loudness of a stream, true while it is above silence and for a moment after
  function meter(s) {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      ctx.resume().catch(() => {});
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      ctx.createMediaStreamSource(s).connect(an);
      const buf = new Uint8Array(an.fftSize);
      let until = 0;
      return () => {
        an.getByteTimeDomainData(buf);
        if (buf.some(v => Math.abs(v - 128) > 10)) until = Date.now() + 400;
        return Date.now() < until;
      };
    } catch (e) {
      return () => false;
    }
  }

  // one place where voice goes through the SFU: a table, or a call. q keeps its requests in order, since each change of a connection waits for the last
  const chan = id => ({ id: id, pub: null, sub: null, fresh: true, live: true, q: Promise.resolve(), mids: new Map(), els: new Map(), has: new Set(), meter: null });
  const send = (ch, op, body) => Account.call('POST', '/api/voice/' + op, Object.assign({}, ch.id, body));

  function later(ch, fn) {
    const run = ch.q.then(() => (ch.live ? fn() : null));
    ch.q = run.catch(() => {});
    return run;
  }

  function peer(ch) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    pc.ontrack = e => {
      const pid = ch.mids.get(e.transceiver.mid);
      if (!pid) return;
      const old = ch.els.get(pid);
      if (old) old.audio.srcObject = null;
      const audio = new Audio();
      audio.srcObject = new MediaStream([e.track]);
      audio.muted = hush(pid);
      audio.play().catch(() => {});
      ch.els.set(pid, { audio: audio, hot: meter(audio.srcObject) });
    };
    return pc;
  }

  // a player's track comes through a listening connection of ours; the server says whether we may
  function pull(ch, pid) {
    if (ch.has.has(pid)) return;
    ch.has.add(pid);
    later(ch, async () => {
      if (!ch.sub) ch.sub = peer(ch);
      const r = await send(ch, 'pull', { pid: pid, fresh: ch.fresh });
      ch.fresh = false;
      if (!r.sdp) return;
      ch.mids.set(r.mid, pid);
      await ch.sub.setRemoteDescription({ type: 'offer', sdp: r.sdp });
      await ch.sub.setLocalDescription(await ch.sub.createAnswer());
      await gathered(ch.sub);
      await send(ch, 'answer', { sdp: ch.sub.localDescription.sdp });
    }).catch(() => ch.has.delete(pid));
  }

  function skip(ch, pid) {
    ch.has.delete(pid);
    const e = ch.els.get(pid);
    if (e) e.audio.srcObject = null;
    ch.els.delete(pid);
  }

  const hush = pid => deaf || muted.has(pid) || Social.blocked(pid);

  function listen(ch) {
    if (deaf) return;
    later(ch, async () => {
      for (const pid of (await send(ch, 'who')).pids) if (!hush(pid)) pull(ch, pid);
    }).catch(() => {});
  }

  async function publish(ch, s) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    ch.pub = pc;
    const tr = pc.addTransceiver(s.getAudioTracks()[0], { direction: 'sendonly' });
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    const r = await send(ch, 'mic', { sdp: pc.localDescription.sdp, mid: tr.mid });
    await pc.setRemoteDescription({ type: 'answer', sdp: r.sdp });
    ch.meter = meter(s);
  }

  // the stop goes in line with the rest, so it cannot overtake a microphone started right after; still: the server already dropped it
  function quiet(ch, still) {
    if (!ch.pub) return;
    if (!still) ch.q = ch.q.then(() => send(ch, 'stop')).catch(() => {});
    ch.pub.close();
    ch.pub = ch.meter = null;
  }

  function shut(ch, still) {
    ch.live = false;
    quiet(ch, still);
    if (ch.sub) ch.sub.close();
    for (const e of ch.els.values()) e.audio.srcObject = null;
    ch.els.clear();
  }

  // the table: its channel follows the online table on screen, and the microphone goes off with it
  function follow() {
    const code = App.online() && !(call && call.st === 'on') && V.on() ? Net.code() : null;
    if (table && table.id.code !== code) {
      shut(table);
      table = null;
      if (mic) {
        mic = false;
        release(stream);
        stream = null;
        route();
      }
    }
    if (!table && code) {
      table = chan({ scope: 'table', code: code });
      listen(table);
      watch();
    }
  }

  // a new connection to the table: whoever talked has to start again, since the table dropped them
  V.again = () => {
    if (!table) return;
    const on = mic;
    shut(table, true);
    table = chan(table.id);
    listen(table);
    if (on && stream) later(table, () => publish(table, stream)).catch(() => V.mic(false));
  };

  V.mic = async want => {
    const on = want === undefined ? !mic : want;
    if (on === mic || !table) return;
    if (!on) {
      mic = false;
      quiet(table);
      release(stream);
      stream = null;
      route();
      return V.draw();
    }
    try {
      stream = await grab();
      route();
    } catch (e) {
      return UI.notice(t('voice.denied'));
    }
    mic = true;
    V.draw();
    later(table, () => publish(table, stream)).catch(() => {
      V.mic(false);
      UI.notice(t('voice.fail'));
    });
  };

  V.deaf = () => {
    deaf = !deaf;
    if (!deaf && table) listen(table);
    if (!deaf && call && call.ch) listen(call.ch);
    V.draw();
  };

  // mutes one player at the table, or lets them through again
  V.toggle = pid => {
    if (!muted.delete(pid)) muted.add(pid);
    for (const ch of [table, call && call.ch]) if (ch && muted.has(pid)) skip(ch, pid);
    if (!muted.has(pid) && table) V.peer(pid, true);
    V.draw();
  };

  // someone started or stopped talking where we listen
  V.peer = (pid, on, id) => {
    const ch = id ? call && call.ch && call.ch.id.id === id && call.ch : table;
    if (!ch) return;
    skip(ch, pid);
    if (on && !hush(pid)) pull(ch, pid);
  };

  // the speaker and microphone buttons, and the rings of those who talk
  function paint() {
    const show = App.online() && V.on();
    for (const id of ['mic', 'spk']) $(id).hidden = !show;
    $('mic').classList.toggle('on', mic);
    $('mic').setAttribute('aria-pressed', String(mic));
    $('mic').setAttribute('aria-label', t(mic ? 'voice.mic.on' : 'voice.mic.off'));
    $('spk').classList.toggle('off', deaf);
    $('spk').setAttribute('aria-pressed', String(deaf));
    $('spk').setAttribute('aria-label', t(deaf ? 'voice.spk.off' : 'voice.spk.on'));
    for (const ch of [table, call && call.ch]) {
      if (!ch) continue;
      for (const [pid, e] of ch.els) e.audio.muted = hush(pid);
    }
  }

  function light() {
    const st = App.state();
    const talking = new Set();
    if (table) {
      for (const [pid, e] of table.els) if (e.hot()) talking.add(pid);
      if (table.meter && table.meter()) talking.add(Account.id());
    }
    if (!st) return;
    st.players.forEach((p, i) => {
      const seat = Table.seat(i);
      const av = seat && seat.querySelector('.av');
      if (av) av.classList.toggle('talk', talking.has(p.pid));
    });
  }

  function watch() {
    if (beat) return;
    beat = setInterval(() => {
      V.draw();
      light();
      if (!table && !call) {
        clearInterval(beat);
        beat = 0;
      }
    }, 250);
  }

  V.draw = () => {
    follow();
    paint();
  };

  // what the hub says on connecting: whether voice exists at all, and a call that went on without us has to be confirmed
  V.hub = on => {
    sfu = !!on;
    if (call && call.id) {
      call.sure = false;
      const c = call;
      setTimeout(() => { if (call === c && !c.sure) over('dropped'); }, 3000);
    }
    V.draw();
  };

  // calls: a friend is rung through the hub, and the call itself is one more channel through the SFU
  V.dial = f => {
    if (call || !V.on()) return;
    call = { pid: f.id, seed: f.seed, av: f.avatar || f.av, st: 'dial', out: true };
    Net.say({ t: 'call', to: f.id });
    const c = call;
    setTimeout(() => { if (call === c && !c.id) over('no'); }, 8000);
    bar();
  };

  V.ring = m => {
    if (call) {
      if (call.id === m.id) call.sure = true;
      return;
    }
    call = { id: m.id, pid: m.from.pid, seed: m.from.seed, av: m.from.av, st: 'in', sure: true };
    const body = node('div', 'ringing');
    body.appendChild(Avatar.sized(call.av, 80));
    call.sheet = Sheet.open({
      kind: 'center', dismiss: false, title: t('voice.in', { name: who(call.seed) }), body: body,
      actions: [{ label: t('voice.accept'), kind: 'primary', fn: () => Net.say({ t: 'accept', id: m.id }) }, { label: t('voice.decline'), kind: 'quiet', fn: () => Net.say({ t: 'hang', id: m.id }) }]
    });
    Live.say(t('voice.in', { name: who(call.seed) }));
  };

  V.signal = m => {
    if (!call) {
      if (m.id && m.st !== 'end') Net.say({ t: 'hang', id: m.id });
      return;
    }
    if (m.id && call.id && m.id !== call.id) return;
    if (m.st === 'end') return over(m.why);
    call.id = m.id;
    call.sure = true;
    if (m.st === 'ring') call.st = 'ring';
    if (m.st === 'on' && call.st !== 'on') up();
    bar();
  };

  async function up() {
    call.st = 'on';
    if (call.sheet) call.sheet.close();
    if (table) {
      shut(table);
      table = null;
    }
    if (mic) {
      mic = false;
      release(stream);
      stream = null;
    }
    const mine = call;
    try {
      mine.stream = await grab();
      route();
    } catch (e) {
      UI.notice(t('voice.denied'));
      return Net.say({ t: 'hang', id: mine.id });
    }
    if (call !== mine) {
      release(mine.stream);
      return route();
    }
    mine.ch = chan({ scope: 'call', id: mine.id });
    listen(mine.ch);
    later(mine.ch, () => publish(mine.ch, mine.stream)).catch(() => {
      UI.notice(t('voice.fail'));
      Net.say({ t: 'hang', id: mine.id });
    });
    watch();
    bar();
  }

  function over(why) {
    const c = call;
    if (!c) return;
    call = null;
    if (c.sheet) c.sheet.close();
    if (c.ch) shut(c.ch, true);
    release(c.stream);
    c.stream = null;
    route();
    bar();
    if (why !== 'ended' && (c.out || why !== 'declined')) toast(t('voice.end.' + (why === 'missed' && !c.out ? 'missedIn' : why)));
    Social.called(c.pid, why, !!c.out);
    V.draw();
  }

  // a short line that does not stop play, for what happened to a call
  function toast(text) {
    Live.say(text);
    const box = $('toast');
    if (box.firstChild) return;
    const el = node('div', 'toast');
    el.setAttribute('role', 'status');
    el.appendChild(node('p', '', text));
    box.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // a strip while a call rings or is on, with the way to end it
  function bar() {
    if (!call || call.st === 'in') {
      if (barEl) barEl.remove();
      barEl = null;
      return;
    }
    if (!barEl) {
      barEl = node('div', 'callbar');
      barEl.setAttribute('role', 'group');
      $('stage').appendChild(barEl);
    }
    barEl.textContent = '';
    barEl.appendChild(Avatar.sized(call.av, 28));
    barEl.appendChild(node('span', 'cn', t(call.st === 'on' ? 'voice.talking' : 'voice.calling', { name: who(call.seed) })));
    if (call.st === 'on') {
      const m = node('button', 'btn quiet', t('voice.muteMe'));
      m.type = 'button';
      m.setAttribute('aria-pressed', String(!!call.mute));
      m.classList.toggle('lit', !!call.mute);
      m.addEventListener('click', () => {
        call.mute = !call.mute;
        for (const x of call.stream ? call.stream.getAudioTracks() : []) x.enabled = !call.mute;
        bar();
      });
      barEl.appendChild(m);
    }
    const h = node('button', 'btn primary', t('voice.hang'));
    h.type = 'button';
    h.disabled = !call.id;
    h.addEventListener('click', () => Net.say({ t: 'hang', id: call.id }));
    barEl.appendChild(h);
  }

  // voice switched off in Settings ends everything
  V.refresh = () => {
    if (!V.on()) {
      if (call && call.id) Net.say({ t: 'hang', id: call.id });
      if (mic) V.mic(false);
    }
    V.draw();
  };

  $('mic').addEventListener('click', () => V.mic());
  $('spk').addEventListener('click', V.deaf);
  setInterval(V.draw, 2000);

  return V;
})();
