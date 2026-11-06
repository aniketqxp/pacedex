// Pacedex Worker: keeps its own OAuth sessions for Claude and Codex, polls
// their usage endpoints on a cron, and serves the cached snapshot to the app
// and the widget. One deployment serves one person.

import { sendPush } from "./push.js";
import { DEFAULT_PREFS, SERVICES, decide, safeZone, testPayloads, windowAt } from "./notify.js";

const CLAUDE = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  redirectUri: "https://platform.claude.com/oauth/code/callback",
  // Mirrors the scopes Claude Code requests on a claude.ai login.
  loginScopes: ["org:create_api_key", "user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload", "user:plugins"],
  refreshScopes: ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload", "user:plugins"],
  usageUrl: "https://api.anthropic.com/api/oauth/usage",
  profileUrl: "https://api.anthropic.com/api/oauth/profile",
};

const CODEX = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  issuer: "https://auth.openai.com",
  deviceUrl: "https://auth.openai.com/codex/device",
  redirectUri: "https://auth.openai.com/deviceauth/callback",
  usageUrl: "https://chatgpt.com/backend-api/wham/usage",
};

const REFRESH_MARGIN_MS = 15 * 60 * 1000;
// Codex readings older than this make the cron start the relay itself.
const CODEX_STALE_MS = 50 * 60 * 1000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    // The GitHub Actions relay gets its own key, scoped to the /api/relay/ routes,
    // and the home-screen widget gets one that can only read the snapshot.
    const keys = url.pathname.startsWith("/api/relay/") ? [env.RELAY_KEY]
      : req.method === "GET" && url.pathname === "/api/usage" ? [env.APP_KEY, env.WIDGET_KEY]
      : [env.APP_KEY];
    if (!keys.some((k) => authorized(req, k))) return json({ error: "unauthorized" }, 401);
    try {
      return await route(req, url.pathname, env);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    // Notifications read the snapshot this run just refreshed.
    ctx.waitUntil(pollAll(env, { allowTokenRefresh: true }).then(() => Promise.allSettled([codexWatchdog(env), notifyCheck(env)])));
  },
};

