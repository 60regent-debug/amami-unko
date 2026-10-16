// 奄美 運航情報 — 通知の仕組み（Cloudflare Worker）
// ・/subscribe   通知の届け先（ブラウザの購読情報）と、通知してほしい便を保存
// ・/unsubscribe 届け先を削除
// ・/test        その届け先にテスト通知を送る
// ・15分おき     公開中の status.json を読み、前回から変わった便を、その便を選んだ人に通知
import { buildPushPayload } from "@block65/webcrypto-web-push";

const APP_URL = "https://60regent-debug.github.io/amami-unko/";
const ALLOWED_ORIGINS = ["https://60regent-debug.github.io", "http://127.0.0.1:8765"];

// ── 各社ページの読み取り（fetch_status.py と同じ方針：区分＋短い見出し＋公式リンクのみ） ──
const ALINE_URL = "https://www.aline-ferry.com/status";
const MARIX_URL = "https://marixline.com/service/";
const SETOUCHI_X_URL = "https://x.com/st_liner_info";
const UA = "Mozilla/5.0 (compatible; AmamiUnkoPrototype/0.2)";
const ALINE_SHIPS = { "フェリーあけぼの": "マルエーフェリー", "フェリー波之上": "マルエーフェリー", "フェリーあまみ": "奄美海運", "フェリーきかい": "奄美海運" };
const SHIP_PORTS = { "フェリーあけぼの": ["名瀬港"], "フェリー波之上": ["名瀬港"], "フェリーあまみ": ["名瀬港", "古仁屋港"], "フェリーきかい": ["名瀬港", "古仁屋港"] };

const unescapeHtml = (t) => t
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");
const clean = (t) => unescapeHtml(t.replace(/<br\s*\/?>/g, " ").replace(/<[^>]+>/g, "")).normalize("NFKC").replace(/\s+/g, " ").trim();
const levelOf = (label) => /欠航|運休/.test(label) ? "cancel" : /通常/.test(label) ? "normal" : "caution";

async function getPage(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}

function parseAline(page) {
  const items = [];
  for (const block of page.split('<div class="status-archive">').slice(1)) {
    const m = block.match(/<h3>\s*<span>\s*([^<]+?)\s*<\/span>\s*<span class="route-name">\s*([^<]+?)\s*<\/span>/);
    if (!m) continue;
    const ship = m[1].trim();
    if (!ALINE_SHIPS[ship]) continue;
    const tags = [...block.matchAll(/<span class="tag-[a-z]+">([^<]+)<\/span>/g)].map((x) => x[1].trim());
    const label = tags.join(" / ") || "不明";
    const h4 = block.match(/<h4>([\s\S]*?)<\/h4>/);
    const upd = block.match(/<time datetime="([^"]+)"/);
    items.push({
      id: "aline-" + ship, operator: ALINE_SHIPS[ship], ship, ports: SHIP_PORTS[ship] || ["名瀬港"],
      route: clean(m[2]), label, level: levelOf(label),
      headline: h4 ? clean(h4[1]).split(/\s*■\s*/).filter(Boolean).join("\n") : "", updated: upd ? upd[1] : "", url: ALINE_URL,
    });
  }
  return items;
}

// 読み取ったリンクは marixline.com の https だけ通す（それ以外は一覧ページ）
function safeMarixUrl(href) {
  try {
    const u = new URL(unescapeHtml(href), MARIX_URL);
    if (u.protocol === "https:" && (u.hostname === "marixline.com" || u.hostname.endsWith(".marixline.com"))) return u.href;
  } catch {}
  return MARIX_URL;
}

