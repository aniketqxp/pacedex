// Fetches Codex usage from GitHub's network (chatgpt.com blocks Cloudflare
// Workers) and hands the raw response back to the Worker. Prints no secrets.
const base = process.env.WORKER_URL;
const auth = { Authorization: `Bearer ${process.env.RELAY_KEY}` };

const { request, reason, health = [] } = await fetch(`${base}/api/relay/codex-token`, { headers: auth }).then((r) => {
  if (!r.ok) throw new Error(`Worker token endpoint: HTTP ${r.status}`);
  return r.json();
});
// A failed run makes GitHub email the repo owner, so problems the Worker
// reports fail the run even when this relay's own fetch is fine.
for (const p of health) console.log(`::error::${p}`);
const healthy = health.length === 0;

if (!request) {
  console.log(`Skipping: ${reason || "Codex not linked"}`);
  process.exit(healthy ? 0 : 1);
}

const res = await fetch(request.url, { headers: request.headers });
const body = await res.text();
console.log(`chatgpt.com usage: HTTP ${res.status}`);

const post = await fetch(`${base}/api/relay/codex-usage`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ status: res.status, body }),
});
console.log(`Worker accepted: HTTP ${post.status}`);
if (!post.ok || res.status !== 200 || !healthy) process.exit(1);
