// The address a limit counts: an IPv6 address by its /64, since one customer gets a whole /64. The dev server (PACE set)
// has no real address, so tests send one in X-Addr and a request without it is not limited.
export function net(ip) {
  if (!ip.includes(':')) return ip;
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return v4[1];
  const [head, tail] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = tail === undefined ? a : [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '').toLowerCase()).join(':');
}

export function peer(request, env) {
  return net((env.PACE ? request.headers.get('X-Addr') : request.headers.get('CF-Connecting-IP')) || '');
}
