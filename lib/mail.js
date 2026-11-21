// Minimal SMTP client (no dependencies). Supports implicit TLS (port 465) and STARTTLS (587/25),
// AUTH PLAIN/LOGIN, and multipart messages with attachments.
'use strict';
const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');

const EMAIL_RE = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;
const isEmail = s => typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s);
const splitList = s => String(s || '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
const noCRLF = s => String(s || '').replace(/[\r\n]+/g, ' ');
const encWord = s => /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s).toString('base64') + '?=';
const b64lines = buf => buf.toString('base64').replace(/.{1,76}/g, '$&\r\n');

function config() {
  const e = process.env;
  const port = +e.SMTP_PORT || 587;
  return {
    host: e.SMTP_HOST || '', port,
    secure: e.SMTP_SECURE ? /^true$/i.test(e.SMTP_SECURE) : port === 465,
    user: e.SMTP_USER || '', pass: e.SMTP_PASS || '',
    from: e.SMTP_FROM || e.SMTP_USER || '',
    fromName: e.SMTP_FROM_NAME || 'Burner Selection Matrix',
  };
}
const configured = () => { const c = config(); return !!(c.host && isEmail(c.from)); };

function buildMessage(c, { to, cc, replyTo, subject, text, attachments = [] }) {
  const b = 'bm-' + crypto.randomBytes(12).toString('hex');
  const h = [
    `From: ${encWord(c.fromName)} <${c.from}>`,
    `To: ${to.join(', ')}`,
    cc.length ? `Cc: ${cc.join(', ')}` : '',
    replyTo ? `Reply-To: ${replyTo}` : '',
    `Subject: ${encWord(noCRLF(subject))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(16).toString('hex')}@${c.from.split('@')[1]}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`,
  ].filter(Boolean);
  let body = h.join('\r\n') + '\r\n\r\n' +
    `--${b}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` + b64lines(Buffer.from(text));
  for (const a of attachments) {
    const fn = noCRLF(a.filename).replace(/"/g, '');
    body += `--${b}\r\nContent-Type: ${a.type}; name="${fn}"\r\nContent-Disposition: attachment; filename="${fn}"\r\nContent-Transfer-Encoding: base64\r\n\r\n` + b64lines(a.content);
  }
  return body + `--${b}--\r\n`;
}

// Talks SMTP over a socket; returns the server's reply lines.
function conversation(sock) {
  let buf = '', waiting = null, failed = null;
  const queue = [];
  const feed = d => {
    buf += d;
    for (;;) {
      const lines = buf.split('\r\n'); let end = -1;
      for (let i = 0; i < lines.length - 1; i++) if (/^\d{3} /.test(lines[i])) { end = i; break; }
      if (end < 0) return;
      const reply = lines.slice(0, end + 1); buf = lines.slice(end + 1).join('\r\n');
      if (waiting) { const w = waiting; waiting = null; w.ok(reply); } else queue.push(reply);
    }
  };
  const fail = err => { failed = err; if (waiting) { const w = waiting; waiting = null; w.bad(err); } };
  const attach = s => { s.setEncoding('utf8'); s.on('data', feed); s.on('error', fail); s.on('close', () => fail(new Error('SMTP connection closed'))); };
  attach(sock);
  const read = () => queue.length ? Promise.resolve(queue.shift()) : failed ? Promise.reject(failed) : new Promise((ok, bad) => { waiting = { ok, bad }; });
  return {
    read, attach,
    detach: s => { s.removeAllListeners('data'); s.removeAllListeners('error'); s.removeAllListeners('close'); },
  };
}

async function sendMail(msg) {
  const c = config();
  if (!c.host) throw new Error('Email is not set up on the server (SMTP_HOST is empty)');
  const to = msg.to.filter(isEmail), cc = (msg.cc || []).filter(isEmail).filter(x => !to.includes(x));
  if (!to.length) throw new Error('No valid recipient');
  const data = buildMessage(c, { ...msg, to, cc, replyTo: isEmail(msg.replyTo) ? msg.replyTo : '' });
  const name = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';

  let sock = c.secure ? tls.connect({ host: c.host, port: c.port, servername: c.host }) : net.connect({ host: c.host, port: c.port });
  sock.setTimeout(30000, () => sock.destroy(new Error('SMTP timed out')));
  let s = conversation(sock);
  const cmd = async (line, ok = [250]) => {
    if (line !== null) sock.write(line + '\r\n');
    const r = await s.read(); const code = +r[r.length - 1].slice(0, 3);
    if (!ok.includes(code)) throw new Error(`SMTP ${code}: ${r.join(' ').replace(/^\d{3}[ -]/gm, '').slice(0, 200)}`);
    return r;
  };
  try {
    await cmd(null, [220]);
    let ehlo = await cmd('EHLO ' + name);
    if (!c.secure && ehlo.some(l => /STARTTLS/i.test(l))) {
      await cmd('STARTTLS', [220]);
      s.detach(sock);
      sock = tls.connect({ socket: sock, servername: c.host });
      sock.setTimeout(30000, () => sock.destroy(new Error('SMTP timed out')));
      s = conversation(sock);
      await new Promise((ok, bad) => { sock.once('secureConnect', ok); sock.once('error', bad); });
      ehlo = await cmd('EHLO ' + name);
    }
    if (c.user) {
      const caps = ehlo.join(' ');
      if (/AUTH[ =][^\r\n]*PLAIN/i.test(caps) || !/AUTH[ =][^\r\n]*LOGIN/i.test(caps)) {
        await cmd('AUTH PLAIN ' + Buffer.from(`\0${c.user}\0${c.pass}`).toString('base64'), [235]);
      } else {
        await cmd('AUTH LOGIN', [334]);
        await cmd(Buffer.from(c.user).toString('base64'), [334]);
        await cmd(Buffer.from(c.pass).toString('base64'), [235]);
      }
    }
    await cmd(`MAIL FROM:<${c.from}>`);
    for (const r of to.concat(cc)) await cmd(`RCPT TO:<${r}>`, [250, 251]);
    await cmd('DATA', [354]);
    sock.write(data.replace(/\r\n\./g, '\r\n..') + '.\r\n');
    await cmd(null, [250]);
    sock.write('QUIT\r\n');
    return { to, cc };
  } finally {
    setTimeout(() => sock.destroy(), 500);
  }
}

module.exports = { sendMail, configured, isEmail, splitList, config };
