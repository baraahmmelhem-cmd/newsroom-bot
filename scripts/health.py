#!/usr/bin/env python3
"""Morning source check for Mr_Amwal (runs once a day, PC off OK).

1. Every news feed the newsroom uses: does it answer, how many items, how fresh is the newest one.
2. Live crypto prices from three independent sources (CoinGecko, Coinbase, Kraken): they must agree.
3. Writes feeds_status.json (dead feeds are skipped by run.py) and sends a short report to the
   owner's own WhatsApp number (not the group).
"""
import json
import os
import sys
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
import requests  # noqa: E402
import run  # noqa: E402

STATUS = Path(__file__).resolve().parent.parent / "feeds_status.json"
UA = {"User-Agent": "Mozilla/5.0 newsroom-bot health"}


def check_feed(name, url):
    try:
        r = requests.get(url, timeout=30, headers=UA)
        r.raise_for_status()
        root = ET.fromstring(r.content)
        items = list(root.iter("item"))
        newest = None
        for i in items:
            try:
                d = parsedate_to_datetime(i.findtext("pubDate") or "")
                if d.tzinfo is None:
                    d = d.replace(tzinfo=timezone.utc)
                newest = d if newest is None or d > newest else newest
            except Exception:
                continue
        age_h = (datetime.now(timezone.utc) - newest).total_seconds() / 3600 if newest else None
        ok = bool(items) and age_h is not None and age_h <= 24
        return {"ok": ok, "items": len(items), "age_h": None if age_h is None else round(age_h, 1),
                "why": "" if ok else ("no dated items" if age_h is None else f"newest item {age_h:.0f}h old")}
    except Exception as e:
        return {"ok": False, "items": 0, "age_h": None, "why": type(e).__name__}


def prices():
    out = {}
    try:
        j = requests.get("https://api.coingecko.com/api/v3/simple/price",
                         params={"ids": "bitcoin,ethereum", "vs_currencies": "usd"}, timeout=20, headers=UA).json()
        out["CoinGecko"] = {"BTC": j["bitcoin"]["usd"], "ETH": j["ethereum"]["usd"]}
    except Exception as e:
        print("CoinGecko failed:", e)
    try:
        cb = {}
        for s in ("BTC", "ETH"):
            cb[s] = float(requests.get(f"https://api.coinbase.com/v2/prices/{s}-USD/spot", timeout=20).json()["data"]["amount"])
        out["Coinbase"] = cb
    except Exception as e:
        print("Coinbase failed:", e)
    try:
        j = requests.get("https://api.kraken.com/0/public/Ticker", params={"pair": "XBTUSD,ETHUSD"}, timeout=20).json()["result"]
        kr = {}
        for k, v in j.items():
            kr["BTC" if "XBT" in k else "ETH"] = float(v["c"][0])
        out["Kraken"] = kr
    except Exception as e:
        print("Kraken failed:", e)
    return out


def send_owner(text):
    token, phone = os.environ.get("GREENAPI_API_TOKEN"), "".join(c for c in os.environ.get("WHATSAPP_PHONE", "") if c.isdigit())
    if not token or not phone:
        print("No GREENAPI_API_TOKEN / WHATSAPP_PHONE; report not sent.")
        return
    for attempt in range(3):
        try:
            r = requests.post(f"{run.GREEN_HOST}/waInstance{run.GREEN_ID}/sendMessage/{token}",
                              json={"chatId": phone + "@c.us", "message": text}, timeout=30)
            if r.ok and "idMessage" in r.text:
                print("Report sent to the owner.")
                return
            print("Send failed: HTTP", r.status_code)
        except Exception as e:
            print("Send error:", type(e).__name__)
        time.sleep(5 * (attempt + 1))


def main():
    feeds = {name: check_feed(name, url) for name, url in run.FEEDS.items()}
    for n, f in feeds.items():
        print(f"{'OK ' if f['ok'] else 'BAD'} {n}: {f['items']} items, newest {f['age_h']}h {f['why']}")
    dead = sorted(n for n, f in feeds.items() if not f["ok"])
    STATUS.write_text(json.dumps({"checked": int(time.time()), "dead": dead, "feeds": feeds},
                                 ensure_ascii=False, indent=2), encoding="utf-8")

    px = prices()
    lines = ["🔎 *فحص المصادر الصباحي*",
             f"مصادر الأخبار: {len(feeds) - len(dead)} من {len(feeds)} تعمل وأخبارها حديثة."]
    if dead:
        lines.append("متوقفة أو قديمة (تُستبعد تلقائيًا): " + "، ".join(dead))
    for sym in ("BTC", "ETH"):
        vals = {src: v[sym] for src, v in px.items() if sym in v}
        if len(vals) >= 2:
            lo, hi = min(vals.values()), max(vals.values())
            spread = (hi - lo) / lo * 100
            mark = "✅" if spread <= 1 else "⚠️"
            lines.append(f"{mark} {sym}: " + " · ".join(f"{s} {v:,.0f}$" for s, v in vals.items())
                         + ("" if spread <= 1 else f" (فرق {spread:.1f}%)"))
        else:
            lines.append(f"⚠️ {sym}: مصدر سعر واحد فقط يعمل ({', '.join(vals) or 'لا شيء'})")
    text = "\n".join(lines)
    print(text)
    send_owner(text)


if __name__ == "__main__":
    main()