async function route(req, path, env) {
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  switch (`${req.method} ${path}`) {
    case "GET /api/usage":
      return json(await readSnapshot(env));
    case "GET /api/widget-key":
      return json({ key: env.WIDGET_KEY || null });
    case "POST /api/claude/start":
      return json(await claudeStart(env));
    case "POST /api/claude/finish":
      return json(await claudeFinish(env, body.code));
    case "POST /api/codex/start":
      return json(await codexStart(env));
    case "POST /api/codex/poll":
      return json(await codexPoll(env));
    case "GET /api/relay/codex-token":
      return json(await relayCodexToken(env));
    case "POST /api/relay/codex-usage":
      await relayCodexUsage(env, body);
      return json({ ok: true });
    case "POST /api/notify/status":
      return json(await notifyStatus(env, body));
    case "POST /api/notify/subscribe":
      return json(await notifySubscribe(env, body));
    case "POST /api/notify/unsubscribe":
      return json(await notifyUnsubscribe(env, body));
    case "POST /api/notify/prefs":
      return json(await notifyPrefs(env, body));
    case "POST /api/notify/test":
      return json(await notifyTest(env, body));
    case "POST /api/unlink":
      if (!SERVICES.includes(body.provider)) return json({ error: "unknown provider" }, 400);
      await env.USAGE.delete(`tokens:${body.provider}`);
      await env.USAGE.delete(`usage:${body.provider}`);
      return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

// ---------- polling ----------

async function pollAll(env, opts) {
  await Promise.all([
    pollProvider(env, "claude", fetchClaudeUsage, refreshClaude, opts),
    // chatgpt.com blocks requests from Workers, so Codex usage arrives via the
    // GitHub Actions relay; here we only keep its tokens fresh.
    pollProvider(env, "codex", null, refreshCodex, opts),
  ]);
}

async function pollProvider(env, provider, fetchUsage, refresh, { allowTokenRefresh }) {
  let tokens = await loadTokens(env, provider);
  if (!tokens) return;
  const prev = (await env.USAGE.get(`usage:${provider}`, "json")) || {};
  try {
    if (tokens.expires_at - Date.now() < REFRESH_MARGIN_MS) {
      if (!allowTokenRefresh) return;
      tokens = await refresh(tokens);
      await saveTokens(env, provider, tokens);
    }
    if (!fetchUsage) return;
    const usage = await fetchUsage(tokens);
    await env.USAGE.put(`usage:${provider}`, JSON.stringify({ ...usage, fetched_at: Date.now(), error: null }));
  } catch (e) {
    const needsRelink = e.status === 400 || e.status === 401;
    await env.USAGE.put(`usage:${provider}`, JSON.stringify({ ...prev, error: String(e.message || e), needs_relink: needsRelink }));
  }
}

async function readSnapshot(env) {
  const out = {};
  for (const p of ["claude", "codex"]) {
    const linked = !!(await env.USAGE.get(`tokens:${p}`));
    out[p] = { linked, ...((await env.USAGE.get(`usage:${p}`, "json")) || {}) };
  }
  return out;
}

// GitHub runs scheduled workflows late, or skips them when busy. Cloudflare's
// cron runs on time, so once Codex readings go stale it starts the relay
// itself, which keeps them under about an hour and a half old at worst.
async function codexWatchdog(env) {
  if (!env.GH_TOKEN || !(await env.USAGE.get("tokens:codex"))) return;
  const usage = (await env.USAGE.get("usage:codex", "json")) || {};
  if (usage.needs_relink) return;
  if (usage.fetched_at && Date.now() - usage.fetched_at < CODEX_STALE_MS) return;
  // One nudge per half hour, so a failing relay can't burn Actions minutes.
  if (await env.USAGE.get("dispatch:codex")) return;
  await env.USAGE.put("dispatch:codex", "1", { expirationTtl: 1800 });
  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/codex-usage.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "pacedex",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (!res.ok) await env.USAGE.put("usage:codex", JSON.stringify({ ...usage, error: `Couldn't start the Codex relay: HTTP ${res.status}` }));
}

// ---------- Claude ----------

async function claudeStart(env) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  await env.USAGE.put("pending:claude", JSON.stringify({ verifier, state }), { expirationTtl: 900 });
  const u = new URL(CLAUDE.authorizeUrl);
  u.searchParams.set("code", "true");
  u.searchParams.set("client_id", CLAUDE.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", CLAUDE.redirectUri);
  u.searchParams.set("scope", CLAUDE.loginScopes.join(" "));
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  return { url: u.toString() };
}

async function claudeFinish(env, pasted) {
  const pending = await env.USAGE.get("pending:claude", "json");
  if (!pending) throw new Error("Link session expired, start again");
  const [code, state] = String(pasted || "").trim().split("#");
  if (state && state !== pending.state) throw new Error("State mismatch, start again");
  const data = await postJson(CLAUDE.tokenUrl, {
    grant_type: "authorization_code",
    code,
    state: pending.state,
    redirect_uri: CLAUDE.redirectUri,
    client_id: CLAUDE.clientId,
    code_verifier: pending.verifier,
  });
  await env.USAGE.delete("pending:claude");
  const tokens = claudeTokens(data);
  await saveTokens(env, "claude", tokens);
  await pollProvider(env, "claude", fetchClaudeUsage, refreshClaude, { allowTokenRefresh: false });
  return { ok: true, account: data.account?.email_address };
}

async function refreshClaude(tokens) {
  const data = await postJson(CLAUDE.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: CLAUDE.clientId,
    scope: CLAUDE.refreshScopes.join(" "),
  });
  return claudeTokens(data, tokens);
}

function claudeTokens(data, prev = {}) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || prev.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

async function fetchClaudeUsage(tokens) {
  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": "claude-code/2.1.0",
  };
  const [d, profile] = await Promise.all([
    getJson(CLAUDE.usageUrl, headers),
    // The plan name is a nicety; a profile failure must not hide the usage.
    getJson(CLAUDE.profileUrl, headers).catch(() => null),
  ]);
  return {
    weekly: usageWindow(d.seven_day?.utilization, d.seven_day?.resets_at),
    session: usageWindow(d.five_hour?.utilization, d.five_hour?.resets_at),
    plan: claudePlan(profile),
  };
}

function claudePlan(profile) {
  const org = profile?.organization || {};
  const tier = `${org.rate_limit_tier || ""} ${org.organization_type || ""}`.toLowerCase();
  if (tier.includes("20x")) return "Max 20x";
  if (tier.includes("5x")) return "Max 5x";
  if (tier.includes("max") || profile?.account?.has_claude_max) return "Max";
  if (tier.includes("pro") || profile?.account?.has_claude_pro) return "Pro";
  return null;
}

// ---------- Codex (device-code login) ----------

