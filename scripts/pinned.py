#!/usr/bin/env python3
"""Pinned story of Mr_Amwal: every 3 days (72 hours, the site maximum) publish the single
strongest crypto / US-market story of the last 3 days as a highlighted item that stays
visible for 72 hours. Runs every hour after run.py; does nothing while the current pin is live."""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import requests  # noqa: E402
import run  # noqa: E402

PIN = Path(__file__).resolve().parent.parent / "pinned.json"
EVERY_H = 71.5  # renew just before the 72-hour item expires


def main():
    now = time.time()
    st = json.loads(PIN.read_text(encoding="utf-8")) if PIN.exists() else {}
    age_h = (now - st.get("ts", 0)) / 3600
    if age_h < EVERY_H:
        print(f"Pinned story still live ({age_h:.1f}h old); nothing to do.")
        return
    run.FRESH_HOURS = 72
    run.MUST = True
    run.MUST_RULE = (
        "\nIMPORTANT: this is the PINNED story of Mr_Amwal: it stays highlighted at the top of the app "
        "for 3 days. Choose the single most important crypto / US-market story of the LAST 3 DAYS "
        "(the big picture of these days, e.g. a Fed or US-data shock, a big BTC move, record ETF flows, "
        "a major regulation or hack), even if it was already published as a normal item; write it as a "
        "3-day summary of that story with the latest numbers. Never skip. Never Europe or Israel.")
    headlines = run.fetch_headlines()
    if not headlines:
        print("No headlines; will try again next hour.")
        return
    btc = run.live_btc()
    if not btc:
        print("No live BTC price; will try again next hour.")
        return
    item = run.write_item(headlines, [], btc)
    if item.get("skip") or not item.get("title"):
        print("Model gave no story; will try again next hour.")
        return
    if run.banned(item.get("title", "") + " " + item.get("body", "")):
        print("Europe/Israel rule; will try again next hour.")
        return
    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0 newsroom-bot"
    s.cookies.set("mra_newsroom", run.env("NEWSROOM_SESSION"), domain="www.mr-amwal.com", path="/", secure=True)
    label = item.get("category") or "كريبتو"
    for tag in [label] + run.TAG_SLUGS.get(label, []):
        r = s.post(f"{run.SITE}/api/newsroom/news",
                   json={"title": item["title"], "body": item["body"], "tag": tag,
                         "hours": 72, "hot": True, "push": False},
                   headers={"Origin": run.SITE, "Referer": f"{run.SITE}/newsroom"}, timeout=30)
        if r.ok:
            print("Pinned for 72h:", item["title"])
            PIN.write_text(json.dumps({"ts": now, "title": item["title"]}, ensure_ascii=False, indent=2),
                           encoding="utf-8")
            posted = run.load_state()
            posted.append(item["title"])
            run.save_state(posted)
            return
        print("Newsroom HTTP", r.status_code, "with tag", tag)
    sys.exit(1)


if __name__ == "__main__":
    main()
