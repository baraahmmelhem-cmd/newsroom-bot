#!/usr/bin/env python3
"""Hourly Arabic crypto/economy news -> Mr_Amwal newsroom.

Flow: fetch headlines -> ask Claude to pick the strongest NEW story and write the
Arabic item -> publish to the newsroom API -> remember it in posted.json.

All secrets come from environment variables (GitHub Actions Secrets).
"""
import json
import os
import sys
import time
from pathlib import Path

import requests

STATE = Path(__file__).resolve().parent.parent / "posted.json"
LAST = Path(__file__).resolve().parent.parent / "last_post.txt"
MIN_GAP_MIN = 15  # backup schedules skip if something was posted more recently
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5")


def env(name, required=True, default=None):
    v = os.environ.get(name, default)
    if required and not v:
        sys.exit(f"Missing required secret/env var: {name}")
    return v


def load_state():
    if STATE.exists():
        return json.loads(STATE.read_text(encoding="utf-8"))
    return []


def save_state(items):
    STATE.write_text(json.dumps(items[-60:], ensure_ascii=False, indent=2), encoding="utf-8")


FEEDS = {
    "Cointelegraph": "https://cointelegraph.com/rss",
    "CoinDesk": "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "The Block": "https://www.theblock.co/rss.xml",
    "Decrypt": "https://decrypt.co/feed",
    "Bitcoin Magazine": "https://bitcoinmagazine.com/feed",
    "CryptoSlate": "https://cryptoslate.com/feed/",
    "Bitcoinist": "https://bitcoinist.com/feed/",
    "NewsBTC": "https://www.newsbtc.com/feed/",
    "CryptoNews": "https://cryptonews.com/news/feed/",
    "The Defiant": "https://thedefiant.io/api/feed",
    "CNBC Economy": "https://www.cnbc.com/id/20910258/device/rss/rss.html",
    "CNBC Markets": "https://www.cnbc.com/id/10000664/device/rss/rss.html",
    "MarketWatch": "https://feeds.content.dowjones.io/public/rss/mw_topstories",
}


FRESH_HOURS = 2  # only headlines published in the last N hours are considered


def fetch_headlines():
    """Free public RSS feeds (no API key). Keeps ONLY fresh items, newest first, with their age."""
    import xml.etree.ElementTree as ET
    from email.utils import parsedate_to_datetime
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    items = []
    for name, url in FEEDS.items():
        try:
            r = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0 newsroom-bot"})
            r.raise_for_status()
            root = ET.fromstring(r.content)
            for i in root.iter("item"):
                t = (i.findtext("title") or "").strip()
                try:
                    when = parsedate_to_datetime(i.findtext("pubDate") or "")
                    if when.tzinfo is None:
                        when = when.replace(tzinfo=timezone.utc)
                except Exception:
                    continue  # no reliable date -> skip, we cannot prove it is fresh
                age_min = (now - when).total_seconds() / 60
                if t and 0 <= age_min <= FRESH_HOURS * 60:
                    items.append((age_min, f"- ({int(age_min)} min ago) {t} [{name}]"))
        except Exception as e:  # keep going with the other feeds
            print(f"Feed failed: {name}: {e}")
    items.sort()
    print(f"Fresh headlines (last {FRESH_HOURS}h):", len(items), flush=True)
    return "\n".join(row for _, row in items[:40])


def live_btc():
    """Current BTC price and 24h change (CoinGecko, then Coinbase as backup)."""
    try:
        r = requests.get("https://api.coingecko.com/api/v3/simple/price",
                         params={"ids": "bitcoin", "vs_currencies": "usd",
                                 "include_24hr_change": "true"}, timeout=20)
        r.raise_for_status()
        d = r.json()["bitcoin"]
        return f"BTC now ${d['usd']:,.0f} ({d['usd_24h_change']:+.1f}% in 24h, CoinGecko)"
    except Exception as e:
        print("CoinGecko failed:", e)
    try:
        r = requests.get("https://api.coinbase.com/v2/prices/BTC-USD/spot", timeout=20)
        r.raise_for_status()
        return f"BTC now ${float(r.json()['data']['amount']):,.0f} (Coinbase spot)"
    except Exception as e:
        print("Coinbase failed:", e)
    return None


