// Notifications: which ones are due, and their wording. Everything here is a
// pure function of the snapshot, the clock and the saved state, so the cron,
// the test button and the tests all run the same code.

const H = 3600 * 1000, D = 24 * H, WEEK = 7 * D;

export const NAMES = { claude: "Claude Code", codex: "Codex" };
export const SERVICES = Object.keys(NAMES);
// Readings older than this are too old to judge pace from (the app's own limits).
const FRESH_MS = { claude: 60 * 60 * 1000, codex: 120 * 60 * 1000 };
const BROKEN_AFTER = 6 * H;
// Local hours [from, to) when anything may be sent.
const WINDOWS = [{ id: "am", from: 8, to: 10 }, { id: "pm", from: 18, to: 21 }];

export const DEFAULT_PREFS = {
  ahead: true, behind: true, broken: true, recap: false,
  services: { claude: true, codex: true },
};

// ---------- formatting ----------

export const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;

// Floor, so 99.6 never reads as 100 and "on pace to run out" never sits next
// to a full meter. Anything that isn't a sane percentage means "don't send".
export function pct(u) {
  if (typeof u !== "number" || !Number.isFinite(u) || u < 0 || u > 100) return null;
  return u > 0 && u < 1 ? "under 1%" : `${Math.floor(u)}%`;
}

export function safeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

// Calendar fields of an instant in the user's zone. Words stay English
// whatever the phone's language, so only the clock style follows the phone.
function local(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", hourCycle: "h23", weekday: "short",
  }).formatToParts(new Date(ms));
  const f = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    day: Date.UTC(+f.year, +f.month - 1, +f.day) / D, // whole days, for "today"/"tomorrow"
    date: `${f.year}-${f.month.padStart(2, "0")}-${f.day.padStart(2, "0")}`,
    weekday: f.weekday,
    hour: +f.hour % 24, minute: +f.minute,
  };
}

export function clock(ms, { tz, hour12 }) {
  const { minute } = local(ms, tz);
  // "9 AM" reads better than "9:00 AM"; 24-hour clocks always keep minutes.
  // h23 rather than hour12:false, which some engines render midnight as 24:00.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", ...(hour12 ? { hour12: true } : { hourCycle: "h23" }),
    ...(hour12 && minute === 0 ? {} : { minute: "2-digit" }),
  }).format(new Date(ms));
}

// "today", "tomorrow" or "Thu", relative to now in the user's zone. A week
// out is "next Sun", or on a Sunday it would read as today.
function dayWord(ms, now, tz) {
  const diff = local(ms, tz).day - local(now, tz).day;
  const wd = local(ms, tz).weekday;
  return diff === 0 ? "today" : diff === 1 ? "tomorrow" : diff >= 7 ? `next ${wd}` : wd;
}

const capitalize = (s) => s && s[0].toUpperCase() + s.slice(1);

// "Resets Sat at 9 AM". Reset times come back a hair early (8:59:59), so they
// are rounded to the minute before anything reads them.
export function resetPhrase(resetMs, now, fmt) {
  const r = Math.round(resetMs / 60000) * 60000;
  return `Resets ${dayWord(r, now, fmt.tz)} at ${clock(r, fmt)}`;
}

// When the week's allowance runs out at the current rate.
export function runOutPhrase(runOutMs, now, fmt) {
  const h = (runOutMs - now) / H;
  if (h < 1) return "within the hour";
  if (h < 12) return `in about ${plural(Math.round(h), "hour")}`;
  const word = dayWord(runOutMs, now, fmt.tz);
  return word === "today" ? "later today" : word === "tomorrow" ? "tomorrow" : `on ${word}`;
}

// "39 hours" up to two days, so it never contradicts "Resets tomorrow"; whole
// days (rounded down, never overstated) beyond that.
export function timeLeft(ms) {
  const h = ms / H;
  return h < 48 ? plural(Math.max(1, Math.floor(h)), "hour") : plural(Math.floor(h / 24), "day");
}

function agePhrase(ms) {
  const h = Math.floor(ms / H);
  return h < 48 ? plural(h, "hour") : plural(Math.floor(h / 24), "day");
}

// ---------- reading a service ----------

// The numbers pace is judged on, or null when they can't be trusted.
export function reading(p, service, now) {
  if (!p?.linked || p.needs_relink || !p.fetched_at) return null;
  if (now - p.fetched_at > FRESH_MS[service]) return null;
  const u = p.weekly?.used_percent, reset = Date.parse(p.weekly?.resets_at);
  if (pct(u) == null || !Number.isFinite(reset)) return null;
  // A reset in the past, or further off than a week, is data we don't understand.
  if (reset <= now || reset - now > WEEK + H) return null;
  const elapsed = now - (reset - WEEK);
  if (elapsed <= 0) return null;
  return { used: u, reset, elapsed };
}

export function problem(p, now) {
  if (!p?.linked) return null;
  if (p.needs_relink) return "relink";
  if (p.fetched_at && now - p.fetched_at > BROKEN_AFTER) return "stale";
  return null;
}

// Each service yields at most one item: running ahead and falling behind
// can't both hold, and a broken service has no pace to judge.
export function itemFor(service, p, now) {
  const kind = problem(p, now);
  if (kind) return { service, type: "broken", kind, since: p.fetched_at };
  const r = reading(p, service, now);
  if (!r) return null;
  const { used, reset, elapsed } = r;
  // Ahead: at least half used, and at this rate it runs out over a day early.
  // The first 12 hours are too short to extrapolate from.
  if (used >= 50 && used < 100 && elapsed >= 12 * H) {
    const runOut = now + ((100 - used) / used) * elapsed;
    if (runOut < reset - D) return { service, type: "ahead", used, reset, runOut };
  }
  // Behind: half the week gone with less than half the even-pace share used,
  // and still enough of the week left to do something about it.
  const frac = elapsed / WEEK;
  if (frac >= 0.5 && used < 50 * frac && reset - now >= 12 * H) {
    return { service, type: "behind", used, reset };
  }
  return null;
}

