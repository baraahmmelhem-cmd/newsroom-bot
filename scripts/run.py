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
MIN_GAP_MIN = 40  # backup schedules skip if something was posted more recently
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
}


def fetch_headlines():
    """Free public RSS feeds (no API key). A feed that fails is skipped."""
    import xml.etree.ElementTree as ET
    rows = []
    for name, url in FEEDS.items():
        try:
            r = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0 newsroom-bot"})
            r.raise_for_status()
            root = ET.fromstring(r.content)
            titles = [(i.findtext("title") or "").strip() for i in root.iter("item")]
            rows += [f"- {t} [{name}]" for t in titles[:15] if t]
        except Exception as e:  # keep going with the other feeds
            print(f"Feed failed: {name}: {e}")
    if not rows:
        sys.exit("No headlines fetched from any feed.")
    return "\n".join(rows)


PROMPT = """You are the senior Arabic news editor of Mr_Amwal, a crypto/economy app for Arab traders.
Recent headlines (newest first):
{headlines}

Already published on the site (the SAME event or the same topic, e.g. another Fed-decision
item, is a REPEAT; only a genuinely new development counts as new):
{posted}

TASK: choose the single STRONGEST high-impact story that is NOT a repeat. Priority: big BTC/ETH
moves, Fed/rates/inflation data, spot ETF flows, major regulation or court rulings, large
institutional moves, major hacks, oil/gold/dollar moves, US-China. Skip small altcoins,
memecoins, games, ads, opinion pieces, price-prediction clickbait.
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
- category: "عاجل" only for truly breaking market-moving news; otherwise "كريبتو" for crypto
  or "اقتصاد" for macro; "تنبيه" for security/risk warnings.

Reply with JSON only, no markdown fences:
{{"skip": false, "title": "...", "body": "...", "category": "كريبتو|اقتصاد|عاجل|تنبيه"}}
If every strong story is already published, reply {{"skip": true}}."""


def write_item(headlines, posted):
    """Uses Google Gemini (free tier) by default; set LLM=anthropic to use Claude instead (paid)."""
    prompt = PROMPT.format(headlines=headlines,
                           posted="\n".join(f"- {t}" for t in posted[-30:]) or "(none)")
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
            good = [n for n in names if "flash" in n and not any(
                x in n for x in ("lite", "image", "tts", "live", "audio", "thinking", "exp", "preview"))]
            good.sort(reverse=True)
            candidates += good[:3] + [n for n in names if "flash" in n and n not in good][:2]
        except Exception as e:
            print("List models failed:", e)
        candidates += ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"]
        text, last = None, None
        for model in list(dict.fromkeys(candidates))[:6]:
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
                   "hours": 24, "hot": False, "push": True}
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
    item = write_item(fetch_headlines(), posted)
    if item.get("skip"):
        print("No new strong story; nothing published.")
        return
    publish(item)
    posted.append(item["title"])
    save_state(posted)
    LAST.write_text(str(int(time.time())))
    print("Published:", item["title"])


if __name__ == "__main__":
    main()