async function codexStart(env) {
  const d = await postJson(`${CODEX.issuer}/api/accounts/deviceauth/usercode`, { client_id: CODEX.clientId });
  const userCode = d.user_code || d.usercode;
  await env.USAGE.put("pending:codex", JSON.stringify({ device_auth_id: d.device_auth_id, user_code: userCode }), { expirationTtl: 900 });
  return { user_code: userCode, verification_url: CODEX.deviceUrl, interval: Number(d.interval) || 5 };
}

async function codexPoll(env) {
  const pending = await env.USAGE.get("pending:codex", "json");
  if (!pending) throw new Error("Link session expired, start again");
  const res = await fetch(`${CODEX.issuer}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pending),
  });
  if (res.status === 403 || res.status === 404) return { status: "pending" };
  if (!res.ok) throw httpError(res.status, await res.text());
  const grant = await res.json();
  const data = await postForm(`${CODEX.issuer}/oauth/token`, {
    grant_type: "authorization_code",
    code: grant.authorization_code,
    redirect_uri: CODEX.redirectUri,
    client_id: CODEX.clientId,
    code_verifier: grant.code_verifier,
  });
  await env.USAGE.delete("pending:codex");
  await saveTokens(env, "codex", codexTokens(data));
  await env.USAGE.put("usage:codex", JSON.stringify({ error: null, note: "Waiting for first relay run" }));
  // With GH_TOKEN set, the first reading arrives in about a minute instead of
  // at the next scheduled run. A fresh sign-in deserves its own nudge.
  await env.USAGE.delete("dispatch:codex");
  await codexWatchdog(env);
  return { status: "linked" };
}

async function refreshCodex(tokens) {
  const data = await postJson(`${CODEX.issuer}/oauth/token`, {
    client_id: CODEX.clientId,
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    scope: "openid profile email",
  });
  return codexTokens(data, tokens);
}

function codexTokens(data, prev = {}) {
  const idToken = data.id_token || prev.id_token;
  const accessClaims = jwtClaims(data.access_token);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || prev.refresh_token,
    id_token: idToken,
    account_id: jwtClaims(idToken)?.["https://api.openai.com/auth"]?.chatgpt_account_id || prev.account_id,
    expires_at: accessClaims?.exp ? accessClaims.exp * 1000 : Date.now() + 3600 * 1000,
  };
}

// The relay asks for the request to make, makes it from GitHub's network, and
// posts back the raw response. Token refresh stays in the Worker's cron.
async function relayCodexToken(env) {
  const health = await healthProblems(env);
  const tokens = await loadTokens(env, "codex");
  if (!tokens) return { request: null, health };
  if (tokens.expires_at <= Date.now()) return { request: null, reason: "token expired; waiting for cron refresh", health };
  return {
    health,
    request: {
      url: CODEX.usageUrl,
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "ChatGPT-Account-Id": tokens.account_id,
        originator: "codex_cli_rs",
        "User-Agent": "codex_cli_rs/0.158.0",
      },
    },
  };
}

// The relay runs at least hourly anyway, so it doubles as the alarm: any problem
// listed here fails the GitHub run, and GitHub emails the repo owner.
async function healthProblems(env) {
  const problems = [];
  const snap = await readSnapshot(env);
  const stale = (p, mins) => !p.fetched_at || Date.now() - p.fetched_at > mins * 60 * 1000;
  if (snap.claude.linked) {
    if (snap.claude.error) problems.push(`Claude: ${snap.claude.error}`);
    else if (stale(snap.claude, 40)) problems.push("Claude: no fresh reading in 40 min");
  }
  if (snap.codex.linked) {
    if (snap.codex.error) problems.push(`Codex: ${snap.codex.error}`);
    else if (stale(snap.codex, 90)) problems.push("Codex: no fresh reading in 90 min");
    const tokens = await loadTokens(env, "codex");
    if (tokens && tokens.expires_at <= Date.now()) problems.push("Codex: access token expired and was not refreshed");
  }
  return problems;
}

async function relayCodexUsage(env, { status, body }) {
  const prev = (await env.USAGE.get("usage:codex", "json")) || {};
  let next;
  if (status === 200) {
    try {
      next = { ...parseCodexUsage(JSON.parse(body)), fetched_at: Date.now(), error: null };
    } catch (e) {
      next = { ...prev, error: `Unparseable usage response: ${String(body).slice(0, 200)}` };
    }
  } else {
    next = { ...prev, error: `HTTP ${status}: ${String(body).slice(0, 200)}`, needs_relink: status === 401 };
  }
  await env.USAGE.put("usage:codex", JSON.stringify(next));
}

function parseCodexUsage(d) {
  const wins = [d.rate_limit?.primary_window, d.rate_limit?.secondary_window].filter(Boolean);
  const pick = (secs) => wins.find((w) => w.limit_window_seconds === secs);
  const weekly = pick(604800) || d.rate_limit?.secondary_window;
  const session = pick(18000) || d.rate_limit?.primary_window;
  const toWin = (w) => w && usageWindow(w.used_percent, w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null);
  const plan = d.plan_type ? d.plan_type[0].toUpperCase() + d.plan_type.slice(1) : null;
  return { weekly: toWin(weekly), session: toWin(session), plan };
}

// ---------- notifications ----------
// notify:config holds the phones subscribed, the switches and the user's time
// zone, and changes only when the user does something. notify:state holds what
// has been sent, and is written only when something is, so the 10-minute cron
// costs reads, not writes.

const MAX_SUBS = 10;

// The public key is read off the private JWK (its x and y), so the pair can
// never drift apart. Apple's push service insists on a subject.
function vapidOf(env) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_SUBJECT) return null;
  const privateJwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const publicKey = b64url(new Uint8Array([4, ...unb64url(privateJwk.x), ...unb64url(privateJwk.y)]));
  return { publicKey, privateJwk, subject: env.VAPID_SUBJECT };
}

async function loadNotify(env) {
  const cfg = (await env.USAGE.get("notify:config", "json")) || {};
  return { subs: cfg.subs || {}, prefs: cleanPrefs(cfg.prefs), fmt: cfg.fmt || { tz: "UTC", hour12: true } };
}

const saveNotify = (env, cfg) => env.USAGE.put("notify:config", JSON.stringify(cfg));

// Only known switches, only booleans; anything else falls back to the default.
function cleanPrefs(p = {}) {
  const bool = (v, d) => (typeof v === "boolean" ? v : d);
  const out = { services: {} };
  for (const k of ["ahead", "behind", "broken", "recap"]) out[k] = bool(p?.[k], DEFAULT_PREFS[k]);
  for (const s of SERVICES) out.services[s] = bool(p?.services?.[s], DEFAULT_PREFS.services[s]);
  return out;
}

// The phone reports its zone and clock style each time it talks to us, so
// travelling or switching to 24-hour time carries over.
function cleanFmt(body, prev) {
  return {
    tz: typeof body.tz === "string" && body.tz.length < 64 ? safeZone(body.tz) : prev.tz,
    hour12: typeof body.hour12 === "boolean" ? body.hour12 : prev.hour12,
  };
}

async function subId(endpoint) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return b64url(new Uint8Array(hash)).slice(0, 22);
}

function cleanSub(s) {
  let url;
  try { url = new URL(s?.endpoint); } catch { throw new Error("Invalid subscription"); }
  if (url.protocol !== "https:" || s.endpoint.length > 2048) throw new Error("Invalid subscription");
  const p256dh = unb64url(String(s.keys?.p256dh || "")), auth = unb64url(String(s.keys?.auth || ""));
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) throw new Error("Invalid subscription keys");
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

async function notifyStatus(env, { endpoint }) {
  const cfg = await loadNotify(env);
  const subscribed = typeof endpoint === "string" && !!cfg.subs[await subId(endpoint)];
  return { publicKey: vapidOf(env)?.publicKey || null, prefs: cfg.prefs, subscribed };
}

async function notifySubscribe(env, body) {
  if (!vapidOf(env)) throw new Error("Notifications aren't set up on the server yet");
  const sub = cleanSub(body.subscription);
  const cfg = await loadNotify(env);
  cfg.subs[await subId(sub.endpoint)] = { ...sub, added: Date.now() };
  // Old phones never unsubscribe; keep the newest few.
  const ids = Object.keys(cfg.subs).sort((a, b) => cfg.subs[b].added - cfg.subs[a].added);
  for (const id of ids.slice(MAX_SUBS)) delete cfg.subs[id];
  cfg.fmt = cleanFmt(body, cfg.fmt);
  await saveNotify(env, cfg);
  return { prefs: cfg.prefs, subscribed: true };
}

async function notifyUnsubscribe(env, { endpoint }) {
  const cfg = await loadNotify(env);
  if (typeof endpoint === "string") delete cfg.subs[await subId(endpoint)];
  await saveNotify(env, cfg);
  return { subscribed: false };
}

async function notifyPrefs(env, body) {
  const cfg = await loadNotify(env);
  cfg.prefs = cleanPrefs({ ...cfg.prefs, ...body.prefs, services: { ...cfg.prefs.services, ...body.prefs?.services } });
  cfg.fmt = cleanFmt(body, cfg.fmt);
  await saveNotify(env, cfg);
  return { prefs: cfg.prefs };
}

// Sends to the phone that asked only, and touches none of the weekly counts.
async function notifyTest(env, body) {
  const vapid = vapidOf(env);
  if (!vapid) throw new Error("Notifications aren't set up on the server yet");
  const cfg = await loadNotify(env);
  const id = typeof body.endpoint === "string" ? await subId(body.endpoint) : null;
  if (!id || !cfg.subs[id]) throw new Error("This phone isn't subscribed. Turn notifications off and on again.");
  cfg.fmt = cleanFmt(body, cfg.fmt);
  // One per linked service, exactly as the real ones would arrive.
  for (const payload of testPayloads(await readSnapshot(env), Date.now(), cfg.fmt)) {
    const status = await sendPush(cfg.subs[id], payload, vapid, { ttl: 600 });
    if (status === 404 || status === 410) {
      delete cfg.subs[id];
      await saveNotify(env, cfg);
      throw new Error("This phone's subscription has expired. Turn notifications off and on again.");
    }
    if (status < 200 || status > 299) throw new Error(`The push service refused it (HTTP ${status})`);
  }
  return { ok: true };
}

async function notifyCheck(env) {
  const vapid = vapidOf(env);
  if (!vapid) return;
  const cfg = await loadNotify(env);
  const now = Date.now();
  // Outside the morning and evening windows there's nothing more to read.
  if (!Object.keys(cfg.subs).length || !windowAt(now, cfg.fmt.tz)) return;
  const [snapshot, state] = await Promise.all([readSnapshot(env), env.USAGE.get("notify:state", "json")]);
  const due = decide({ snapshot, prefs: cfg.prefs, state: state || {}, now, fmt: cfg.fmt });
  if (!due.length) return;
  // Each service is sent and recorded on its own. Nothing is marked as sent
  // unless some phone accepted it; a failure is retried on the next run, with
  // the wording worked out afresh.
  const next = { ...state };
  let changed = false;
  for (const { service, payload, state: st } of due) {
    if (payload && !(await pushAll(env, cfg, payload, vapid))) continue;
    next[service] = st;
    changed = true;
  }
  if (changed) await env.USAGE.put("notify:state", JSON.stringify(next));
}

async function pushAll(env, cfg, payload, vapid) {
  let delivered = 0, dropped = false;
  for (const [id, sub] of Object.entries(cfg.subs)) {
    try {
      const status = await sendPush(sub, payload, vapid);
      if (status >= 200 && status < 300) delivered++;
      else if (status === 404 || status === 410) { delete cfg.subs[id]; dropped = true; }
      else console.log(`push to ${new URL(sub.endpoint).host} failed: HTTP ${status}`);
    } catch (e) {
      console.log(`push failed: ${e.message || e}`);
    }
  }
  if (dropped) await saveNotify(env, cfg);
  return delivered > 0;
}

// ---------- token storage (AES-GCM at rest) ----------

async function encKey(env) {
  const raw = Uint8Array.from(atob(env.ENC_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function saveTokens(env, provider, tokens) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encKey(env), new TextEncoder().encode(JSON.stringify(tokens)));
  await env.USAGE.put(`tokens:${provider}`, JSON.stringify({ iv: b64url(iv), ct: b64url(new Uint8Array(ct)) }));
}

async function loadTokens(env, provider) {
  const rec = await env.USAGE.get(`tokens:${provider}`, "json");
  if (!rec) return null;
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(rec.iv) }, await encKey(env), unb64url(rec.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ---------- helpers ----------

function usageWindow(usedPercent, resetsAt) {
  return usedPercent == null ? null : { used_percent: Number(usedPercent), resets_at: resetsAt || null };
}

function authorized(req, want = "") {
  const given = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
  if (!want || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function httpError(status, text) {
  const e = new Error(`HTTP ${status}: ${text.slice(0, 300)}`);
  e.status = status;
  return e;
}

async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw httpError(res.status, await res.text());
  return res.json();
}

async function postForm(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  if (!res.ok) throw httpError(res.status, await res.text());
  return res.json();
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw httpError(res.status, await res.text());
  return res.json();
}

function jwtClaims(token) {
  try {
    return JSON.parse(new TextDecoder().decode(unb64url(token.split(".")[1])));
  } catch {
    return null;
  }
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
