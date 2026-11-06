// Pacedex: a medium home-screen widget for Scriptable showing weekly
// Claude Code and Codex usage from your own Pacedex Worker.
// Name this script "Pacedex", then connect it from the app:
// Settings → Widget → Connect widget. That hands over the Worker's address and
// a read-only key, both kept in Scriptable's Keychain, never in this file.

const KEY_NAME = "pacedex-key", BASE_NAME = "pacedex-base";
const q = args.queryParameters;
if (q.key && /^https:\/\/[^/]+$/.test(q.base || "")) {
  Keychain.set(KEY_NAME, q.key);
  Keychain.set(BASE_NAME, q.base);
}
const stored = (name) => (Keychain.contains(name) ? Keychain.get(name) : null);
const key = stored(KEY_NAME), BASE = stored(BASE_NAME);

const TEXT = new Color("#F5F5F7");
const MUTED = new Color("#8A8A90");
const WARN = new Color("#FF9F0A");
// Ring colours, the same as the app's: the fill runs deep to bright along the
// arc; line is the outline of time to come, UNUSED (shared) the time gone
// without use, and dim the empty ring when the week's position is unknown.
const PROVIDERS = [
  { id: "claude", name: "Claude Code", staleMin: 60,
    stops: ["#A8482C", "#D97757", "#F2A27F"], dim: "#3A221A", line: "#8A4A34" },
  { id: "codex", name: "Codex", staleMin: 120,
    stops: ["#3941FF", "#7A9DFF", "#B1A7FF"], dim: "#232B4A", line: "#5466B0" },
];
const WEEK = 7 * 864e5;
const PAD = 18, GAP = 16, HEAD = 18; // widget side padding, gap between meters, header height
// The medium widget's size in points, by screen width. The ring takes the
// height left after the header and three equal gaps, as far as a column allows.
const SIZE = (() => {
  const s = Device.screenSize().width;
  return s >= 428 ? [364, 170] : s >= 414 ? [360, 169] : s >= 390 ? [338, 158] : s >= 375 ? [329, 155] : [292, 141];
})();
const UNUSED = "#3A3A3C";
const RING = Math.floor(Math.min((SIZE[0] - 2 * PAD - GAP) / 2, SIZE[1] - HEAD - 3 * 8));
const LINE = Math.round(RING * 0.095);
// Narrow and wide characters, in ems; everything else is taken as ~0.62.
const EM = { " ": 0.28, i: 0.27, l: 0.27, r: 0.4, t: 0.38, f: 0.36, m: 0.92, w: 0.82, "-": 0.4 };

const fm = FileManager.local();
const cached = (name) => fm.joinPath(fm.cacheDirectory(), `pacedex-${name}`);

const widget = await build();
if (config.runsInApp) await widget.presentMedium();
Script.setWidget(widget);
Script.complete();

async function build() {
  const w = new ListWidget();
  // Black with ember and lavender light in the corners, rendered ahead of time:
  // Scriptable's own gradients are linear only and band visibly.
  const bg = await asset("bg-dusk", "v2");
  if (bg) w.backgroundImage = bg;
  else w.backgroundColor = Color.black();
  if (BASE) w.url = BASE;
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  // No top or bottom padding: each meter's spacers share the height equally.
  w.setPadding(0, PAD, 0, PAD);

  const snap = key && BASE ? await loadSnapshot() : null;
  if (!snap) {
    centered(w, key && BASE ? "Can't reach Pacedex" : "Connect in Pacedex's settings", MUTED, Font.mediumSystemFont(13));
    return w;
  }

  // Both readings share one size, set by the wider of the two, so "2d 1h"
  // never looks bigger than "4d 21h" beside it.
  const states = PROVIDERS.map((prov) => status(prov, snap[prov.id] || {}));
  const size = valueSize(states.map((s) => s.value));

  const row = w.addStack();
  row.spacing = GAP;
  for (const [i, prov] of PROVIDERS.entries()) await meter(row, prov, snap[prov.id] || {}, states[i], size);
  return w;
}

