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
MIN_GAP_MIN = 50  # backup schedules skip if something was posted more recently
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
    "CNBC Top News": "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    "CNBC Tech": "https://www.cnbc.com/id/19854910/device/rss/rss.html",
    "Google News Crypto": "https://news.google.com/rss/search?q=(bitcoin%20OR%20crypto%20OR%20Binance%20OR%20stablecoin)%20when%3A2h&hl=en-US&gl=US&ceid=US:en",
    "Google News Fed": "https://news.google.com/rss/search?q=(%22Federal%20Reserve%22%20OR%20Powell%20OR%20CPI%20OR%20%22jobs%20report%22%20OR%20%22interest%20rate%22)%20when%3A2h&hl=en-US&gl=US&ceid=US:en",
    "Google News Trump": "https://news.google.com/rss/search?q=Trump%20(tariffs%20OR%20economy%20OR%20crypto%20OR%20dollar%20OR%20China)%20when%3A2h&hl=en-US&gl=US&ceid=US:en",
    "Google News China": "https://news.google.com/rss/search?q=China%20(economy%20OR%20tariffs%20OR%20yuan%20OR%20trade)%20when%3A2h&hl=en-US&gl=US&ceid=US:en",
    "Google News Big Tech": "https://news.google.com/rss/search?q=(Apple%20OR%20Google%20OR%20Microsoft%20OR%20Nvidia%20OR%20Meta%20OR%20Amazon%20OR%20Tesla%20OR%20OpenAI)%20(outage%20OR%20CEO%20OR%20launches%20OR%20lawsuit%20OR%20earnings%20OR%20antitrust)%20when%3A2h&hl=en-US&gl=US&ceid=US:en",
    "Google News Payments": "https://news.google.com/rss/search?q=(%22Apple%20Pay%22%20OR%20%22Google%20Pay%22%20OR%20Visa%20OR%20Mastercard%20OR%20PayPal%20OR%20Stripe%20OR%20%22crypto%20payments%22%20OR%20%22buy%20bitcoin%22)%20when%3A2h&hl=en-US&gl=US&ceid=US:en",
    "Al Jazeera Arabic": "https://www.aljazeera.net/aljazeerarss/a7c186be-1baa-4bd4-9d80-a84db769f779/73d0e1b4-532f-45ef-b135-bfdff8b8cab9",
    "Al Jazeera Economy": "https://news.google.com/rss/search?q=site%3Aaljazeera.net%2Febusiness%20when%3A2h&hl=ar&gl=EG&ceid=EG:ar",
    "Google News AI": "https://news.google.com/rss/search?q=(%22artificial%20intelligence%22%20OR%20OpenAI%20OR%20Anthropic%20OR%20%22AI%20chips%22%20OR%20Nvidia)%20(US%20OR%20China%20OR%20regulation%20OR%20launch%20OR%20ban)%20when%3A2h&hl=en-US&gl=US&ceid=US:en",
    "Al Jazeera": "https://www.aljazeera.com/xml/rss/all.xml",
}


FRESH_HOURS = 2  # only headlines published in the last N hours are considered


BANNED = ("israel", "israeli", "gaza", "netanyahu", "hamas", "hezbollah", "europe", "european", " eu ", "eu's", "ecb", "lagarde",
          "eurozone", "brussels", "germany", "german ", "france", "italy", "spain", "britain", "british", "england",
          "greece", "greek", "netherlands", "dutch", "poland", "switzerland", "swiss",
          "إسرائيل", "اسرائيل", "الإسرائيلي", "غزة", "أوروب", "اوروب", "اليورو", "بريطانيا", "ألمانيا", "فرنسا", "اليونان")

def banned(text):
    """Hard filter (user rule): never anything about Europe or Israel."""
    s = " " + (text or "").lower() + " "
    return any(w in s for w in BANNED)

URGENT_WORDS = ("الفيدرالي", "الفائدة", "التضخم", "الوظائف", "الناتج المحلي", "اختراق", "استقالة", "انهيار", "إفلاس")

def allow_urgent(item):
    """'عاجل' is kept only for real breaking items: Fed/US data or a major hack."""
    txt = item.get("title", "") + " " + item.get("body", "")
    return bool(item.get("hot")) and any(w in txt for w in URGENT_WORDS)

