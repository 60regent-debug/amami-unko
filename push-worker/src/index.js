// 奄美 運航情報 — 通知の仕組み（Cloudflare Worker）
// ・/subscribe   通知の届け先（ブラウザの購読情報）と、通知してほしい便を保存
// ・/unsubscribe 届け先を削除
// ・/test        その届け先にテスト通知を送る
// ・15分おき     公開中の status.json を読み、前回から変わった便を、その便を選んだ人に通知
import { buildPushPayload } from "@block65/webcrypto-web-push";
import PostalMime from "postal-mime";

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

// ── 奄美空港（公式「本日の運航状況」）──
const AIRPORT_URL = "https://amami-airport.co.jp/flight/today";
const AIRLINES = { jal_logo: ["JAL", "JAL・JAC"], peach_logo: ["MM", "Peach"], skymark_logo: ["BC", "スカイマーク"], ana_logo: ["NH", "ANA"] };

function flightLevel(status, changed) {
  if (/欠航/.test(status)) return "cancel";
  if (changed || /遅|変更|未定|調査|条件|引き返|代替/.test(status)) return "caution";
  return "normal";
}

function parseAirport(page) {
  const out = {};
  for (const [kind, id] of [["arrivals", "arrivals-japanese-full"], ["departures", "departures-japanese-full"]]) {
    const m = page.match(new RegExp(`<tbody id="${id}">([\\s\\S]*?)</tbody>`));
    out[kind] = [];
    if (!m) continue;
    for (const row of m[1].split(/<tr[^>]*>/).slice(1)) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
      if (cells.length < 6) continue;
      const logo = (cells[3].match(/icon\/([a-z_]+)\.png/) || [])[1] || "";
      const [code, name] = AIRLINES[logo] || ["", "その他"];
      const no = clean(cells[4]), status = clean(cells[5]) || "—", changed = clean(cells[1]);
      out[kind].push({
        id: `air-${kind === "arrivals" ? "a" : "d"}-${code}${no}`,
        time: clean(cells[0]), changed, place: clean(cells[2]), airline: name, flight: (code ? code + " " : "") + no,
        status, level: flightLevel(status, changed),
      });
    }
  }
  return out;
}

// ── 瀬戸内町営（防災情報メール → Gmailの転送 → ここ）──
const TOWN_SENDER = /@raiden3\.ktaiwork\.jp>?$/i;
const SHIP_WORDS = /かけろま|せとなみ|定期船|町営船|フェリー/;

function setouchiLevel(t) {
  if (/欠航|運休/.test(t)) return "cancel";
  if (/条件付|見合わせ|一部|変更|遅れ|抜港/.test(t)) return "caution";
  if (/通常|平常|運航します|運航いたします|運航致します|再開/.test(t)) return "normal";
  return "caution";
}

async function setouchiItem(env) {
  const base = { id: "setouchi", operator: "瀬戸内町（フェリーかけろま・せとなみ）", ship: "", ports: ["古仁屋港"], route: "古仁屋 - 瀬相・生間 ほか", url: SETOUCHI_X_URL };
  const rec = env ? JSON.parse((await env.SUBS.get("setouchi")) || "null") : null;
  const today = jstNow().slice(0, 10);
  if (rec && rec.received.slice(0, 10) === today) {
    return { ...base, label: rec.label, level: rec.level, headline: rec.headline, updated: `${rec.received.slice(5, 7)}/${rec.received.slice(8, 10)} ${rec.received.slice(11, 16)} 町の防災メール` };
  }
  return { ...base, label: "本日の配信なし", level: "unknown", headline: "町の防災メールで今日の運航のお知らせはまだありません。公式Xもご確認ください", updated: rec ? `最後の配信 ${rec.received.slice(5, 7)}/${rec.received.slice(8, 10)}` : "" };
}

