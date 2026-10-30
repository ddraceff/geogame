// Запуск: node server.js  (без зависимостей, только встроенные модули Node.js)
const zlib = require('zlib'), http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const world = require('./world');
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const COLORS = ['#e4572e', '#f3a712', '#a8c686', '#29b6c5', '#6c8cff', '#b565d9', '#ef6f9b', '#f2e394'];

// ---------- 3 лобі: раунди идут бесконечно, пока в лобі есть хоть один игрок ----------
const ASK_MS = 20000, RES_MS = 7000;
const LOBBIES = {
  country: { title: 'Країна на мапі', scale: 1200 },   // scale — «дальность» затухания очков, км
  region:  { title: 'Області України', scale: 130 },
  flag:    { title: 'Прапор → країна', scale: 1200 },
};
for (const [id, l] of Object.entries(LOBBIES)) Object.assign(l, { id, players: new Map(), n: 0, phase: 'idle', target: null, endsAt: 0, answers: new Map(), recent: [], res: [] });
const scores = new Map();   // lobby|token -> { score, seen }: счёт сохраняется при обрыве связи

const send = (out, data) => out.write(`data: ${JSON.stringify(data)}\n\n`);
const cast = (l, data) => { for (const p of l.players.values()) send(p.out, data); };
const cleanName = n => String(n || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'Гравець';
const freeColor = l => COLORS.find(c => ![...l.players.values()].some(p => p.color === c)) || COLORS[l.players.size % COLORS.length];
const playersMsg = l => ({ type: 'players', list: [...l.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, score: p.sc.score, answered: l.phase === 'ask' && l.answers.has(p.id) })) });
const roundMsg = l => ({ type: 'round', n: l.n, kind: l.id, name: l.id === 'flag' ? null : l.target.n, dur: ASK_MS, endsAt: l.endsAt, now: Date.now() });
const resultMsg = l => ({ type: 'result', n: l.n, target: l.target.i, name: l.target.n, results: l.res, endsAt: l.endsAt, now: Date.now() });

function startRound(l) {
  l.n++; l.phase = 'ask'; l.target = world.pick(l.id, l.recent); l.answers = new Map(); l.endsAt = Date.now() + ASK_MS;
  cast(l, roundMsg(l)); cast(l, playersMsg(l));
}
function finishRound(l) {
  l.res = [...l.players.values()].map(p => {
    const a = l.answers.get(p.id); if (a) p.sc.score += a.pts;
    return { id: p.id, name: p.name, color: p.color, lo: a ? a.lo : null, la: a ? a.la : null, near: a && a.d > 0 ? a.pt : null, d: a ? Math.round(a.d) : null, pts: a ? a.pts : 0 };
  });
  l.phase = 'result'; l.endsAt = Date.now() + RES_MS;
  cast(l, resultMsg(l)); cast(l, playersMsg(l));
}
setInterval(() => {
  const now = Date.now();
  for (const l of Object.values(LOBBIES)) {
    if (!l.players.size) { l.phase = 'idle'; continue; }
    if (l.phase === 'idle') startRound(l);
    else if (now >= l.endsAt) l.phase === 'ask' ? finishRound(l) : startRound(l);
  }
  for (const [k, s] of scores) if (now - s.seen > 10 * 60000 && ![...Object.values(LOBBIES)].some(l => [...l.players.values()].some(p => p.key === k))) scores.delete(k);
}, 250);

const body = req => new Promise(ok => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e4) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b)); } catch { ok({}); } }); });
const json = (res, obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
const gz = new Map();
const findPlayer = id => { for (const l of Object.values(LOBBIES)) { const p = l.players.get(id); if (p) return [l, p]; } return []; };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/events') {
    const l = LOBBIES[url.searchParams.get('lobby')]; if (!l) { res.writeHead(404); return res.end(); }
    const id = crypto.randomUUID(), token = String(url.searchParams.get('token') || id).slice(0, 64), key = l.id + '|' + token;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (!scores.has(key)) scores.set(key, { score: 0, seen: Date.now() });
    const sc = scores.get(key); sc.seen = Date.now();
    for (const o of l.players.values()) if (o.key === key) { o.out.end(); l.players.delete(o.id); }   // та же вкладка переподключилась
    const p = { id, key, name: cleanName(url.searchParams.get('name')), color: freeColor(l), out: res, sc };
    l.players.set(id, p);
    send(res, { type: 'hello', id });
    if (l.phase === 'ask') send(res, roundMsg(l)); else if (l.phase === 'result') send(res, resultMsg(l));
    cast(l, playersMsg(l));
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); sc.seen = Date.now(); if (l.players.get(id) === p) { l.players.delete(id); l.answers.delete(id); cast(l, playersMsg(l)); } });
    return;
  }

  if (url.pathname === '/api/lobbies') return json(res, Object.values(LOBBIES).map(l => ({ id: l.id, title: l.title, online: l.players.size })));

  // флаг текущего раунда (код страны наружу не отдаём до конца раунда)
  if (url.pathname === '/api/flag') {
    const l = LOBBIES.flag;
    if (!l.target || String(l.n) !== url.searchParams.get('n')) { res.writeHead(404); return res.end(); }
    const ff = path.join(PUB, 'flags', l.target.i + '.svg');
    return fs.readFile(ff, (e, d) => {
      if (e) { res.writeHead(404); return res.end(); }
      const h = { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' };   // SVG-прапори добре стискаються — економимо мобільний трафік
      if (/gzip/.test(req.headers['accept-encoding'] || '')) { if (!gz.has(ff)) gz.set(ff, zlib.gzipSync(d, { level: 6 })); h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); return res.end(gz.get(ff)); }
      res.writeHead(200, h); res.end(d);
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/answer') {
    const { id, lo, la } = await body(req), [l, p] = findPlayer(id);
    if (!p) return json(res, { ok: false, error: 'Сесію втрачено — перезавантажте сторінку' });
    if (l.phase !== 'ask' || l.answers.has(id) || !Number.isFinite(lo) || !Number.isFinite(la) || Math.abs(la) > 90) return json(res, { ok: false });
    const r = world.nearest(((lo + 540) % 360) - 180, la, l.target.p);
    l.answers.set(id, { lo, la, d: r.d, pt: r.pt, pts: r.d === 0 ? 1000 : Math.round(1000 * Math.exp(-r.d / l.scale)) });
    cast(l, playersMsg(l));
    if (l.answers.size >= l.players.size) {   // відповіли всі — не чекаємо таймер
      const ne = Math.min(l.endsAt, Date.now() + 1200);
      if (ne < l.endsAt) { l.endsAt = ne; cast(l, { type: 'ends', endsAt: ne, now: Date.now() }); }   // клієнти бачать скорочений таймер (потрібно для автовідправки мітки на телефонах)
    }
    return json(res, { ok: true });
  }

  // статика
  const file = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found: ' + url.pathname); }
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' };
    if (path.extname(file) === '.json' && /gzip/.test(req.headers['accept-encoding'] || '')) {
      if (!gz.has(file)) gz.set(file, zlib.gzipSync(data, { level: 6 }));
      headers['Content-Encoding'] = 'gzip'; res.writeHead(200, headers); return res.end(gz.get(file));
    }
    res.writeHead(200, headers); res.end(data);
  });
}).listen(PORT, () => console.log(`Гру запущено: http://localhost:${PORT}`));