def minutes_since_last():
    try:
        return (time.time() - float(LAST.read_text().strip())) / 60
    except Exception:
        return 1e9

MUST = False
SLOT_HOURS = (9, 15, 21)  # Amman time: 3 items a day
MUST_RULE = ("\nIMPORTANT: this is the every-2-hours run. Compare ALL candidates; you MUST publish the strongest "
             "story from the list (headlines up to 3 hours old) that is not a repeat and "
             "not about Europe or Israel. Reply skip ONLY if literally every candidate is a repeat.")

def fetch_headlines():
    """Free public RSS feeds (no API key). Keeps ONLY fresh items, newest first, with their age."""
    import xml.etree.ElementTree as ET
    from email.utils import parsedate_to_datetime
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    items = []
    try:  # feeds the morning source check found dead or stale (scripts/health.py) are skipped today
        dead = set(json.loads((Path(__file__).resolve().parent.parent / "feeds_status.json").read_text(encoding="utf-8")).get("dead", []))
    except Exception:
        dead = set()
    for name, url in FEEDS.items():
        if name in dead:
            continue
        try:
            r = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0 newsroom-bot"})
            r.raise_for_status()
            root = ET.fromstring(r.content)
            for i in root.iter("item"):
                t = (i.findtext("title") or "").strip()
                import re as _re
                d = " ".join(_re.sub(r"<[^>]+>", " ", i.findtext("description") or "").split())[:300]
                try:
                    when = parsedate_to_datetime(i.findtext("pubDate") or "")
                    if when.tzinfo is None:
                        when = when.replace(tzinfo=timezone.utc)
                except Exception:
                    continue  # no reliable date -> skip, we cannot prove it is fresh
                age_min = (now - when).total_seconds() / 60
                if t and 0 <= age_min <= FRESH_HOURS * 60 and not banned(t):
                    items.append((age_min, f"- ({int(age_min)} min ago) {t}{(' — ' + d) if d else ''} [{name}]"))
        except Exception as e:  # keep going with the other feeds
            print(f"Feed failed: {name}: {e}")
    items.sort()
    # Owner 18 Nov: 450 headlines made the model skip. Keep every Al Jazeera item plus the newest others, max 150 in all.
    aj = [x for x in items if "[Al Jazeera" in x[1]]
    rest = [x for x in items if "[Al Jazeera" not in x[1]]
    items = sorted(aj + rest[:max(0, 150 - len(aj))])
    print(f"Fresh headlines (last {FRESH_HOURS}h):", len(items), flush=True)
    return "\n".join(f"[{i + 1}] " + row[2:] for i, (_, row) in enumerate(items[:40]))


def live_btc():
    """Bitcoin price verified by at least two of CoinGecko, Coinbase and Kraken (within 1%); the median of those."""
    quotes, change = {}, None
    try:
        r = requests.get("https://api.coingecko.com/api/v3/simple/price",
                         params={"ids": "bitcoin", "vs_currencies": "usd", "include_24hr_change": "true"}, timeout=20)
        r.raise_for_status()
        d = r.json()["bitcoin"]
        quotes["CoinGecko"], change = float(d["usd"]), d.get("usd_24h_change")
    except Exception as e:
        print("CoinGecko failed:", e)
    try:
        r = requests.get("https://api.coinbase.com/v2/prices/BTC-USD/spot", timeout=20)
        r.raise_for_status()
        quotes["Coinbase"] = float(r.json()["data"]["amount"])
    except Exception as e:
        print("Coinbase failed:", e)
    try:
        r = requests.get("https://api.kraken.com/0/public/Ticker", params={"pair": "XBTUSD"}, timeout=20)
        r.raise_for_status()
        quotes["Kraken"] = float(list(r.json()["result"].values())[0]["c"][0])
    except Exception as e:
        print("Kraken failed:", e)

    def median(v):
        v = sorted(v)
        n = len(v)
        return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2

    if len(quotes) < 2:
        print("BTC price not verified (fewer than 2 sources):", quotes)
        return None
    mid = median(quotes.values())
    agree = {k: v for k, v in quotes.items() if abs(v - mid) / mid <= 0.01}
    if len(agree) < 2:
        print("BTC price not verified (sources disagree):", quotes)
        return None
    price = median(agree.values())
    if "CoinGecko" not in agree:
        change = None
    ch = f"{change:+.1f}% in 24h, " if isinstance(change, (int, float)) else ""
    return f"BTC now ${price:,.0f} ({ch}verified: {' + '.join(agree)})"