// ---------- wording ----------

// Every line is a sentence, so "under 1% used" has to start with a capital.
export const line = (item, now, fmt) => capitalize(rawLine(item, now, fmt));

function rawLine(item, now, fmt) {
  if (item.type === "ahead") {
    return `${pct(item.used)} used, on pace to run out ${runOutPhrase(item.runOut, now, fmt)}. ${resetPhrase(item.reset, now, fmt)}.`;
  }
  if (item.type === "behind") {
    return `${pct(item.used)} used, ${timeLeft(item.reset - now)} left. ${resetPhrase(item.reset, now, fmt)}.`;
  }
  if (item.type === "broken") {
    return item.kind === "relink"
      ? "Sign-in expired. Open Pacedex to sign in again."
      : `No updates for ${agePhrase(now - item.since)}. The meter may be out of date.`;
  }
  if (item.type === "recap") {
    return `${pct(item.used)} used this week. ${resetPhrase(item.reset, now, fmt)}.`;
  }
  if (item.type === "status") {
    const r = item.reset ? ` ${resetPhrase(item.reset, now, fmt)}.` : "";
    return `${pct(item.used)} used.${r}`;
  }
  return null;
}

// One notification per service: its own name, logo and tag, so a new Claude
// Code alert replaces the last one on the lock screen and leaves Codex's alone.
export function compose(item, now, fmt) {
  const body = item && line(item, now, fmt);
  if (!body) return null;
  return { title: NAMES[item.service], body, icon: `/widget/${item.service}.png`, tag: `usage-${item.service}`, url: "/" };
}

// Where a service stands right now, for the test button.
export function statusItem(service, p, now) {
  const kind = problem(p, now);
  if (kind) return { service, type: "broken", kind, since: p.fetched_at };
  const u = p?.weekly?.used_percent;
  if (!p?.linked || pct(u) == null) return null;
  const reset = Date.parse(p.weekly.resets_at);
  return { service, type: "status", used: u, reset: Number.isFinite(reset) && reset > now ? reset : null };
}

// The test button sends each linked service as it stands, in the real wording.
export function testPayloads(snapshot, now, fmt) {
  const out = SERVICES.map((s) => compose(statusItem(s, snapshot?.[s], now), now, fmt)).filter(Boolean);
  return out.length ? out : [{ title: "Pacedex", body: "Notifications are working.", icon: "/icon-192.png", tag: "usage", url: "/" }];
}

// ---------- deciding ----------

export function windowAt(now, tz) {
  const { hour, date } = local(now, tz);
  const w = WINDOWS.find((x) => hour >= x.from && hour < x.to);
  return w ? `${date} ${w.id}` : null;
}

// Reset times jitter by seconds to minutes between readings, so "the same
// week" means a reset within 12 hours of the one already noted.
const sameWeek = (a, b) => Number.isFinite(a) && Math.abs(a - b) < 12 * H;

// The summary goes out in the last window that opens at least an hour before
// this service's own reset: Friday evening for a Saturday 9 AM reset, the same
// morning for a 2 PM one. Windows open on the hour, so stepping hourly finds them.
export function lastWindowBefore(reset, now, tz) {
  const win = windowAt(now, tz);
  if (!win || reset <= now || reset - now > 2 * D) return false;
  for (let t = Math.ceil((now + 1) / H) * H; t < reset - H; t += H) {
    const w = windowAt(t, tz);
    if (w && w !== win) return false;
  }
  return true;
}

// One service's next notification, worked out from its own readings, reset
// and history alone. Returns { payload, state } (payload null when only a mark
// was cleared) or null. `st` is never mutated.
function decideOne(s, p, prefs, st, now, fmt) {
  const win = windowAt(now, fmt.tz);
  const marks = { ...st.marks };
  const item = itemFor(s, p, now);
  // A problem is announced once; clearing the mark when it's fixed lets the
  // next one through.
  if (item?.type !== "broken" && marks.broken) delete marks.broken;

  let pick = null;
  if (win && st.window !== win) { // at most one per service per window
    if (item?.type === "broken") {
      if (prefs.broken && marks.broken !== item.kind) { pick = item; marks.broken = item.kind; }
    } else if (item && prefs[item.type] && !sameWeek(marks[item.type], item.reset)) {
      pick = item;
      marks[item.type] = item.reset;
    }
    // An alert sent in the summary's window stands in for it.
    const r = prefs.recap && reading(p, s, now);
    if (r && !sameWeek(marks.recap, r.reset) && lastWindowBefore(r.reset, now, fmt.tz)) {
      marks.recap = r.reset;
      pick ||= { service: s, type: "recap", used: r.used, reset: r.reset };
    }
  }

  const payload = compose(pick, now, fmt);
  if (payload) return { payload, state: { marks, window: win } };
  return JSON.stringify(marks) !== JSON.stringify(st.marks || {}) ? { payload: null, state: { ...st, marks } } : null;
}

// Each service is judged on its own; nothing is combined. Returns one entry
// per service with something to send or save.
export function decide({ snapshot, prefs, state = {}, now, fmt }) {
  prefs = { ...DEFAULT_PREFS, ...prefs, services: { ...DEFAULT_PREFS.services, ...prefs?.services } };
  return SERVICES.filter((s) => prefs.services[s])
    .map((s) => ({ service: s, ...decideOne(s, snapshot?.[s], prefs, state[s] || {}, now, fmt) }))
    .filter((r) => "state" in r);
}