UP = ("ارتفاع", "يرتفع", "ترتفع", "ترتد", "يرتد", "تتجاوز", "يتجاوز", "متجاوز", "تقفز", "يقفز",
      "قفز", "تعاف", "يتعافى", "صعود", "تصعد", "يصعد", "تستعيد", "يستعيد", "مكاسب")
DOWN = ("هبوط", "يهبط", "تهبط", "تراجع", "يتراجع", "تتراجع", "انخفاض", "ينخفض", "تنخفض",
        "دون", "تحت", "خسائر", "تخسر", "يخسر", "انهيار", "تصفية")


def _direction(s):
    up, down = any(w in s for w in UP), any(w in s for w in DOWN)
    return "up" if up and not down else "down" if down and not up else None


def _words(s):
    import re
    stop = {"في", "من", "إلى", "على", "بعد", "مع", "عن", "فوق", "دولار", "عاجل", "ألف", "مليون",
            "مليار", "the", "a", "to"}
    out = set()
    for w in re.findall(r"\d+|[\w؀-ۿ]{3,}", s.lower()):
        if w.startswith("ال") and len(w) > 4:
            w = w[2:]  # الانتخابات -> انتخابات
        if w not in stop:
            out.add(w)
    return out


def is_repeat(title, posted, threshold=0.5):
    """Hard duplicate check in code: many shared words with a recent title, in the SAME
    direction (a rise after a fall is a real new development, not a repeat)."""
    new, d_new = _words(title), _direction(title)
    for old in posted[-15:]:
        o = _words(old)
        d_old = _direction(old)
        if d_new and d_old and d_new != d_old:
            continue
        if new and o and len(new & o) / min(len(new), len(o)) >= threshold:
            return old
    return None


PROMPT = """You are the senior Arabic news editor of Mr_Amwal, a crypto/economy app for Arab traders.
LIVE MARKET RIGHT NOW: {btc}
Any story about the Bitcoin price MUST agree with this live price: never say BTC is above a level
it is now below (or rising when the live 24h change is negative), and use this live price, not an
older number from a headline. If a headline's price claim no longer matches, skip that story.

Fresh headlines from the last 2 hours only (newest first, age in minutes):
{headlines}
Prefer the newest headlines. Never post an event that happened earlier than these.

Already published on the site (the SAME event or the same topic, e.g. another Fed-decision
item, is a REPEAT; only a genuinely new development counts as new):
{posted}

TASK: choose the single STRONGEST high-impact story that is NOT a repeat. Priority: big BTC/ETH
moves, Fed/rates/inflation data, spot ETF flows, major regulation or court rulings, large
institutional moves, major hacks, oil/gold/dollar moves, US-China. Skip small altcoins,
memecoins, games, ads, opinion pieces, price-prediction clickbait.
TOP PRIORITY (post these first, the moment they appear in the headlines): US weekly/monthly
economic decisions and data: Fed rate decision, jobs/NFP, CPI/inflation, PCE, GDP, housing data.
Also top priority: a major hack of an exchange, an exchange collapse, or any shock moving the market.
BITCOIN DIRECTION (TOP PRIORITY): if the headlines show BTC rising/surging/recovering/breaking a
level, post that rise as the story right away. CONSISTENCY: look at the "Already published" list;
never publish a story that contradicts the current BTC direction in the headlines (do not write
"BTC falls/drops" when the latest headlines show it rising, and vice versa). If an older published
item is now outdated, write the new development as an update ("يرتد", "يتعافى") instead.
ONLY topics about the USA, China, Trump, or crypto/markets. NEVER pick anything about Europe
(ECB, Lagarde, EU, eurozone, European countries or companies) or Israel; skip those entirely.

FACTS: use ONLY facts present in the headlines above. Never invent numbers, names or quotes.
If a detail is not in the headlines, leave it out.

WRITING (Modern Standard Arabic, natural news style, correct grammar):
- Style: like a phone news push notification: a punchy headline, then ONE short sentence.
- title: max 10 words, starts with one fitting emoji (🚨 breaking, 📉/📈 price moves, 🏦 regulation
  or central banks, 🔐 hacks, 💵 US economy data, 🇨🇳 China); for truly breaking news put
  "عاجل:" right after the emoji. The headline alone must tell the story. No quotes.
- body: ONE short sentence only (max 25 words) with the key figure or detail. NO
  "ماذا يعني للمتداول" line, NO price line, NO source line, no buy/sell advice, no hashtags.
  Write company/coin names as usual (BTC, ETH, XRP, Fed written "الفيدرالي").
- category: "عاجل" is RARE (at most 1-2 per day): only a Fed decision, a major US data release,
  a major exchange hack or a market shock. Normal news is "كريبتو" for crypto or "اقتصاد" for
  macro; "تنبيه" for security/risk warnings. Do not put "عاجل:" in the title of normal news.
- REPEATS: a story about the same company/figure/event as ANY item in the published list is a
  repeat even if worded differently (e.g. the same Tether 150k BTC or CFTC perpetual-futures
  story). Never publish the same event twice.

Reply with JSON only, no markdown fences:
{{"skip": false, "title": "...", "body": "...", "category": "كريبتو|اقتصاد|عاجل|تنبيه", "hot": false}}
Set "hot": true ONLY for truly urgent, market-moving news (major exchange hack, Fed decision,
big US data release); otherwise false.
If every strong story is already published, reply {{"skip": true}}."""