def confirmed_outlets(item, headlines):
    """Owner rule (17 Nov): publish only when at least two different outlets report the story."""
    import re
    src = {}
    for line in (headlines or "").splitlines():
        m = re.match(r"^\[(\d+)\].*\[([^\]]+)\]\s*$", line)
        if m:
            s = m.group(2).strip().lower()
            if s.startswith("google news"):  # Google News: the real outlet is after " - " in the title
                o = re.search(r" - ([^\-—\[\]]{2,40}?)\s*(?:—|\[)", line)
                if o:
                    s = o.group(1).strip().lower()
            src[int(m.group(1))] = s
    refs = item.get("refs") or []
    found = {src[int(r)] for r in refs if str(r).strip().isdigit() and int(r) in src}
    if any("jazeera" in s or "الجزيرة" in s for s in found):
        found.add("al jazeera (trusted source)")  # owner rule 18 Nov: Al Jazeera alone is enough
    return found

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
    for old in posted[-40:]:
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

STRENGTH TEST: before choosing, compare ALL candidates and rank them by how much they move the markets
(crypto and US stocks) TODAY.
Strong: BTC/ETH price moves, spot ETF flows, US data/Fed, major regulation or court decisions, hacks,
buys/sells over 500 million dollars by big players, shock events at the biggest US companies
(a CEO of Nvidia/Apple/Microsoft/Tesla/Amazon/Google/Meta resigning, a huge earnings miss) that move stocks and crypto. Weak (choose only if nothing strong exists):
bank pilots, partnerships, product launches, licences, conference talk, single-company news without
market impact.
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
SCOPE: crypto stories AND major market-moving US/global-economy stories: Fed and US data, Trump decisions on
tariffs/economy/crypto, US-China, Russia (when market-moving), oil/gold/dollar/Treasury-yield shocks, coin prices ONLY for the owner's halal coins (Bitcoin, Ethereum, XRP, Solana, Stellar XLM, BNB) and never stories about
other coins or memecoins, AI news (US/China AI, AI chips, AI laws), big tech news (Apple, Google, Microsoft, Nvidia, Meta, Amazon, Tesla, OpenAI: major outages, CEO changes,
big launches, lawsuits, earnings shocks), payments news (Apple Pay, Google Pay, Visa, Mastercard, PayPal, Stripe,
stablecoin or crypto payments, new ways to buy or pay with bitcoin), and shock events at mega-cap companies that move
stocks and crypto. Pick the single story with the BIGGEST market impact right now. NEVER pick anything about Europe
(ECB, Lagarde, EU, eurozone, European countries or companies) or Israel; skip those entirely.

CONFIRMATION RULE (owner, very important): choose a story ONLY if at least TWO different outlets in the list
report the same event, and put the [numbers] of ALL those headlines in "refs". A story from one outlet only is not
published, EXCEPT Al Jazeera: an Al Jazeera headline on our topics is enough on its own (owner rule).
FACTS: use ONLY facts present in the headlines and their summaries above (the text after " — "). Never invent numbers, names or quotes.
If a detail is not in the headlines, leave it out.

WRITING (Modern Standard Arabic, clear and well ordered; the user publishes only 3 items a day,
one item every 2 hours, so each one must be the most important market story of those 2 hours):
- title: one punchy, grammatical Arabic headline in the style of an Al Jazeera news card, max 12 words, that tells the story and includes the key
  number. Start with who did what (e.g. "شركة التعدين مارا تبيع ..."). Never translate English words
  literally into odd Arabic (wrong: "معدن تكتل مارا"); write it as an Arab financial journalist would.
  No emoji. No quotes.
- body: AL JAZEERA CARD STYLE (presentation only). Write it in our OWN words, never copy any outlet's
  sentences. Exactly: ONE tight Arabic sentence (max 30 words) with the key facts and numbers that adds what
  the title does not say (who, how much, why it matters for the market); then an empty line; then
  "المصدر: " followed by the outlet names from the headlines, separated by " · ". Nothing else: no bullets,
  no English lines, no extra paragraphs.
