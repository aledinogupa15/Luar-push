/* Servidor de avisos push de Luar Mind.
   Guarda solo lo mínimo para mandar recordatorios: la suscripción push del navegador, la zona horaria,
   la hora del aviso diario, el horario de "no molestar", la hora de las tareas de hoy (y su texto solo si la
   persona lo permite), si ya registró su ánimo hoy y el número de su racha.
   NO recibe diario, ánimos, pensamientos, chat ni perfil.
   El estado es "blando": la app lo vuelve a enviar cada vez que se abre, así que si el servidor se reinicia no se pierde nada importante. */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const PUSH_HOSTS = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com|wns[0-9a-z.-]*\.notify\.windows\.com)$/i;
const MAX_BODY = 20000, MAX_SUBS = 5000, MAX_TASKS = 20, STALE_MS = 60 * 864e5;

function createApp(opts) {
  opts = opts || {};
  const now = opts.now || (() => Date.now());
  const sender = opts.sender;                       // async (sub, payloadString, options) => void
  const allowed = (opts.allowedOrigins || '*').split(',').map(s => s.trim()).filter(Boolean);
  const dataFile = opts.dataFile || null;
  const vapidPublic = opts.vapidPublic;
  const subs = new Map();                           // id -> {sub, tz, p, sent:{}, sentDate, seen}
  const hits = new Map();                           // ip -> [timestamps]
  let dirty = false;

  if (dataFile) { try { const j = JSON.parse(fs.readFileSync(dataFile, 'utf8')); (j.subs || []).forEach(r => subs.set(r.id, r.v)); } catch (e) {} }
  function persist() { if (!dataFile || !dirty) return; dirty = false; try { fs.writeFileSync(dataFile, JSON.stringify({ subs: [...subs].map(([id, v]) => ({ id, v })) })); } catch (e) {} }
  const idOf = ep => crypto.createHash('sha256').update(ep).digest('hex').slice(0, 32);
  const str = (x, n) => String(x == null ? '' : x).replace(/[<>]/g, '').slice(0, n);
  const hm = s => { const p = String(s || '').split(':'); return (+p[0] || 0) * 60 + (+p[1] || 0); };
  const okTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));

  function validSub(s) {
    if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 600) return false;
    let u; try { u = new URL(s.endpoint); } catch (e) { return false; }
    if (u.protocol !== 'https:' || !PUSH_HOSTS.test(u.hostname)) return false;
    const k = s.keys; return !!(k && typeof k.p256dh === 'string' && typeof k.auth === 'string' && k.p256dh.length < 200 && k.auth.length < 100);
  }
  function validTz(tz) { try { new Intl.DateTimeFormat('es', { timeZone: tz }); return typeof tz === 'string' && tz.length < 60; } catch (e) { return false; } }
  function local(tz, t) {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const o = {}; f.formatToParts(new Date(t)).forEach(p => { o[p.type] = p.value; });
    return { date: o.year + '-' + o.month + '-' + o.day, m: (+o.hour) * 60 + (+o.minute) };
  }
  function clean(p) {
    p = p || {};
    const tasks = (Array.isArray(p.tasks) ? p.tasks : []).slice(0, MAX_TASKS).filter(x => x && okTime(x.time)).map(x => ({ id: str(x.id, 30), time: x.time, tpl: !!x.tpl, text: p.tasksText ? str(x.text, 140) : '' }));
    return { on: !!p.on, checkin: okTime(p.checkin) ? p.checkin : '20:00', quiet: p.quiet !== false, vib: p.vib !== false, tasksOn: p.tasksOn !== false,
      date: /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? p.date : '', hasEntry: !!p.hasEntry, streak: Math.max(0, Math.min(9999, +p.streak || 0)), tasks };
  }
  const CHECK = ['¿Cómo te sientes hoy? Luar te espera un ratito.', 'Un minuto para ti: registra tu ánimo con Luar.', 'Luar quiere saber cómo estuvo tu día.', 'Pausa corta: respira y cuéntale a Luar cómo vas.'];
  function due(r, t) {
    const out = [], p = r.p; if (!p.on) return out;
    const L = local(r.tz, t);
    if (p.quiet && (L.m >= 22 * 60 + 30 || L.m < 7 * 60)) return out;
    const fresh = p.date === L.date;                // la app sincronizó hoy
    if (p.checkin && L.m >= hm(p.checkin) && L.m < hm(p.checkin) + 120 && !(fresh && p.hasEntry))
      out.push({ k: 'ci-' + L.date, tag: 'luar-checkin', title: 'Luar Mind', body: CHECK[(+L.date.slice(-2)) % CHECK.length] + (fresh && p.streak >= 2 ? ' Tu racha es de ' + p.streak + ' días.' : '') });
    if (p.tasksOn && fresh) p.tasks.forEach(x => { const tm = hm(x.time); if (L.m >= tm && L.m < tm + 60) out.push({ k: 'tk-' + x.id + '-' + L.date, tag: 'luar-task-' + x.id, title: x.tpl ? 'Autocuidado' : 'Recordatorio', body: x.text || 'Tienes una tarea pendiente en tu agenda.' }); });
    return { list: out, date: L.date };
  }
  async function tick() {
    const t = now();
    for (const [id, r] of [...subs]) {
      if (t - r.seen > STALE_MS) { subs.delete(id); dirty = true; continue; }
      const d = due(r, t); if (!d.list || !d.list.length) continue;
      if (r.sentDate !== d.date) { r.sent = {}; r.sentDate = d.date; }
      for (const n of d.list) {
        if (r.sent[n.k]) continue; r.sent[n.k] = 1; dirty = true;
        try { await sender(r.sub, JSON.stringify({ title: n.title, body: n.body, tag: n.tag, vib: r.p.vib }), { TTL: 3600, urgency: 'normal' }); }
        catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) { subs.delete(id); dirty = true; break; } }
      }
    }
    persist();
  }
  function cors(req, res) {
    const o = req.headers.origin;
    if (allowed.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
    else if (o && allowed.includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'content-type'); res.setHeader('Access-Control-Max-Age', '86400');
  }
  function limited(ip) { const t = now(), a = (hits.get(ip) || []).filter(x => t - x < 60000); a.push(t); hits.set(ip, a); if (hits.size > 5000) hits.clear(); return a.length > 60; }
  function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
  function readBody(req) { return new Promise((ok, no) => { let n = 0, b = '', big = false; req.on('data', c => { n += c.length; if (n > MAX_BODY) { if (!big) { big = true; no(new Error('big')); } return; } if (!big) b += c; }); req.on('end', () => { if (!big) ok(b); }); req.on('error', no); }); }

  const server = http.createServer(async (req, res) => {
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (limited(ip)) return send(res, 429, { error: 'demasiadas solicitudes' });
    const url = req.url.split('?')[0];
    try {
      if (req.method === 'GET' && (url === '/' || url === '/health')) return send(res, 200, { ok: true, subs: subs.size });
      if (req.method === 'GET' && url === '/vapid') return send(res, 200, { key: vapidPublic });
      if (req.method === 'POST' && url === '/sync') {
        const j = JSON.parse(await readBody(req));
        if (!validSub(j.sub)) return send(res, 400, { error: 'suscripción no válida' });
        if (!validTz(j.tz)) return send(res, 400, { error: 'zona horaria no válida' });
        const id = idOf(j.sub.endpoint);
        if (!subs.has(id) && subs.size >= MAX_SUBS) return send(res, 503, { error: 'servicio lleno' });
        const prev = subs.get(id);
        subs.set(id, { sub: { endpoint: j.sub.endpoint, keys: { p256dh: j.sub.keys.p256dh, auth: j.sub.keys.auth } }, tz: j.tz, p: clean(j.prefs), sent: prev ? prev.sent : {}, sentDate: prev ? prev.sentDate : '', seen: now() });
        dirty = true; return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url === '/unsubscribe') {
        const j = JSON.parse(await readBody(req)); if (j && typeof j.endpoint === 'string') { subs.delete(idOf(j.endpoint)); dirty = true; }
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'no encontrado' });
    } catch (e) { res.setHeader('Connection', 'close'); return send(res, 400, { error: 'solicitud no válida' }); }
  });
  return { server, tick, subs, persist, due, local };
}
module.exports = { createApp };

if (require.main === module) {
  const webpush = require('web-push');
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) { const k = webpush.generateVAPIDKeys(); pub = k.publicKey; priv = k.privateKey; console.log('AVISO: no hay VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY; se generaron claves temporales. Guárdalas como variables de entorno para que no cambien:\nVAPID_PUBLIC_KEY=' + pub + '\n(la clave privada no se muestra en el registro)'); }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://luar-mind.onrender.com', pub, priv);
  const app = createApp({ sender: (sub, payload, o) => webpush.sendNotification(sub, payload, o), allowedOrigins: process.env.ALLOWED_ORIGINS || '*', dataFile: process.env.DATA_FILE || './data.json', vapidPublic: pub });
  setInterval(() => { app.tick().catch(() => {}); }, 30000);
  setInterval(app.persist, 60000);
  const port = process.env.PORT || 3000;
  app.server.listen(port, () => console.log('Luar push escuchando en ' + port));
}