// What shows inside the ring in place of the reading: nothing, unless
// something is wrong. Values stay short so the shared size stays large.
function status(prov, p) {
  const age = p.fetched_at ? Date.now() - p.fetched_at : null;
  const [label, value, color] =
    !p.linked ? ["Not", "linked", MUTED]
    : p.needs_relink ? ["Sign-in", "Expired", WARN]
    : age == null ? ["Waiting for", "data", WARN]
    : age > prov.staleMin * 60 * 1000 ? ["Updated", `${short(age).split(" ")[0]} ago`, WARN]
    : [null, null, null];
  return { label, value, color };
}

// Scriptable can't measure text, so estimate each value's width from rough
// SF Pro Semibold advances (in ems, erring wide) and take the largest size
// up to 16pt at which the wider value fits inside the ring.
function valueSize(values) {
  const room = RING - 2 * LINE - 16;
  const em = (t) => [...t].reduce((n, ch) => n + (EM[ch] ?? (/\d/.test(ch) ? 0.64 : 0.62)), 0);
  const widest = Math.max(1, ...values.filter(Boolean).map(em));
  return Math.max(11, Math.min(16, Math.floor((room / widest) * 2) / 2));
}

// The latest snapshot, or the last one saved when the Worker can't be reached.
// Its fetched_at still tells the truth about its age.
async function loadSnapshot() {
  const path = cached("snapshot.json");
  try {
    const req = new Request(`${BASE}/api/usage`);
    req.headers = { Authorization: `Bearer ${key}` };
    req.timeoutInterval = 15;
    const snap = await req.loadJSON();
    if (req.response.statusCode === 200) {
      fm.writeString(path, JSON.stringify(snap));
      return snap;
    }
  } catch {}
  return fm.fileExists(path) ? JSON.parse(fm.readString(path)) : null;
}

// Logo and name on top, the ring below, both centred; inside the ring the
// reading, or what's wrong if anything is.
async function meter(row, prov, p, state, size) {
  // Three flexible spacers split the spare height evenly, so the gaps above
  // the header, between header and ring, and below the ring all match.
  const col = row.addStack();
  col.layoutVertically();
  col.addSpacer();

  const head = col.addStack();
  head.centerAlignContent();
  head.addSpacer();
  const mark = await asset(prov.id, "v1");
  if (mark) {
    head.addImage(mark).imageSize = new Size(HEAD, HEAD);
    head.addSpacer(6);
  }
  addText(head, prov.name, MUTED, Font.semiboldSystemFont(13));
  head.addSpacer();

  col.addSpacer();

  const line = col.addStack();
  line.addSpacer();
  const w = p.weekly;
  const used = p.linked && w ? Math.floor(w.used_percent) : null;
  const ring = line.addStack();
  ring.size = new Size(RING, RING);
  const resetAt = p.linked && w?.resets_at ? new Date(w.resets_at) : null;
  ring.backgroundImage = ringImage(prov, used, resetAt);
  ring.centerAlignContent();
  line.addSpacer();

  if (state.label) {
    ring.layoutVertically();
    ring.addSpacer();
    for (const [text, color, font] of [[state.label, MUTED, Font.mediumSystemFont(11)], [state.value, state.color, Font.semiboldSystemFont(size)]]) {
      const t = addText(ring, text, color, font);
      t.centerAlignText();
    }
    ring.addSpacer();
  } else if (used != null) {
    const num = ring.addStack();
    num.bottomAlignContent();
    num.spacing = 1;
    addText(num, String(used), TEXT, Font.semiboldSystemFont(Math.round(RING * 0.28)));
    const pct = num.addStack();
    pct.setPadding(0, 0, Math.round(RING * 0.045), 0);
    addText(pct, "%", MUTED, Font.mediumSystemFont(Math.round(RING * 0.11)));
  }
  col.addSpacer();
}