- ARABIC TEXT DIRECTION RULE (very important): every Arabic line must START with an Arabic word,
  never with an English word, a ticker, a number or a symbol. Write coin and company names in Arabic
  (بيتكوين، إيثريوم، ريبل، سولانا، بلاك روك، الفيدرالي). Put numbers in the middle of the sentence.
- Correct Arabic grammar, no slang, no buy/sell advice, no hashtags, no emoji.
- category: "كريبتو" for crypto stories, "اقتصاد" for economy/markets/company stories, "عاجل" only for a truly breaking shock.
- REPEATS: a story about the same company/figure/event as ANY item in the published list is a
  repeat even if worded differently. Never publish the same event twice.

Reply with JSON only, no markdown fences:
{{"skip": false, "title": "...", "body": "...", "category": "كريبتو|اقتصاد|عاجل|تنبيه", "hot": false, "refs": [1, 5]}}
Set "hot": true ONLY for truly urgent, market-moving news (major exchange hack, Fed decision,
big US data release); otherwise false.
If every strong story is already published, reply {{"skip": true}}."""


def write_item(headlines, posted, btc):
    """Uses Google Gemini (free tier) by default; set LLM=anthropic to use Claude instead (paid)."""
    prompt = PROMPT.format(headlines=headlines, btc=btc,
                           posted="\n".join(f"- {t}" for t in posted[-60:]) or "(none)")
    if MUST:
        prompt += MUST_RULE
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


GREEN_ID = os.environ.get("GREENAPI_ID_INSTANCE", "710722798836")
GREEN_HOST = os.environ.get("GREENAPI_URL", "https://7107.api.greenapi.com")
WA_CHAT = os.environ.get("WHATSAPP_CHAT_ID", "120363410855267217@g.us")  # owner's group «وين المصادر ؟»


def whatsapp(item):
    """Every newsroom item also goes to the owner's WhatsApp group (owner decision, 14 Nov)."""
    token = os.environ.get("GREENAPI_API_TOKEN")
    if not token:
        print("GREENAPI_API_TOKEN missing; WhatsApp copy skipped.")
        return
    text = f"📰 *{item['title']}*\n\n{item['body']}"
    for attempt in range(3):
        try:
            r = requests.post(f"{GREEN_HOST}/waInstance{GREEN_ID}/sendMessage/{token}",
                              json={"chatId": WA_CHAT, "message": text}, timeout=30)
            if r.ok and "idMessage" in r.text:
                print("WhatsApp copy sent to the group.")
                try:  # tell the breaking-news bot this story is already in the group, so it is not sent twice
                    sent_path = Path(__file__).resolve().parent.parent / "whatsapp-report" / "alerts-sent.json"
                    sent = json.loads(sent_path.read_text(encoding="utf-8")) if sent_path.exists() else []
                    sent.append({"title": item["title"], "ts": int(time.time() * 1000)})
                    sent_path.write_text(json.dumps(sent[-300:], ensure_ascii=False, indent=2), encoding="utf-8")
                except Exception as e:
                    print("Could not note the story for the WhatsApp bot:", e)
                return
            print("WhatsApp copy failed: HTTP", r.status_code)
        except Exception as e:
            print("WhatsApp copy error:", type(e).__name__)
        time.sleep(5 * (attempt + 1))


def btc_price_wrong(item, btc_line):
    """Headlines are often hours old: reject an item whose Bitcoin figure is not the live price."""
    import re
    m = re.search(r"\$([\d,]+)", btc_line or "")
    if not m:
        return None
    live = float(m.group(1).replace(",", ""))
    txt = item.get("title", "") + " " + item.get("body", "")
    if not re.search(r"بيتكوين|بتكوين|bitcoin|BTC", txt, re.I):
        return None
    nums = [float(x.replace(",", "").replace("٬", "")) for x in re.findall(r"\d{1,3}(?:[,٬]\d{3})+|\d{5,6}", txt)]
    nums += [float(x.replace(",", ".")) * 1000 for x in re.findall(r"(\d{2,3}(?:[.,]\d)?)\s*ألف", txt)]
    for n in nums:
        if 10000 <= n <= 300000 and abs(n - live) / live > 0.04:
            return f"BTC figure {n:,.0f} but live price is {live:,.0f}"
    return None


