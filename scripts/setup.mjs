// One command from a fresh copy to a working app: `npm run setup`.
// Safe to run again: keys already in .secrets.local are reused, never replaced,
// so a re-run redeploys without signing your phone or widget out.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import QRCode from "qrcode";

const FILE = ".secrets.local";
const WIN = process.platform === "win32";

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", shell: WIN, ...opts });
const wrangler = (args, opts) => run("npx", ["wrangler", ...args], opts);
const say = (s = "") => console.log(s);
const fail = (s) => { console.error(`\n✗ ${s}`); process.exit(1); };

if (Number(process.versions.node.split(".")[0]) < 20) fail("Node 20 or newer is needed.");

// ---- 1. Cloudflare sign-in ----
say("Checking your Cloudflare sign-in…");
if (/not authenticated|not logged in/i.test(wrangler(["whoami"]).stdout + "")) {
  say("A browser window will open to sign in to Cloudflare.");
  if (wrangler(["login"], { stdio: "inherit" }).status !== 0) fail("Cloudflare sign-in didn't finish.");
}

// ---- 2. Keys: reuse what's saved, make what's missing ----
const saved = existsSync(FILE)
  ? Object.fromEntries(readFileSync(FILE, "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
  : {};
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const keys = {
  APP_KEY: saved.APP_KEY || b64url(random(24)),
  WIDGET_KEY: saved.WIDGET_KEY || b64url(random(24)),
  RELAY_KEY: saved.RELAY_KEY || b64url(random(24)),
  ENC_KEY: saved.ENC_KEY || Buffer.from(random(32)).toString("base64"),
  VAPID_PRIVATE_JWK: saved.VAPID_PRIVATE_JWK || (await vapidKey()),
};

async function vapidKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return JSON.stringify({ kty, crv, x, y, d });
}

// Written before anything is deployed, so a failure later never loses a key.
function save(extra = {}) {
  const all = { ...saved, ...keys, ...extra };
  writeFileSync(FILE, [
    "# Pacedex keys. Never commit or share this file; it is in .gitignore.",
    "# Deleting it and running setup again makes new keys and signs every device out.",
    ...Object.entries(all).map(([k, v]) => `${k}=${v}`),
    "",
  ].join("\n"));
}
save();

// ---- 3. Deploy, and learn the Worker's address ----
say("\nDeploying the Worker (the first run also creates its storage)…");
const output = await new Promise((resolve) => {
  let out = "";
  const p = spawn("npx", ["wrangler", "deploy"], { shell: WIN, stdio: ["inherit", "pipe", "inherit"] });
  p.stdout.on("data", (b) => { process.stdout.write(b); out += b; });
  p.on("close", (code) => (code === 0 ? resolve(out) : fail("Deploy failed; the message above says why.")));
});
const url = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] || saved.WORKER_URL;
if (!url) fail("Deployed, but couldn't find the workers.dev address in Wrangler's output. Add WORKER_URL=https://… to .secrets.local and run setup again.");
save({ WORKER_URL: url });

// ---- 4. Secrets on the Worker ----
// Through stdin, so no key ever appears in a command line or shell history.
say("\nSaving keys on the Worker…");
const github = repoName();
const secrets = { ...keys, VAPID_SUBJECT: url, ...(github && { GH_REPO: github }) };
const bulk = wrangler(["secret", "bulk"], { input: JSON.stringify(secrets) });
if (bulk.status !== 0) fail(`Couldn't save the secrets:\n${bulk.stderr || bulk.stdout}`);

// ---- 5. The Codex relay's two secrets on GitHub ----
function repoName() {
  if (run("gh", ["--version"]).status !== 0) return null;
  const r = run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  return r.status === 0 ? r.stdout.trim() : null;
}
let relayDone = false;
if (github) {
  say(`Saving the relay's secrets on ${github}…`);
  relayDone = [["WORKER_URL", url], ["RELAY_KEY", keys.RELAY_KEY]]
    .every(([name, value]) => run("gh", ["secret", "set", name, "--repo", github], { input: value }).status === 0);
}

// ---- 6. Optional: let the Worker start the relay itself ----
// With a token, Codex's first reading arrives a minute after you sign in, not
// at the next half-hour run, and late scheduled runs get covered. Wrangler asks
// for the value itself and hides it as you paste.
const hasToken = () => /"GH_TOKEN"/.test(wrangler(["secret", "list"]).stdout || "");
if (github && process.stdin.isTTY && !hasToken()) {
  say("\nOptional: a GitHub token lets the Worker start the Codex relay itself, so");
  say("Codex's first reading arrives within a minute and late runs are covered.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const yes = /^y/i.test(await rl.question("Set one up now? (y/N) "));
  rl.close();
  if (yes) {
    say("\nIn your browser, create a fine-grained token:");
    say("  https://github.com/settings/personal-access-tokens/new");
    say(`  Repository access: Only select repositories → ${github}`);
    say("  Permissions: Actions → Read and write");
    say("Then paste it below.");
    if (wrangler(["secret", "put", "GH_TOKEN"], { stdio: "inherit" }).status !== 0) say("Skipped; you can add it later with `npx wrangler secret put GH_TOKEN`.");
  }
}

// ---- Done ----
const link = `${url}/#key=${keys.APP_KEY}`;
say(`\n✓ Pacedex is live at ${url}\n`);
say("Point your iPhone's camera at this code, open the link in Safari,");
say("then tap Share → Add to Home Screen:\n");
say(await QRCode.toString(link, { type: "terminal", small: true }));
say(`Or open the link directly:\n\n  ${link}\n`);
say("The link signs the app in; treat it like a password.");
if (!relayDone) {
  say("\nOne step left for Codex: in your GitHub copy of this repo, open");
  say("Settings → Secrets and variables → Actions, and add two repository secrets:");
  say(`  WORKER_URL  ${url}`);
  say("  RELAY_KEY   the RELAY_KEY line in .secrets.local");
  say("(Or install the GitHub CLI, run `gh auth login`, and run setup again.)");
}
