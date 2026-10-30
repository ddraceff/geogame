// Мир: геоданные (страны, области Украины), подсчёт расстояний и выбор целей. Загружается один раз при старте сервера.
const fs = require('fs'), path = require('path');
const geo = JSON.parse(fs.readFileSync(path.join(__dirname, 'public/data/geo.json'), 'utf8'));
const FLAGS = path.join(__dirname, 'public/flags');
const byId = new Map(); geo.countries.forEach(c => byId.set(c.i, c)); geo.regions.forEach(r => byId.set(r.i, r));
const hasFlag = i => fs.existsSync(path.join(FLAGS, i + '.svg'));

// шансы по континентам: E — Европа, A — Азия, N/S — Америки, F — Африка, O — Океания
const WF = { E: 3, A: 3, N: 3, S: 3, F: 1, O: .35 };      // режим «прапор»
const WC = { E: 2, A: 2, N: 2, S: 2, F: 1.2, O: .6 };     // режим «країна»
function pool(kind) {
  if (kind === 'region') return geo.regions;
  return geo.countries.filter(c => c.s && c.n && (kind !== 'flag' || hasFlag(c.i)));
}
function pick(kind, recent) {
  const list = pool(kind), W = kind === 'flag' ? WF : WC, w = c => kind === 'region' ? 1 : (W[c.c] || 1);
  const cand = list.filter(c => !recent.includes(c.i)); let t = cand.reduce((s, c) => s + w(c), 0);
  let r = Math.random() * t, c = cand[cand.length - 1]; for (const x of cand) { r -= w(x); if (r <= 0) { c = x; break; } }
  recent.push(c.i); if (recent.length > Math.min(40, Math.floor(list.length * .4))) recent.shift();
  return c;
}

// ---------- расстояние по сфере до границы цели (0 — если клик внутри) ----------
const R = 6371, rad = Math.PI / 180;
const vec = (lo, la) => { la *= rad; lo *= rad; return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
function inside(lo, la, polys) {
  let c = false;
  for (const poly of polys) for (const r of poly) for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > la) !== (yj > la) && lo < (xj - xi) * (la - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function nearest(lo, la, polys) {
  if (inside(lo, la, polys)) return { d: 0, pt: [lo, la] };
  const P = vec(lo, la); let bd = 1e9, bp = null;
  for (const poly of polys) for (const r of poly) for (let i = 0; i < r.length - 2; i += 2) {
    const A = vec(r[i], r[i + 1]), B = vec(r[i + 2], r[i + 3]), n = crs(A, B), nl = Math.hypot(...n); let q = null;
    if (nl > 1e-12) {
      const u = n.map(v => v / nl), s = dot(P, u), Q = [P[0] - s * u[0], P[1] - s * u[1], P[2] - s * u[2]], ql = Math.hypot(...Q);
      if (ql > 1e-12) { const Qn = Q.map(v => v / ql); if (ang(A, Qn) + ang(Qn, B) <= ang(A, B) + 1e-9) q = Qn; }
    }
    for (const X of (q ? [q] : [A, B])) { const d = ang(P, X); if (d < bd) { bd = d; bp = X; } }
  }
  return { d: bd * R, pt: [Math.atan2(bp[1], bp[0]) / rad, Math.asin(Math.max(-1, Math.min(1, bp[2]))) / rad] };
}
module.exports = { geo, byId, pick, nearest };
