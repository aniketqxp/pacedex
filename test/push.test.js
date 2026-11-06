import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptPayload, b64url, unb64url } from "../src/push.js";

// RFC 8291 §5: the worked example, byte for byte.
const V = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("aes128gcm encryption matches the RFC 8291 test vector", async () => {
  const pub = unb64url(V.asPublic);
  const jwk = { kty: "EC", crv: "P-256", d: V.asPrivate, x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33)) };
  const ecdh = { name: "ECDH", namedCurve: "P-256" };
  const asKeys = {
    privateKey: await crypto.subtle.importKey("jwk", jwk, ecdh, false, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", pub, ecdh, true, []),
  };
  const out = await encryptPayload(new TextEncoder().encode(V.plaintext), V.uaPublic, V.auth, { asKeys, salt: unb64url(V.salt) });
  assert.equal(b64url(out), V.body);
});

test("rejects malformed subscription keys", async () => {
  await assert.rejects(encryptPayload(new Uint8Array(1), "AAAA", V.auth), /bad subscription keys/);
});
