#!/usr/bin/env python3
"""Hourly Arabic crypto/economy news -> Mr_Amwal newsroom.

Flow: fetch headlines -> ask Claude to pick the strongest NEW story and write the
Arabic item -> publish to the newsroom API -> remember it in posted.json.

All secrets come from environment variables (GitHub Actions Secrets).
"""
import json
import os
import sys
from pathlib import Path

import requests

STATE = Path(__file__).resolve().parent.parent / "posted.json"
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


PROMPT = """You are the news editor of Mr_Amwal, an Arabic crypto/economy news app.
Recent headlines (newest first):
{headlines}

Already published (do NOT repeat the same event):
{posted}

Pick the single STRONGEST high-impact story not yet published (big BTC/ETH moves, Fed/rates,
ETF flows, major regulation, big institutions, major hacks, oil/gold/dollar, US-China).
Avoid small altcoins, memecoins, games, ads, opinion pieces.
Use ONLY facts present in the headlines. Never invent numbers or quotes.
Reply with JSON only:
{{"skip": false, "title": "<Arabic, max 8 words>",
  "body": "<Arabic, 2-3 short sentences, then a final line starting 'ماذا يعني للمتداول:' with one balanced sentence. No source line. No buy/sell advice.>",
  "category": "كريبتو|اقتصاد|عاجل|تنبيه"}}
If every strong story is already published reply {{"skip": true}}."""


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
        model = env("GEMINI_MODEL", required=False, default="gemini-2.5-flash")
        r = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            params={"key": env("GEMINI_API_KEY")},
            json={"contents": [{"parts": [{"text": prompt}]}]}, timeout=90)
        r.raise_for_status()
        text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(text[text.index("{"): text.rindex("}") + 1])


def publish(item):
    """ADJUST THIS to match your newsroom's real API (ask the site developer).
    Field names below are placeholders."""
    r = requests.post(
        env("NEWSROOM_API_URL"),
        headers={"Authorization": f"Bearer {env('NEWSROOM_API_TOKEN')}",
                 "content-type": "application/json"},
        json={"title": item["title"], "body": item["body"],
              "category": item["category"], "visibleHours": 24,
              "important": False, "notify": True},
        timeout=30)
    r.raise_for_status()


def main():
    posted = load_state()
    item = write_item(fetch_headlines(), posted)
    if item.get("skip"):
        print("No new strong story; nothing published.")
        return
    publish(item)
    posted.append(item["title"])
    save_state(posted)
    print("Published:", item["title"])


if __name__ == "__main__":
    main()