def site_titles():
    """Titles already live on the newsroom (including items the owner posted by hand), so nothing is repeated."""
    import re, html as _html
    try:
        s = requests.Session()
        s.headers["User-Agent"] = "Mozilla/5.0 newsroom-bot"
        s.cookies.set("mra_newsroom", env("NEWSROOM_SESSION"), domain="www.mr-amwal.com", path="/", secure=True)
        r = s.get(f"{SITE}/newsroom", timeout=30)
        r.raise_for_status()
        found = re.findall(r'<b data-no-tr="" style="font-size:13.5px">(.*?)</b>', r.text, re.S)
        titles = [_html.unescape(re.sub(r"<[^>]+>", "", t)).strip() for t in found]
        titles = [t for t in titles if t]
        print("Titles already on the site:", len(titles), flush=True)
        return titles
    except Exception as e:
        print("Could not read the site's current items:", e)
        return []


def recently_posted():
    try:
        return (time.time() - float(LAST.read_text().strip())) < MIN_GAP_MIN * 60
    except Exception:
        return False


def main():
    global FRESH_HOURS, MUST
    if os.environ.get("GITHUB_EVENT_NAME") == "schedule" and recently_posted():
        print(f"Posted less than {MIN_GAP_MIN} min ago; skipping this run.")
        return
    # Every 2 hours, around the clock: the hourly trigger runs this, and it publishes once 2 hours have passed.
    if minutes_since_last() < 110:
        print("Published less than 2 hours ago; skipping.")
        return
    FRESH_HOURS, MUST = 3, True
    print("Every-2-hours run: publishing the strongest new market story of the last 3h.", flush=True)
    posted = load_state()
    on_site = site_titles()
    posted = posted + [t for t in on_site if t not in posted]
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
        print("Model skipped in a daily slot; asking once more.", flush=True)
        time.sleep(8)
        item = write_item(headlines, posted, btc)
    if item.get("skip"):
        print("No new strong story; nothing published.")
        return
    if banned(item.get("title", "") + " " + item.get("body", "")):
        print("Skipped (Europe/Israel rule):", item.get("title"))
        return
    if not allow_urgent(item):
        if item.get("category") == "عاجل":
            txt = item.get("title", "") + item.get("body", "")
            item["category"] = "كريبتو" if any(k in txt for k in ("بيتكوين", "كريبتو", "العملات", "إيثريوم", "ETF", "BTC", "ETH")) else "اقتصاد"
        item["title"] = item.get("title", "").replace("عاجل:", "").replace("عاجل :", "").replace("  ", " ").strip()
        item["hot"] = False
    bad = btc_price_wrong(item, btc)
    if bad:
        print("Skipped (wrong/old Bitcoin price):", item.get("title"), "-", bad)
        return
    dup = is_repeat(item.get("title", ""), posted)
    if dup:
        print("Repeat of:", dup, "- asking once more for a different story.", flush=True)
        item = write_item(headlines, posted + [item.get("title", "")], btc)
        if item.get("skip") or not item.get("title"):
            print("No other strong story; nothing published.")
            return
        if banned(item.get("title", "") + " " + item.get("body", "")):
            print("Skipped (Europe/Israel rule):", item.get("title"))
            return
        if not allow_urgent(item):
            item["hot"] = False
            if item.get("category") == "عاجل":
                item["category"] = "اقتصاد"
        dup = is_repeat(item.get("title", ""), posted)
        if dup:
            print("Skipped as repeat of:", dup)
            return
    outs = confirmed_outlets(item, headlines)
    if len(outs) < 2:
        print("Skipped (not confirmed by 2 outlets):", item.get("title"), sorted(outs))
        return
    bad = btc_price_wrong(item, btc)
    if bad:
        print("Skipped (Bitcoin price not verified):", item.get("title"), "-", bad)
        return
    publish(item)
    whatsapp(item)
    posted.append(item["title"])
    save_state(posted)
    LAST.write_text(str(int(time.time())))
    print("Published:", item["title"])


if __name__ == "__main__":
    main()
