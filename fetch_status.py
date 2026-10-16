#!/usr/bin/env python3
"""奄美の船の運航状況を各社の公式ページから読み取り、status.json に書き出す（試作版）。

方針：各社の文章はそのまま転載せず、「通常／注意／欠航」の区分＋短い見出し＋公式リンクだけを出す。
標準ライブラリのみで動く。
"""
import html
import json
import re
import sys
import unicodedata
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

JST = timezone(timedelta(hours=9))
UA = "Mozilla/5.0 (Macintosh) AmamiUnkoPrototype/0.1"
OUT = Path(__file__).with_name("status.json")

ALINE_URL = "https://www.aline-ferry.com/status"
MARIX_URL = "https://marixline.com/service/"
SETOUCHI_X_URL = "https://x.com/st_liner_info"
SETOUCHI_PAGE_URL = "https://www.town.setouchi.lg.jp/senpaku/cho/unkojokyo.html"

# マルエーのページには貨物船も載っているので、旅客船だけを拾う
ALINE_PASSENGER_SHIPS = {
    "フェリーあけぼの": "マルエーフェリー",
    "フェリー波之上": "マルエーフェリー",
    "フェリーあまみ": "奄美海運",
    "フェリーきかい": "奄美海運",
}


# 奄美大島の港ごとに並べるための寄港地（各社の航路図による）
SHIP_PORTS = {
    "フェリーあけぼの": ["名瀬港"],
    "フェリー波之上": ["名瀬港"],
    "フェリーあまみ": ["名瀬港", "古仁屋港"],
    "フェリーきかい": ["名瀬港", "古仁屋港"],
}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", errors="ignore")


def clean(s):
    s = re.sub(r"<br\s*/?>", " ", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = unicodedata.normalize("NFKC", html.unescape(s))  # 全角数字などを半角に
    return re.sub(r"\s+", " ", s).strip()


def level_of(label):
    """表示用の3区分：normal / caution / cancel"""
    if any(k in label for k in ("欠航", "運休")):
        return "cancel"
    if "通常" in label:
        return "normal"
    return "caution"  # 条件付運航・スケジュール変更・航路変更など


def parse_aline(page):
    items = []
    for block in re.split(r'<div class="status-archive">', page)[1:]:
        m = re.search(r'<h3>\s*<span>\s*([^<]+?)\s*</span>\s*<span class="route-name">\s*([^<]+?)\s*</span>', block)
        if not m:
            continue
        ship, route = m.group(1).strip(), clean(m.group(2))
        if ship not in ALINE_PASSENGER_SHIPS:
            continue
        tags = re.findall(r'<span class="tag-[a-z]+">([^<]+)</span>', block)
        label = " / ".join(t.strip() for t in tags) or "不明"
        h4 = re.search(r"<h4>(.*?)</h4>", block, re.S)
        upd = re.search(r'<time datetime="([^"]+)"', block)
        items.append({
            "operator": ALINE_PASSENGER_SHIPS[ship],
            "ship": ship,
            "ports": SHIP_PORTS.get(ship, ["名瀬港"]),
            "route": route,
            "label": label,
            "level": level_of(label),
            "headline": clean(h4.group(1)).lstrip("■") if h4 else "",
            "updated": upd.group(1) if upd else "",
            "url": ALINE_URL,
        })
    return items


def parse_marix(page):
    items = []
    sec = re.search(r'section__latest_status">(.*?)</section>', page, re.S)
    if not sec:
        return items
    for direction, cls in (("鹿児島 - 名瀬 - 那覇（下り）", "down_stream_services"), ("那覇 - 名瀬 - 鹿児島（上り）", "up_stream_services")):
        part = re.search(r'<div class="%s">(.*?)</div>\s*(?=<div class="(?:up|down)_stream_services">|</div>\s*</section>|$)' % cls, sec.group(1) + "</section>", re.S)
        if not part:
            continue
        for a in re.finditer(r'<a class="status_single[^"]*" href="([^"]+)">(.*?)</a>', part.group(1), re.S):
            href, body = a.group(1), a.group(2)
            label = clean((re.search(r'<p class="exp">(.*?)</p>', body, re.S) or [None, ""])[1]) or "不明"
            ports = [clean(x) for x in re.findall(r'<div class="port_information[^"]*">(.*?)</div>', body, re.S)]
            ports = [re.sub(r"\d{4}年(\d{1,2})月(\d{1,2})日", r"\1/\2", x) for x in ports]
            items.append({
                "operator": "マリックスライン",
                "ship": "",
                "ports": ["名瀬港"],
                "route": direction,
                "label": label,
                "level": level_of(label),
                "headline": " → ".join(ports),
                "updated": "",
                "url": href,
            })
    if not items:
        items.append({
            "operator": "マリックスライン", "ship": "", "ports": ["名瀬港"], "route": "鹿児島 - 奄美群島 - 那覇",
            "label": "掲載なし", "level": "unknown",
            "headline": "最新の運航状況に掲載されている便がありません", "updated": "", "url": MARIX_URL,
        })
    return items


def setouchi_placeholder():
    # 町のWebページに運航状況は載っておらず、速報は公式Xと防災メールのみ。自動取得は次の段階で対応
    return [{
        "operator": "瀬戸内町（フェリーかけろま・せとなみ）",
        "ship": "",
        "ports": ["古仁屋港"],
        "route": "古仁屋 - 瀬相・生間 ほか",
        "label": "公式Xで確認",
        "level": "unknown",
        "headline": "自動取得は準備中（町の防災情報メールから読み取る予定）",
        "updated": "",
        "url": SETOUCHI_X_URL,
    }]


def main():
    sources, errors = [], []
    for name, url, parser in (("マルエーフェリー・奄美海運", ALINE_URL, parse_aline), ("マリックスライン", MARIX_URL, parse_marix)):
        try:
            items = parser(fetch(url))
            if not items:
                errors.append(f"{name}: 読み取れた便が0件（ページの形が変わった可能性）")
            sources.extend(items)
        except Exception as e:  # 1社失敗しても他社は出す
            errors.append(f"{name}: {e}")
    sources.extend(setouchi_placeholder())
    data = {
        "generated_at": datetime.now(JST).strftime("%Y-%m-%d %H:%M"),
        "items": sources,
        "errors": errors,
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(sources)}件 → {OUT}")
    for e in errors:
        print("⚠️", e, file=sys.stderr)


if __name__ == "__main__":
    main()
