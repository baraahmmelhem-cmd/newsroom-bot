#!/usr/bin/env python3
"""Build app/feed.json for the live platform (PWA).

Collects, in one file the app reads:
  aljazeera : economy headlines from Al Jazeera Arabic (RSS + the /ebusiness section page)
  newsroom  : what the bot published on mr-amwal.com, with the source site and the model
              (parsed from the GitHub Actions logs of hourly-news / whatsapp-to-site runs)
  whatsapp  : what was sent on WhatsApp (parsed from the logs of any workflow whose name
              contains "whatsapp" except whatsapp-to-site)
  runs      : the last 40 workflow runs (status, duration, link) so the owner sees the work

Needs: GITHUB_TOKEN (given automatically in Actions, permissions actions:read),
       GITHUB_REPOSITORY (automatic), LIVE_URL (optional: previous feed is reused as a cache).
"""
import io
import json
import os
import re
import sys
import zipfile
import html as htmlmod
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

OUT = Path(__file__).resolve().parent.parent / "app" / "feed.json"
UA = {"User-Agent": "Mozilla/5.0 newsroom-live"}
AJ_RSS = ("https://www.aljazeera.net/aljazeerarss/"
          "a7c186be-1baa-4bd4-9d80-a84db769f779/73d0e1b4-532f-45ef-b135-bfdff8b8cab9")
AJ_SECTION = "https://www.aljazeera.net/ebusiness"
KEEP_DAYS = 3
GH = "https://api.github.com"


def gh(path, **kw):
    r = requests.get(f"{GH}{path}", headers={"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
                                              "Accept": "application/vnd.github+json", **UA},
                     timeout=30, **kw)
    r.raise_for_status()
    return r


# ---------------- Al Jazeera ----------------
def aljazeera():
    import xml.etree.ElementTree as ET
    from email.utils import parsedate_to_datetime
    items, seen = [], set()
    try:
        r = requests.get(AJ_RSS, headers=UA, timeout=30)
        r.raise_for_status()
        for i in ET.fromstring(r.content).iter("item"):
            link = (i.findtext("link") or "").split("?")[0]
            title = htmlmod.unescape((i.findtext("title") or "").strip())
            if not link or not title or link in seen:
                continue
            try:
                when = parsedate_to_datetime(i.findtext("pubDate") or "").astimezone(timezone.utc)
            except Exception:
                when = datetime.now(timezone.utc)
            section = link.split("aljazeera.net/")[-1].split("/")[0]
            seen.add(link)
            items.append({"id": "aj:" + link, "title": title, "link": link, "time": when.isoformat(),
                          "section": section, "economy": section in ("ebusiness", "economy")})
    except Exception as e:
        print("Al Jazeera RSS failed:", e)
    # The economy section page lists more economy stories than the general RSS carries.
    try:
        r = requests.get(AJ_SECTION, headers=UA, timeout=30)
        r.raise_for_status()
        for m in re.finditer(r'<a[^>]+href="(/ebusiness/20\d\d/\d\d?/\d\d?/[^"#?]+)"[^>]*>(.*?)</a>', r.text, re.S):
            link = "https://www.aljazeera.net" + m.group(1)
            title = htmlmod.unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip()
            if link in seen or len(title) < 15:
                continue
            seen.add(link)
            d = re.search(r"/(20\d\d)/(\d\d?)/(\d\d?)/", link)
            when = datetime(int(d.group(1)), int(d.group(2)), int(d.group(3)), tzinfo=timezone.utc)
            items.append({"id": "aj:" + link, "title": title, "link": link, "time": when.isoformat(),
                          "section": "ebusiness", "economy": True, "approx_time": True})
    except Exception as e:
        print("Al Jazeera section failed:", e)
    cutoff = datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)
    items = [x for x in items if datetime.fromisoformat(x["time"]) >= cutoff]
    items.sort(key=lambda x: x["time"], reverse=True)
    print("Al Jazeera items:", len(items), "economy:", sum(1 for x in items if x["economy"]))
    return items[:80]


# ---------------- GitHub Actions ----------------
def run_log(run_id):
    try:
        r = gh(f"/repos/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{run_id}/logs", allow_redirects=True)
        z = zipfile.ZipFile(io.BytesIO(r.content))
        text = "\n".join(z.read(n).decode("utf-8", "replace") for n in sorted(z.namelist()) if n.endswith(".txt"))
        return re.sub(r"(?m)^\S+Z ", "", text)
    except Exception as e:
        print("log failed", run_id, e)
        return ""


def previous_feed():
    url = os.environ.get("LIVE_URL", "").rstrip("/")
    if url:
        try:
            r = requests.get(f"{url}/feed.json", headers=UA, timeout=20)
            if r.ok:
                return r.json()
        except Exception as e:
            print("previous feed failed:", e)
    if OUT.exists():
        try:
            return json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


