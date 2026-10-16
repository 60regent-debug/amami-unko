// 奄美 運航情報 — 通知の仕組み（Cloudflare Worker）
// ・/subscribe   通知の届け先（ブラウザの購読情報）と、通知してほしい便を保存
// ・/unsubscribe 届け先を削除
// ・/test        その届け先にテスト通知を送る
// ・15分おき     公開中の status.json を読み、前回から変わった便を、その便を選んだ人に通知
import { buildPushPayload } from "@block65/webcrypto-web-push";

const STATUS_URL = "https://60regent-debug.github.io/amami-unko/status.json";
const APP_URL = "https://60regent-debug.github.io/amami-unko/";
const ALLOWED_ORIGINS = ["https://60regent-debug.github.io", "http://127.0.0.1:8765"];

// マリックスは上り・下りをまとめて1つの通知対象にする
const keyOf = (it) => (it.id || "").startsWith("marix") ? "marix" : it.id;

function cors(req) {
  const origin = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

const json = (req, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(req) } });

async function subKey(endpoint) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return "sub:" + [...new Uint8Array(hash)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function vapid(env) {
  return { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
}

// 1件送る。届け先が無効（解除済み等）なら false
async function send(env, subscription, message) {
  const payload = await buildPushPayload(
    { data: JSON.stringify(message), options: { ttl: 6 * 3600 } },
    subscription,
    vapid(env),
  );
  const res = await fetch(subscription.endpoint, payload);
  if (res.status === 404 || res.status === 410) return false;
  if (!res.ok) console.log("push失敗", res.status, await res.text());
  return true;
}

function validSubscription(s) {
  return s && typeof s.endpoint === "string" && s.endpoint.startsWith("https://") && s.keys && s.keys.p256dh && s.keys.auth;
}

async function handle(req, env) {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  if (url.pathname === "/vapid" && req.method === "GET") return json(req, { publicKey: env.VAPID_PUBLIC_KEY });

  if (req.method !== "POST") return json(req, { error: "not found" }, 404);
  let body;
  try { body = await req.json(); } catch { return json(req, { error: "bad json" }, 400); }

  if (url.pathname === "/subscribe") {
    if (!validSubscription(body.subscription)) return json(req, { error: "bad subscription" }, 400);
    const targets = Array.isArray(body.targets) ? body.targets.filter((t) => typeof t === "string").slice(0, 30) : [];
    const key = await subKey(body.subscription.endpoint);
    if (!targets.length) { await env.SUBS.delete(key); return json(req, { ok: true, targets: [] }); }
    await env.SUBS.put(key, JSON.stringify({ subscription: body.subscription, targets, updated: new Date().toISOString() }));
    return json(req, { ok: true, targets });
  }

  if (url.pathname === "/unsubscribe") {
    if (typeof body.endpoint !== "string") return json(req, { error: "bad endpoint" }, 400);
    await env.SUBS.delete(await subKey(body.endpoint));
    return json(req, { ok: true });
  }

  if (url.pathname === "/test") {
    if (!validSubscription(body.subscription)) return json(req, { error: "bad subscription" }, 400);
    const ok = await send(env, body.subscription, {
      title: "奄美 運航情報",
      body: "テスト通知です。選んだ便の運航状況が変わると、このようにお知らせします。",
      url: APP_URL,
    });
    return json(req, { ok });
  }

  return json(req, { error: "not found" }, 404);
}

async function checkAndNotify(env) {
  const res = await fetch(STATUS_URL + "?t=" + Date.now(), { cf: { cacheTtl: 0 } });
  if (!res.ok) { console.log("status.json取得失敗", res.status); return; }
  const data = await res.json();

  // 便（通知対象）ごとの「状態の指紋」と、通知文
  const now = {}, text = {};
  for (const it of data.items || []) {
    if (it.level === "unknown") continue;
    const k = keyOf(it);
    now[k] = (now[k] ? now[k] + "|" : "") + [it.level, it.label, it.headline].join("/");
    const name = it.ship || it.operator;
    text[k] = (text[k] ? text[k] + "\n" : "") + `${name}：${it.label}${it.headline ? "（" + it.headline + "）" : ""}`;
  }

  const prev = JSON.parse((await env.SUBS.get("state")) || "null");
  const changed = prev ? Object.keys(now).filter((k) => prev[k] !== now[k]) : [];
  if (JSON.stringify(prev) !== JSON.stringify(now)) await env.SUBS.put("state", JSON.stringify(now));
  if (!changed.length) return;

  let cursor;
  do {
    const list = await env.SUBS.list({ prefix: "sub:", cursor });
    for (const { name } of list.keys) {
      const rec = JSON.parse((await env.SUBS.get(name)) || "null");
      if (!rec) continue;
      const hits = changed.filter((k) => rec.targets.includes(k));
      if (!hits.length) continue;
      const ok = await send(env, rec.subscription, {
        title: "運航状況が変わりました",
        body: hits.map((k) => text[k]).join("\n"),
        url: APP_URL,
      });
      if (!ok) await env.SUBS.delete(name);
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
}

export default {
  fetch: (req, env) => handle(req, env),
  scheduled: (event, env, ctx) => ctx.waitUntil(checkAndNotify(env)),
};