function parseMarix(page) {
  const items = [];
  const sec = page.match(/section__latest_status">([\s\S]*?)<\/section>/);
  if (sec) {
    const dirs = [["鹿児島 - 名瀬 - 那覇（下り）", "down_stream_services", "marix-down"], ["那覇 - 名瀬 - 鹿児島（上り）", "up_stream_services", "marix-up"]];
    for (const [route, cls, id] of dirs) {
      const start = sec[1].indexOf(`<div class="${cls}">`);
      if (start < 0) continue;
      const others = dirs.map((d) => sec[1].indexOf(`<div class="${d[1]}">`, start + 1)).filter((i) => i > start);
      const part = sec[1].slice(start, others.length ? Math.min(...others) : undefined);
      for (const a of part.matchAll(/<a class="status_single[^"]*" href="([^"]+)">([\s\S]*?)<\/a>/g)) {
        const exp = a[2].match(/<p class="exp">([\s\S]*?)<\/p>/);
        const label = exp ? clean(exp[1]) : "不明";
        const ports = [...a[2].matchAll(/<div class="port_information[^"]*">([\s\S]*?)<\/div>/g)]
          .map((x) => clean(x[1]).replace(/\d{4}年(\d{1,2})月(\d{1,2})日/g, "$1/$2"));
        items.push({ id, operator: "マリックスライン", ship: "", ports: ["名瀬港"], route, label, level: levelOf(label), headline: ports.join(" → "), updated: "", url: safeMarixUrl(a[1]) });
      }
    }
  }
  if (!items.length) items.push({ id: "marix-none", operator: "マリックスライン", ship: "", ports: ["名瀬港"], route: "鹿児島 - 奄美群島 - 那覇", label: "掲載なし", level: "unknown", headline: "最新の運航状況に掲載されている便がありません", updated: "", url: MARIX_URL });
  return items;
}

function jstNow() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

async function scrapeAll() {
  const items = [], errors = [];
  for (const [name, url, parser] of [["マルエーフェリー・奄美海運", ALINE_URL, parseAline], ["マリックスライン", MARIX_URL, parseMarix]]) {
    try {
      const got = parser(await getPage(url));
      if (!got.length) errors.push(`${name}: 読み取れた便が0件（ページの形が変わった可能性）`);
      items.push(...got);
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  items.push({ id: "setouchi", operator: "瀬戸内町（フェリーかけろま・せとなみ）", ship: "", ports: ["古仁屋港"], route: "古仁屋 - 瀬相・生間 ほか", label: "公式Xで確認", level: "unknown", headline: "自動取得は準備中（町の防災情報メールから読み取る予定）", updated: "", url: SETOUCHI_X_URL });
  return { generated_at: jstNow(), items, errors };
}

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

// 届け先は主要な通知サービスだけに限る（任意のURLへ中継されないように）
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

function validSubscription(s) {
  if (!s || typeof s.endpoint !== "string" || !s.keys || typeof s.keys.p256dh !== "string" || typeof s.keys.auth !== "string") return false;
  try {
    const u = new URL(s.endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

// 既存の登録を変える・消すときは、登録時と同じ鍵を持っていることを確かめる
async function ownsRecord(env, key, subscription) {
  const rec = JSON.parse((await env.SUBS.get(key)) || "null");
  if (!rec) return { exists: false, ok: true };
  return { exists: true, ok: rec.subscription.keys.auth === subscription.keys.auth && rec.subscription.keys.p256dh === subscription.keys.p256dh };
}

async function handle(req, env) {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  if (url.pathname === "/vapid" && req.method === "GET") return json(req, { publicKey: env.VAPID_PUBLIC_KEY });
  if (url.pathname === "/status.json" && req.method === "GET") {
    const body = (await env.SUBS.get("status")) || JSON.stringify({ generated_at: "", items: [], errors: ["まだ情報がありません"] });
    return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60", ...cors(req) } });
  }

  if (req.method !== "POST") return json(req, { error: "not found" }, 404);
  let body;
  try { body = await req.json(); } catch { return json(req, { error: "bad json" }, 400); }

  if (url.pathname === "/subscribe") {
    if (!validSubscription(body.subscription)) return json(req, { error: "bad subscription" }, 400);
    const targets = Array.isArray(body.targets) ? body.targets.filter((t) => typeof t === "string").slice(0, 30) : [];
    const key = await subKey(body.subscription.endpoint);
    const own = await ownsRecord(env, key, body.subscription);
    if (!own.ok) return json(req, { error: "forbidden" }, 403);
    if (!targets.length) { if (own.exists) await env.SUBS.delete(key); return json(req, { ok: true, targets: [] }); }
    await env.SUBS.put(key, JSON.stringify({ subscription: body.subscription, targets, updated: new Date().toISOString() }));
    return json(req, { ok: true, targets });
  }

  if (url.pathname === "/unsubscribe") {
    if (!validSubscription(body.subscription)) return json(req, { error: "bad subscription" }, 400);
    const key = await subKey(body.subscription.endpoint);
    const own = await ownsRecord(env, key, body.subscription);
    if (!own.ok) return json(req, { error: "forbidden" }, 403);
    if (own.exists) await env.SUBS.delete(key);
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
  const data = await scrapeAll();
  // 全社とも読めなかったときは、前回の情報を残して通知もしない
  const got = data.items.filter((i) => i.level !== "unknown").length;
  if (!got) { console.log("読み取り失敗", data.errors); return; }
  await env.SUBS.put("status", JSON.stringify(data));

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