PUB = re.compile(r"(?m)^Published:\s*(.+?)(?:\s*\|\s*source:\s*(.+))?\s*$")
MODEL = re.compile(r"(?m)^Using model:\s*(.+)$")
SENT = re.compile(r"(?mi)^(?:sent|أُرسل|أرسل|تم الإرسال|message sent|delivered|whatsapp sent)\b[:\s-]*(.+)$")
SKIP = re.compile(r"(?m)^(Skipped as repeat of:.*|No new strong story.*|No fresh headlines.*|Posted less than.*|Could not get a live BTC.*|Skipped:.*)$")


def github():
    repo = os.environ["GITHUB_REPOSITORY"]
    prev = previous_feed()
    cache = {x["run_id"]: x for x in prev.get("newsroom", []) + prev.get("whatsapp", []) if "run_id" in x}
    cached_runs = {x["run_id"] for x in prev.get("runs", []) if x.get("status") == "completed"}
    runs = gh(f"/repos/{repo}/actions/runs?per_page=60").json()["workflow_runs"]
    newsroom = [x for x in prev.get("newsroom", []) if "run_id" in x]
    whatsapp = [x for x in prev.get("whatsapp", []) if "run_id" in x]
    summary = []
    for r in runs:
        rid = r["id"]
        row = {"run_id": rid, "name": r["name"], "status": r["status"], "conclusion": r.get("conclusion"),
               "event": r["event"], "time": r["created_at"], "url": r["html_url"],
               "seconds": None, "note": None}
        if r["status"] == "completed" and r.get("run_started_at"):
            a = datetime.fromisoformat(r["run_started_at"].replace("Z", "+00:00"))
            b = datetime.fromisoformat(r["updated_at"].replace("Z", "+00:00"))
            row["seconds"] = int((b - a).total_seconds())
        is_wa_site = "whatsapp-to-site" in (r.get("path") or "") or "whatsapp to site" in r["name"].lower()
        is_wa = ("whatsapp" in r["name"].lower() or "whatsapp" in (r.get("path") or "")) and not is_wa_site
        if r["status"] == "completed" and rid not in cache and rid not in cached_runs:
            log = run_log(rid)
            m = PUB.search(log)
            if m:
                item = {"id": f"nr:{rid}", "run_id": rid, "title": m.group(1).strip(),
                        "source": (m.group(2) or "").strip() or None,
                        "model": (MODEL.search(log).group(1).strip() if MODEL.search(log) else None),
                        "time": r["updated_at"], "url": r["html_url"], "workflow": r["name"]}
                newsroom.append(item)
                row["note"] = "نُشر: " + item["title"]
            if is_wa:
                lines = [x.group(1).strip() for x in SENT.finditer(log)][:5]
                if r.get("conclusion") == "success" and not lines and "Published:" not in log:
                    lines = []  # nothing recognisable; the run still shows in "runs"
                if lines:
                    whatsapp.append({"id": f"wa:{rid}", "run_id": rid, "text": " · ".join(lines),
                                     "time": r["updated_at"], "url": r["html_url"], "workflow": r["name"]})
                    row["note"] = "واتساب: " + lines[0][:120]
            if not row["note"]:
                s = SKIP.search(log)
                if s:
                    row["note"] = (s.group(0).replace("Skipped as repeat of:", "مكرر لخبر سابق:")
                                   .replace("No new strong story; nothing published.", "لا خبر قوي جديد")
                                   .replace("No fresh headlines in the last few hours; nothing published.", "لا عناوين جديدة")
                                   .replace("Could not get a live BTC price; not publishing (cannot check consistency).", "تعذّر جلب سعر BTC"))
                    row["note"] = re.sub(r"^Posted less than.*", "نُشر خبر قبل أقل من 40 دقيقة", row["note"])
                elif r.get("conclusion") == "failure":
                    e = re.findall(r"(?m)^(Publish failed:.*|No Gemini model worked.*|Missing required.*|##\[error\].*)$", log)
                    row["note"] = (e[0] if e else "فشل").replace("##[error]", "")[:160]
        else:
            c = cache.get(rid)
            if c:
                row["note"] = ("نُشر: " + c["title"]) if "title" in c else ("واتساب: " + c["text"][:120])
            else:
                old = next((x for x in prev.get("runs", []) if x.get("run_id") == rid), None)
                if old:
                    row["note"] = old.get("note")
        summary.append(row)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
    newsroom = sorted({x["run_id"]: x for x in newsroom}.values(), key=lambda x: x["time"], reverse=True)
    whatsapp = sorted({x["run_id"]: x for x in whatsapp}.values(), key=lambda x: x["time"], reverse=True)
    newsroom = [x for x in newsroom if x["time"] >= cutoff][:200]
    whatsapp = [x for x in whatsapp if x["time"] >= cutoff][:200]
    print("newsroom:", len(newsroom), "whatsapp:", len(whatsapp), "runs:", len(summary))
    return newsroom, whatsapp, summary


def main():
    newsroom, whatsapp, runs = github()
    feed = {"generated": datetime.now(timezone.utc).isoformat(), "repo": os.environ["GITHUB_REPOSITORY"],
            "aljazeera": aljazeera(), "newsroom": newsroom, "whatsapp": whatsapp, "runs": runs}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(feed, ensure_ascii=False, indent=1), encoding="utf-8")
    print("Wrote", OUT, OUT.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