async function handleEmail(message, env) {
  const mail = await PostalMime.parse(message.raw);
  const from = (mail.from && mail.from.address) || message.from || "";
  // 差出人欄は偽装できるので、配送経路（エンベロープ送信元）も確かめる：町から直接か、Gmailの正式な転送（+caf_=）だけ
  const envelope = message.from || "";
  const viaTrusted = /@raiden3\.ktaiwork\.jp$/i.test(envelope) || /\+caf_=unko=tatsunoko-amami\.com@gmail\.com$/i.test(envelope);
  const fromTown = TOWN_SENDER.test(from) && viaTrusted;
  const fromGoogle = /@google\.com$/i.test(from);   // Gmailの転送確認メール
  if (!fromTown && !fromGoogle) { message.setReject("not accepted"); return; }
  const text = (mail.text || (mail.html || "").replace(/<[^>]+>/g, " ")).normalize("NFKC");
  const received = jstNow();
  // 確認用に30日だけ保存（中身を後で確かめるため）
  await env.SUBS.put(`mail:${Date.now()}`, JSON.stringify({ from, subject: mail.subject || "", text: text.slice(0, 4000), received }), { expirationTtl: 30 * 24 * 3600 });
  if (!fromTown) return;
  const body = `${mail.subject || ""}\n${text}`;
  if (!SHIP_WORDS.test(body)) return;   // 防災メールのうち定期船以外は無視
  const lines = body.split(/\n/).map((l) => l.trim()).filter((l) => l && SHIP_WORDS.test(l));
  const headline = (lines.slice(0, 2).join(" ") || (mail.subject || "")).slice(0, 120);
  const level = setouchiLevel(body);
  const label = { cancel: "欠航あり", caution: "注意", normal: "運航" }[level];
  await env.SUBS.put("setouchi", JSON.stringify({ level, label, headline, received }));
}

