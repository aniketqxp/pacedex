// Builds the Pacedex mark: one week ring in the app's own language.
// `node brand/build.mjs brand` rewrites brand/icon.svg and brand/logo.svg;
// public/logo.svg is the latter, and the icon PNGs are icon.svg rendered.
import { writeFileSync } from "node:fs";
const out = process.argv[2];
const STOPS = ["#A8482C", "#D97757", "#F2A27F", "#B1A7FF"];
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const colorAt = (t) => {
  const n = STOPS.length - 1, x = Math.min(1, Math.max(0, t)) * n, i = Math.min(n - 1, Math.floor(x)), f = x - i;
  const a = hex(STOPS[i]), b = hex(STOPS[i + 1]);
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
};
export function mark({ cx = 512, cy = 512, R = 318, W = 104, now = 0.64, gap = 0.0085 } = {}) {
  const pt = (t, r) => { const a = 2 * Math.PI * t - Math.PI / 2; return `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`; };
  const arc = (t0, t1, r) => `M${pt(t0, r)} A${r} ${r} 0 ${t1 - t0 > 0.5 ? 1 : 0} 1 ${pt(t1, r)}`;
  let s = "";
  const solid = (a, b) => {
    const n = Math.ceil((b - a) * 400) + 1;
    for (let i = 0; i < n; i++) {
      const t0 = a + ((b - a) * i) / n, t1 = Math.min(b, a + ((b - a) * (i + 1)) / n + 0.0015);
      s += `<path d="${arc(t0, t1, R)}" fill="none" stroke="${colorAt((t0 + t1) / 2 / now)}" stroke-width="${W}"/>`;
    }
  };
  const hollow = (a, b) => {
    const sw = W * 0.06, o = R + W / 2 - sw / 2, i = R - W / 2 + sw / 2;
    s += `<path d="${arc(a, b, o)} L${pt(b, i)} A${i} ${i} 0 0 0 ${pt(a, i)} Z" fill="none" stroke="#5A5A62" stroke-width="${sw}" stroke-linejoin="round"/>`;
  };
  const today = Math.floor(now * 7);
  for (let d = 0; d < 7; d++) {
    const a = d / 7 + gap, b = (d + 1) / 7 - gap;
    if (d < today) solid(a, b);
    else if (d > today) hollow(a, b);
    else { solid(a, now); hollow(now, b); }
  }
  const u = W / 9, cap = (o, w, c) => `<path d="M${pt(now, R - W / 2 - o)} L${pt(now, R + W / 2 + o)}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`;
  return s + cap(1.2 * u, 6.4 * u, "#000") + cap(0.6 * u, 3 * u, "#F5F5F7");
}
const glow = `<defs>
  <radialGradient id="e" cx="0.08" cy="0.98" r="0.75"><stop offset="0" stop-color="#D97757" stop-opacity=".34"/><stop offset="1" stop-color="#D97757" stop-opacity="0"/></radialGradient>
  <radialGradient id="l" cx="0.95" cy="0.04" r="0.75"><stop offset="0" stop-color="#7A9DFF" stop-opacity=".30"/><stop offset="1" stop-color="#7A9DFF" stop-opacity="0"/></radialGradient>
</defs><rect width="1024" height="1024" fill="#000"/><rect width="1024" height="1024" fill="url(#e)"/><rect width="1024" height="1024" fill="url(#l)"/>`;
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${glow}${mark()}</svg>`;
writeFileSync(`${out}/icon.svg`, icon);
// Favicon: rounded, so it sits well in a browser tab.
writeFileSync(`${out}/logo.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><clipPath id="c"><rect width="1024" height="1024" rx="230"/></clipPath><g clip-path="url(#c)">${glow}${mark()}</g></svg>`);