def write_item(headlines, posted, btc):
    """Uses Google Gemini (free tier) by default; set LLM=anthropic to use Claude instead (paid)."""
    prompt = PROMPT.format(headlines=headlines, btc=btc,
                           posted="\n".join(f"- {t}" for t in posted[-60:]) or "(none)")
    if env("LLM", required=False, default="gemini") == "anthropic":
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": env("ANTHROPIC_API_KEY"),
                     "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={"model": MODEL, "max_tokens": 800,
                  "messages": [{"role": "user", "content": prompt}]}, timeout=90)
        r.raise_for_status()
        text = r.json()["content"][0]["text"]
    else:
        key = env("GEMINI_API_KEY")
        base = "https://generativelanguage.googleapis.com/v1beta"
        candidates = []
        if os.environ.get("GEMINI_MODEL"):
            candidates.append(os.environ["GEMINI_MODEL"])
        # Ask Google which models this key can use, so a retired model name never breaks us.
        try:
            lm = requests.get(f"{base}/models", params={"key": key, "pageSize": 200}, timeout=30)
            lm.raise_for_status()
            names = [m["name"].split("/")[-1] for m in lm.json().get("models", [])
                     if "generateContent" in m.get("supportedGenerationMethods", [])]
            print("Models available:", names[:40], flush=True)
            bad = ("image", "tts", "live", "audio", "embedding", "vision", "omni", "veo", "imagen")
            usable = [n for n in names if not any(x in n for x in bad)]
            # Stable aliases first (they follow Google's current free models), then the rest.
            candidates += [n for n in ("gemini-flash-lite-latest", "gemini-flash-latest")
                           if n in usable]
            candidates += [n for n in usable if "flash" in n]
            candidates += [n for n in usable if n.startswith("gemma")]
            candidates += [n for n in usable if "pro" in n]
        except Exception as e:
            print("List models failed:", e)
        candidates += ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-pro-latest"]
        text, last = None, None
        for attempt, model in enumerate(list(dict.fromkeys(candidates))[:14]):
            if attempt:
                time.sleep(3)  # brief pause helps with "high demand" (503) errors
            try:
                r = requests.post(f"{base}/models/{model}:generateContent", params={"key": key},
                                  json={"contents": [{"parts": [{"text": prompt}]}],
                                        "generationConfig": {"maxOutputTokens": 4000, "responseMimeType": "application/json"}},
                                  timeout=40)
            except Exception as e:  # timeout / network: try the next model
                last = (model, type(e).__name__)
                print("Model error:", last, flush=True)
                continue
            if r.ok:
                try:
                    parts = r.json()["candidates"][0]["content"]["parts"]
                    cand = "".join(p.get("text", "") for p in parts)
                    json.loads(cand[cand.index("{"): cand.rindex("}") + 1])  # must be valid JSON
                    text = cand
                    print("Using model:", model, flush=True)
                    break
                except Exception:
                    last = (model, "empty reply", r.text[:200])
                    print("Model bad reply:", last, flush=True)
                    continue
            last = (model, r.status_code, r.text[:200])
            print("Model failed:", last, flush=True)
        if text is None:
            sys.exit(f"No Gemini model worked: {last}")
    return json.loads(text[text.index("{"): text.rindex("}") + 1])