// ── 天気（気象庁の公開データ：奄美地方の予報＋アメダス名瀬の観測） ──
const JMA_FORECAST_URL = "https://www.jma.go.jp/bosai/forecast/data/forecast/460100.json";
const JMA_AMEDAS = "https://www.jma.go.jp/bosai/amedas/data";
const JMA_PAGE_URL = "https://www.jma.go.jp/bosai/forecast/#area_type=offices&area_code=460100";
const DIR16 = ["静穏", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東", "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西", "北"];
const jmaText = (t) => (t || "").normalize("NFKC").replace(/ただし.*$/, "").replace(/\s+/g, "")
  .replace(/後/g, " のち ").replace(/メートル/g, "m").replace(/うねりを伴う/, "（うねりあり）").trim();
const skyOf = (code) => ({ 1: "sun", 2: "cloud", 3: "rain", 4: "snow" })[String(code || "")[0]] || "cloud";

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchWeather() {
  const w = { url: JMA_PAGE_URL };
  try {
    const [short] = await getJson(JMA_FORECAST_URL);
    const area = (ts) => ts.areas.find(a => a.area.code === "460040");
    const [days, pops, temps] = short.timeSeries;
    const d = area(days);
    const today = days.timeDefines[0].slice(0, 10);
    w.days = days.timeDefines.slice(0, 2).map((t, i) => ({
      date: t.slice(0, 10), sky: skyOf(d.weatherCodes[i]),
      weather: jmaText(d.weathers[i]), wind: jmaText(d.winds[i]), wave: jmaText(d.waves[i]),
    }));
    // 今日のこれからの降水確率（いちばん高い値）
    const p = area(pops).pops.filter((v, i) => v !== "" && pops.timeDefines[i].startsWith(today)).map(Number);
    if (p.length) w.days[0].pop = Math.max(...p);
    // 名瀬の気温（09時=最高、00時=最低）
    const naze = temps.areas.find(a => a.area.code === "88837");
    if (naze) temps.timeDefines.forEach((t, i) => {
      const day = w.days.find(x => x.date === t.slice(0, 10));
      if (day && naze.temps[i] !== "") day[t.slice(11, 13) === "09" ? "max" : "min"] = Number(naze.temps[i]);
    });
    if (w.days[0].min !== undefined && w.days[0].min === w.days[0].max) delete w.days[0].min;
    w.reported = short.reportDatetime;
  } catch (e) { w.forecastError = e.message; }
  try {
    const latest = (await (await fetch(`${JMA_AMEDAS}/latest_time.txt`, { headers: { "User-Agent": UA } })).text()).trim();
    const block = String(Math.floor(Number(latest.slice(11, 13)) / 3) * 3).padStart(2, "0");
    const obs = await getJson(`${JMA_AMEDAS}/point/88837/${latest.slice(0, 10).replace(/-/g, "")}_${block}.json`);
    const k = Object.keys(obs).sort().pop();
    const o = obs[k], v = (x) => (o[x] && o[x][1] === 0 ? o[x][0] : null);
    w.now = {
      time: `${k.slice(8, 10)}:${k.slice(10, 12)}`, temp: v("temp"), wind: v("wind"),
      windDir: DIR16[v("windDirection")] || null, rain1h: v("precipitation1h"),
    };
  } catch (e) { w.nowError = e.message; }
  try { w.typhoons = await fetchTyphoons(); } catch (e) { w.typhoonError = e.message; }
  return w;
}

// ── 台風（気象庁：発表中の台風と5日先までの予報） ──
const JMA_TYPHOON = "https://www.jma.go.jp/bosai/typhoon/data";
const AMAMI = [28.377, 129.494]; // 名瀬
function kmFromAmami([lat, lon]) {
  const r = (x) => x * Math.PI / 180;
  const a = Math.sin(r(lat - AMAMI[0]) / 2) ** 2 + Math.cos(r(AMAMI[0])) * Math.cos(r(lat)) * Math.sin(r(lon - AMAMI[1]) / 2) ** 2;
  return Math.round(6371 * 2 * Math.asin(Math.sqrt(a)));
}

async function fetchTyphoons() {
  const list = await getJson(`${JMA_TYPHOON}/targetTc.json`);
  const out = [];
  for (const tc of list) {
    if (!/^TC\d+$/.test(tc.tropicalCyclone)) continue;
    const spec = await getJson(`${JMA_TYPHOON}/${tc.tropicalCyclone}/specifications.json`);
    const title = spec.find(x => x.part === "title") || {};
    const pts = spec.filter(x => x.position && x.validtime).map(x => ({
      time: x.validtime.JST.slice(0, 16), hours: x.advancedHours || 0, km: kmFromAmami(x.position.deg),
      // 暴風域（予報円の分も足す）が奄美まで届くか
      reach: (x.stormWarning?.[0]?.range?.km || 0) + (x.probabilityCircleRadius?.km || 0),
      location: x.location || "", intensity: x.intensity && x.intensity !== "-" ? x.intensity : "",
      pressure: x.pressure || "",
    }));
    if (!pts.length) continue;
    const now = pts[0], near = pts.reduce((a, b) => (b.km < a.km ? b : a));
    const level = pts.some(p => p.reach && p.km <= p.reach) ? "storm" : near.km <= 800 ? "near" : near.km <= 1500 ? "watch" : "far";
    const num = String(tc.typhoonNumber || "").slice(-2).replace(/^0/, "");
    out.push({
      name: num ? `台風${num}号` : (title.category?.jp || "熱帯低気圧"), nickname: title.name?.jp || "",
      level, now, near, issued: title.issue?.JST?.slice(0, 16) || "",
    });
  }
  return out;
}

function jstNow() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

async function scrapeAll(env) {
  const items = [], errors = [];
  for (const [name, url, parser] of [["マルエーフェリー・奄美海運", ALINE_URL, parseAline], ["マリックスライン", MARIX_URL, parseMarix]]) {
    try {
      const got = parser(await getPage(url));
      if (!got.length) errors.push(`${name}: 読み取れた便が0件（ページの形が変わった可能性）`);
      items.push(...got);
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  let flights = { arrivals: [], departures: [], url: AIRPORT_URL };
  try {
    flights = { ...parseAirport(await getPage(AIRPORT_URL)), url: AIRPORT_URL };
    if (!flights.arrivals.length && !flights.departures.length) errors.push("奄美空港: 読み取れた便が0件（ページの形が変わった可能性）");
  } catch (e) { errors.push(`奄美空港: ${e.message}`); }
  items.push(await setouchiItem(env));
  // 天気は取れなくても運航情報の「取得できませんでした」には含めない
  const weather = await fetchWeather();
  return { generated_at: jstNow(), items, flights, weather, errors };
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

  if (url.pathname === "/stats" && req.method === "GET") return json(req, JSON.parse((await env.SUBS.get("stats")) || "{}"));

  if (req.method !== "POST") return json(req, { error: "not found" }, 404);
  let body;
  try { body = await req.json(); } catch { return json(req, { error: "bad json" }, 400); }

  // 利用者数：端末ごとのランダムな番号だけを受け取り、最後に開いた日を7日間だけ覚える（個人情報は受け取らない）
  if (url.pathname === "/ping") {
    if (typeof body.u !== "string" || !/^[0-9a-f]{32}$/.test(body.u)) return json(req, { error: "bad id" }, 400);
    // 書き込み枠（無料で1日1,000回）を使い切られて運航情報の更新が止まらないよう、同じ回線からの回数を制限
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    if (env.PING_LIMIT && !(await env.PING_LIMIT.limit({ key: ip })).success) return json(req, { error: "too many" }, 429);
    const today = jstNow().slice(0, 10), key = `seen:${body.u}`;
    if ((await env.SUBS.get(key)) !== today) await env.SUBS.put(key, today, { expirationTtl: 7 * 24 * 3600 });
    return json(req, { ok: true });
  }

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

// 直近7日間に開いた端末の数（1時間に1回だけ数える）
async function countActive(env) {
  if (new Date().getUTCMinutes() >= 15) return;
  let n = 0, cursor, pages = 0;
  do {
    const r = await env.SUBS.list({ prefix: "seen:", cursor });
    n += r.keys.length; cursor = r.list_complete ? null : r.cursor;
  } while (cursor && ++pages < 5);   // 5,000台まで数えれば十分（それ以上は「5,000以上」）
  await env.SUBS.put("stats", JSON.stringify({ active7d: n, counted_at: jstNow() }));
}

async function checkAndNotify(env) {
  const data = await scrapeAll(env);
  // 全社とも読めなかったときは、前回の情報を残して通知もしない
  const got = data.items.filter((i) => i.level !== "unknown").length;
  if (!got) { console.log("読み取り失敗", data.errors); return; }
  await env.SUBS.put("status", JSON.stringify(data));
  // 利用者数は運航情報を保存したあとに（失敗しても通知の処理は続ける）
  try { await countActive(env); } catch (e) { console.log("利用者数を数えられません", e.message); }

  // 便（通知対象）ごとの「状態の指紋」と、通知文
  const now = {}, text = {};
  const quiet = new Set();   // 今が「不明・配信なし」の便は、変化しても通知しない
  for (const it of data.items || []) {
    if (it.level === "unknown" && it.id !== "setouchi") continue;
    if (it.level === "unknown") quiet.add(keyOf(it));
    const k = keyOf(it);
    now[k] = (now[k] ? now[k] + "|" : "") + [it.level, it.label, it.headline].join("/");
    const name = it.ship || it.operator;
    text[k] = (text[k] ? text[k] + "\n" : "") + `${name}：${it.label}${it.headline ? "（" + it.headline + "）" : ""}`;
  }

  for (const f of [...(data.flights?.arrivals || []), ...(data.flights?.departures || [])]) {
    now[f.id] = [f.level, f.level === "normal" ? "" : f.status, f.changed].join("/");
    const dir = f.id.startsWith("air-a") ? `${f.place}発` : `${f.place}行き`;
    text[f.id] = `✈️ ${f.airline} ${f.flight}（${f.time} ${dir}）：${f.level === "normal" ? "通常どおり" : f.status}${f.changed ? `・変更後 ${f.changed}` : ""}`;
  }

  const prev = JSON.parse((await env.SUBS.get("state")) || "null");
  const changed = prev ? Object.keys(now).filter((k) => !quiet.has(k) && (k in prev || k === "setouchi") && prev[k] !== now[k]) : [];
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
  email: (message, env) => handleEmail(message, env),
};
