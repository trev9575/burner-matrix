// Web Push with no dependencies: VAPID (RFC 8292) signing + aes128gcm payload encryption (RFC 8291 / RFC 8188).
// Works with Chrome/Android (FCM), Safari/iOS 16.4+ home-screen apps (Apple) and Firefox (Mozilla).
'use strict';
const crypto = require('crypto');
const fs = require('fs');

const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// VAPID key pair, made once and kept in the data folder
function loadKeys(file) {
  try { const k = JSON.parse(fs.readFileSync(file, 'utf8')); if (k.d && k.x && k.y) return k; } catch {}
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const pub = ecdh.getPublicKey(); // 65 bytes: 0x04 | x | y
  const k = { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)), d: b64u(ecdh.getPrivateKey()) };
  fs.writeFileSync(file, JSON.stringify(k), { mode: 0o600 });
  return k;
}
const publicKey = k => Buffer.concat([Buffer.from([4]), unb64u(k.x), unb64u(k.y)]); // what the browser needs

function vapidHeader(k, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: k, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${b64u(publicKey(k))}`;
}

// RFC 8291: encrypt one message for one browser subscription
function encrypt(sub, payload, fixed = {}) { // `fixed` (salt, private key) is only for checking against the RFC example
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  if (uaPub.length !== 65 || auth.length < 16) throw new Error('Bad subscription keys');
  const ecdh = crypto.createECDH('prime256v1'); if (fixed.priv) ecdh.setPrivateKey(unb64u(fixed.priv)); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(), secret = ecdh.computeSecret(uaPub), salt = fixed.salt ? unb64u(fixed.salt) : crypto.randomBytes(16);
  const prkKey = hmac(auth, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}

// Send one notification. Resolves { ok, status, gone } (gone = the subscription is dead and should be dropped).
async function send(k, subject, sub, data, { ttl = 86400, urgency = 'normal' } = {}) {
  const body = encrypt(sub, JSON.stringify(data));
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(sub.endpoint, { method: 'POST', signal: ctl.signal, body, headers: {
      'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: String(ttl), Urgency: urgency,
      Authorization: vapidHeader(k, sub.endpoint, subject) } });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, gone: r.status === 404 || r.status === 410 };
  } finally { clearTimeout(t); }
}

// only the browsers' real push services (Google, Apple, Mozilla, Microsoft), so the server can't be pointed anywhere else
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
const okEndpoint = e => { try { const u = new URL(e); return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some(rx => rx.test(u.hostname)); } catch { return false; } };

module.exports = { loadKeys, publicKey, vapidHeader, encrypt, send, okEndpoint, b64u };