// The week, as in the app: seven days from this service's own reset, starting
// at 12 o'clock. Time gone is solid and time to come is hollow, with a white
// capsule at now where one meets the other. Usage fills over all of it, deep at
// the start and bright at the head. Time gone but not used is grey.
// DrawContext has no arcs, gradients or round caps, so every arc is a chain of
// short lines and the capsule's ends are dots.
function ringImage(prov, used, resetAt) {
  const dc = new DrawContext();
  dc.size = new Size(RING, RING);
  dc.opaque = false;
  dc.respectScreenScale = true;
  const r = (RING - LINE) / 2, c = RING / 2;
  const at = (t, rad = r) => {
    const a = -Math.PI / 2 + 2 * Math.PI * t;
    return new Point(c + rad * Math.cos(a), c + rad * Math.sin(a));
  };
  const points = (t0, t1, rad) => {
    const n = Math.max(2, Math.ceil((t1 - t0) * 240));
    return Array.from({ length: n + 1 }, (_, i) => at(t0 + ((t1 - t0) * i) / n, rad));
  };
  const stroke = (pts, color, width, close = false) => {
    const path = new Path();
    path.addLines(pts);
    if (close) path.closeSubpath();
    dc.addPath(path);
    dc.setLineWidth(width);
    dc.setStrokeColor(new Color(color));
    dc.strokePath();
  };

  const f = Math.min(100, used ?? 0) / 100;
  const now = resetAt ? Math.min(1, Math.max(0, 1 - (resetAt - Date.now()) / WEEK)) : null;
  const today = now == null ? -1 : Math.min(6, Math.floor(now * 7));
  // One stretch of ring: its empty track (grey, or the service's dim when the
  // week's position is unknown), then whatever part of the fill lies on it.
  const band = (a, b, width, empty = true) => {
    if (empty) stroke(points(a, b, r), now == null ? prov.dim : UNUSED, width);
    if (f <= a) return;
    const e = Math.min(b, f), n = Math.ceil((e - a) * 180) + 1;
    for (let i = 0; i < n; i++) {
      const t0 = a + ((e - a) * i) / n, t1 = Math.min(e, a + ((e - a) * (i + 1)) / n + 0.002);
      stroke([at(t0), at(t1)], colorHex(prov.stops, (t0 + t1) / 2 / f), width);
    }
  };
  // Time to come: an outline, with any usage drawn narrower inside it.
  const hollow = (a, b) => {
    const o = r + LINE / 2 - 0.6, i = r - LINE / 2 + 0.6;
    stroke([...points(a, b, o), ...points(a, b, i).reverse()], prov.line, 1.2, true);
    band(a, b, LINE - 2.4, false);
  };
  for (let d = 0; d < 7; d++) {
    const a = d / 7 + 0.009, b = (d + 1) / 7 - 0.009;
    if (today >= 0 && d > today) hollow(a, b);
    else if (d === today && now < b) {
      if (now > a) band(a, now, LINE);
      hollow(Math.max(a, now), b);
    } else band(a, b, LINE);
  }
  // The capsule: a white bar across the ring at now, in a black halo.
  if (now != null) {
    const u = LINE / 9;
    const capsule = (over, width, color) => {
      const ends = [at(now, r - LINE / 2 - over), at(now, r + LINE / 2 + over)];
      stroke(ends, color, width);
      dc.setFillColor(new Color(color));
      for (const e of ends) dc.fillEllipse(new Rect(e.x - width / 2, e.y - width / 2, width, width));
    };
    capsule(1.2 * u, 6.4 * u, "#000000");
    capsule(0.6 * u, 3 * u, "#F5F5F7");
  }
  return dc.getImage();
}

function colorHex(stops, t) {
  const pos = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(pos), f = pos - i;
  const [a, b] = [stops[i], stops[i + 1]].map((h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)));
  return `#${a.map((v, k) => Math.round(v + (b[k] - v) * f).toString(16).padStart(2, "0")).join("")}`;
}

// Images served next to this script, cached after the first download. Bump
// the version when an image changes.
async function asset(name, version) {
  if (!BASE) return null;
  const path = cached(`${name}-${version}.png`);
  if (fm.fileExists(path)) return fm.readImage(path);
  try {
    const img = await new Request(`${BASE}/widget/${name}.png`).loadImage();
    fm.writeImage(path, img);
    return img;
  } catch {
    return null;
  }
}

// Compact durations, as in the app: 8m, 3h 5m, 2d 4h.
function short(ms) {
  const m = Math.max(0, Math.round(ms / 6e4)), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
  if (h) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return m < 1 ? "now" : `${m}m`;
}

function centered(parent, text, color, font) {
  parent.addSpacer();
  const s = parent.addStack();
  s.addSpacer();
  const t = s.addText(text);
  s.addSpacer();
  t.textColor = color;
  t.font = font;
  t.centerAlignText();
  parent.addSpacer();
}

function addText(stack, text, color, font) {
  const t = stack.addText(text);
  t.textColor = color;
  t.font = font;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  return t;
}