SITE = "https://www.mr-amwal.com"
# Observed from the newsroom page: POST /api/newsroom/news with JSON keys
# title, body, tag, hours, hot, push; Content-Type only (auth is a session cookie
# that the private link /newsroom?u=<key> sets).  The exact "tag" values were not
# captured yet, so we try the Arabic label first, then likely slugs.
TAG_SLUGS = {"كريبتو": ["crypto"], "اقتصاد": ["economy", "economics"],
             "عاجل": ["urgent", "breaking"], "تنبيه": ["alert"]}


def publish(item):
    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0 newsroom-bot"
    # The POST needs the newsroom login cookie "mra_newsroom" (value from your own browser,
    # stored in the GitHub secret NEWSROOM_SESSION). Never print or log its value.
    session = env("NEWSROOM_SESSION")
    s.cookies.set("mra_newsroom", session, domain="www.mr-amwal.com", path="/", secure=True)
    print("Using cookie: mra_newsroom (value hidden)", flush=True)
    label = item["category"]
    last = None
    for tag in [label] + TAG_SLUGS.get(label, []):
        payload = {"title": item["title"], "body": item["body"], "tag": tag,
                   "hours": 24, "hot": bool(item.get("hot")), "push": True}
        r = s.post(f"{SITE}/api/newsroom/news", json=payload,
                   headers={"Origin": SITE, "Referer": f"{SITE}/newsroom"}, timeout=30)
        if r.ok:
            print("Posted with tag:", tag)
            return
        last = (r.status_code, r.text[:200])
        print("Publish failed:", last, "tag:", tag)
        if r.status_code in (401, 403):
            break
    sys.exit(f"Publish failed: {last}")


def recently_posted():
    try:
        return (time.time() - float(LAST.read_text().strip())) < MIN_GAP_MIN * 60
    except Exception:
        return False


def main():
    if os.environ.get("GITHUB_EVENT_NAME") == "schedule" and recently_posted():
        print(f"Posted less than {MIN_GAP_MIN} min ago; skipping this run.")
        return
    posted = load_state()
    headlines = fetch_headlines()
    if not headlines:
        print("No fresh headlines in the last few hours; nothing published.")
        return
    btc = live_btc()
    if not btc:
        print("Could not get a live BTC price; not publishing (cannot check consistency).")
        return
    print(btc, flush=True)
    item = write_item(headlines, posted, btc)
    if item.get("skip"):
        print("No new strong story; nothing published.")
        return
    dup = is_repeat(item.get("title", ""), posted)
    if dup:
        print("Skipped as repeat of:", dup)
        return
    publish(item)
    posted.append(item["title"])
    save_state(posted)
    LAST.write_text(str(int(time.time())))
    print("Published:", item["title"])


if __name__ == "__main__":
    main()
