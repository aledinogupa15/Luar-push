const assert = require('assert');
const { createApp } = require('./server.js');
(async () => {
  let T = Date.parse('2026-10-24T01:30:00Z');      // 20:30 en Lima (UTC-5)
  const sent = [];
  const app = createApp({ now: () => T, sender: async (s, p) => { sent.push(JSON.parse(p)); }, vapidPublic: 'PUB', allowedOrigins: 'https://a.test' });
  await new Promise(r => app.server.listen(0, r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const post = (u, b, h) => fetch(base + u, { method: 'POST', body: JSON.stringify(b), headers: Object.assign({ 'content-type': 'application/json' }, h || {}) });
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } };
  const prefs = { on: true, checkin: '20:00', quiet: true, vib: true, tasksOn: true, tasksText: false, date: '2026-10-23', hasEntry: false, streak: 5, tasks: [{ id: 7, text: 'Tomar agua privado', time: '20:15', tpl: true }] };
  let r = await fetch(base + '/vapid'); assert.equal((await r.json()).key, 'PUB');
  r = await fetch(base + '/health', { headers: { origin: 'https://a.test' } }); assert.equal(r.headers.get('access-control-allow-origin'), 'https://a.test');
  r = await fetch(base + '/health', { headers: { origin: 'https://evil.test' } }); assert.equal(r.headers.get('access-control-allow-origin'), null);
  r = await post('/sync', { sub: { endpoint: 'https://evil.example.com/x', keys: sub.keys }, tz: 'America/Lima', prefs }); assert.equal(r.status, 400, 'endpoint no permitido');
  r = await post('/sync', { sub: { endpoint: 'http://fcm.googleapis.com/x', keys: sub.keys }, tz: 'America/Lima', prefs }); assert.equal(r.status, 400, 'http rechazado');
  r = await post('/sync', { sub, tz: 'No/Existe', prefs }); assert.equal(r.status, 400, 'tz inválida');
  r = await fetch(base + '/sync', { method: 'POST', body: 'x'.repeat(30000) }); assert.equal(r.status, 400, 'cuerpo grande');
  r = await post('/sync', { sub, tz: 'America/Lima', prefs }); assert.equal(r.status, 200);
  assert.equal(app.subs.size, 1);
  // 20:30 Lima: la fecha local es 2026-10-23 (01:30Z del 24) → check-in (20:00) y tarea 20:15 en ventana
  await app.tick();
  assert.equal(sent.length, 2, JSON.stringify(sent));
  assert(sent.find(x => x.tag === 'luar-checkin').body.includes('racha es de 5'));
  assert.equal(sent.find(x => x.tag === 'luar-task-7').body, 'Tienes una tarea pendiente en tu agenda.', 'sin texto de tareas por defecto');
  await app.tick(); assert.equal(sent.length, 2, 'sin duplicados');
  // con hasEntry no hay check-in
  sent.length = 0; T = Date.parse('2026-10-25T01:30:00Z');
  await post('/sync', { sub, tz: 'America/Lima', prefs: Object.assign({}, prefs, { date: '2026-10-24', hasEntry: true, tasks: [] }) }); await app.tick(); assert.equal(sent.length, 0, 'registró hoy');
  // hora de silencio (23:00 Lima)
  T = Date.parse('2026-10-25T04:00:00Z'); await post('/sync', { sub, tz: 'America/Lima', prefs: Object.assign({}, prefs, { date: '2026-10-24', tasks: [] }) }); await app.tick(); assert.equal(sent.length, 0, 'no molestar');
  // app no abierta hoy (fecha vieja): check-in sí, tareas y racha no
  sent.length = 0; T = Date.parse('2026-10-27T01:30:00Z'); await app.tick(); assert.equal(sent.length, 1); assert(!sent[0].body.includes('racha'));
  // texto permitido
  sent.length = 0; T = Date.parse('2026-10-28T01:20:00Z'); await post('/sync', { sub, tz: 'America/Lima', prefs: Object.assign({}, prefs, { date: '2026-10-27', hasEntry: true, tasksText: true }) }); T += 0; await app.tick();
  assert.equal(sent.length, 1); assert.equal(sent[0].body, 'Tomar agua privado');
  // 410 elimina
  const app2 = createApp({ now: () => Date.parse('2026-10-24T01:30:00Z'), sender: async () => { const e = new Error('gone'); e.statusCode = 410; throw e; }, vapidPublic: 'P' });
  await new Promise(r => app2.server.listen(0, r)); const b2 = 'http://127.0.0.1:' + app2.server.address().port;
  await fetch(b2 + '/sync', { method: 'POST', body: JSON.stringify({ sub, tz: 'America/Lima', prefs }) }); assert.equal(app2.subs.size, 1); await app2.tick(); assert.equal(app2.subs.size, 0, '410 borra');
  // unsubscribe
  r = await post('/unsubscribe', sub); assert.equal(r.status, 200); assert.equal(app.subs.size, 0);
  // rate limit
  let last; for (let i = 0; i < 70; i++) last = await fetch(base + '/health'); assert.equal(last.status, 429);
  console.log('server tests OK'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
