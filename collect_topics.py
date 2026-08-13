"""
QuickTechSolve — daily trending topic collector.

Pulls candidate blog topics from several sources and writes them to
topics.json (latest snapshot) and topics/<date>.json (history).

Sources:
  - Reddit        (free, no key required)
  - Hacker News    (free, no key required, via Algolia's public HN API — very reliable)
  - Google Trends (free, no key required, via pytrends — can be flaky, best-effort)
  - YouTube       (free API key, set YOUTUBE_API_KEY — skipped if absent)
  - Twitter/X     (paid API required, set TWITTER_BEARER_TOKEN — skipped if absent)

Every source failure is caught and recorded under "_errors" in the output
JSON, so you can see exactly why a source came back empty without digging
through GitHub Actions logs.

Run locally:
    pip install -r requirements.txt
    python collect_topics.py

In CI, this is invoked daily by .github/workflows/daily-topics.yml
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

# A real browser UA matters — Reddit and some CDNs block generic/bot UAs,
# which is the most common reason this comes back empty on hosted CI runners.
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
}

# Subreddits relevant to a plain-English tech help/updates blog
SUBREDDITS = ["techsupport", "software", "technology", "android", "applehelp", "windows"]

# Keywords used to scan YouTube / Twitter for "how do I fix / update" style content
SEARCH_TERMS = [
    "how to fix",
    "windows update",
    "android update",
    "iphone update",
    "app not working",
]

ERRORS = {}


def _get_with_retry(url, headers=None, timeout=10, retries=2, backoff=2):
    last_exc = None
    for attempt in range(retries + 1):
        try:
            resp = requests.get(url, headers=headers or BROWSER_HEADERS, timeout=timeout)
            resp.raise_for_status()
            return resp
        except Exception as e:
            last_exc = e
            if attempt < retries:
                time.sleep(backoff * (attempt + 1))
    raise last_exc


def collect_reddit():
    items = []
    sub_errors = []
    for sub in SUBREDDITS:
        try:
            url = f"https://www.reddit.com/r/{sub}/top.json?limit=8&t=day&raw_json=1"
            resp = _get_with_retry(url)
            for post in resp.json()["data"]["children"]:
                d = post["data"]
                items.append(
                    {
                        "source": "reddit",
                        "subreddit": sub,
                        "title": d.get("title"),
                        "url": f"https://reddit.com{d.get('permalink')}",
                        "score": d.get("score"),
                    }
                )
        except Exception as e:
            msg = f"r/{sub}: {type(e).__name__}: {e}"
            sub_errors.append(msg)
            print(f"[reddit] skipped {msg}", file=sys.stderr)
    if sub_errors and not items:
        ERRORS["reddit"] = sub_errors
    return items


def collect_hackernews():
    """Algolia's public Hacker News search API — free, no key, reliably
    reachable from CI (unlike Reddit/Google, which sometimes block cloud IPs)."""
    items = []
    try:
        queries = ["windows", "android", "iphone", "browser", "app update", "security"]
        seen_ids = set()
        for q in queries:
            url = (
                "https://hn.algolia.com/api/v1/search_by_date"
                f"?tags=story&query={requests.utils.quote(q)}&hitsPerPage=6"
            )
            resp = _get_with_retry(url, headers={"Accept": "application/json"})
            for hit in resp.json().get("hits", []):
                hid = hit.get("objectID")
                if hid in seen_ids:
                    continue
                seen_ids.add(hid)
                items.append(
                    {
                        "source": "hackernews",
                        "title": hit.get("title"),
                        "url": hit.get("url") or f"https://news.ycombinator.com/item?id={hid}",
                        "score": hit.get("points"),
                    }
                )
    except Exception as e:
        ERRORS["hackernews"] = [f"{type(e).__name__}: {e}"]
        print(f"[hackernews] skipped: {e}", file=sys.stderr)
    return items


def collect_google_trends():
    items = []
    try:
        from pytrends.request import TrendReq

        pytrends = TrendReq(hl="en-US", tz=360, requests_args={"headers": BROWSER_HEADERS})
        trending = pytrends.trending_searches(pn="united_states")
        for term in trending[0].tolist():
            items.append({"source": "google_trends", "title": term, "url": None, "score": None})
    except Exception as e:
        ERRORS["google_trends"] = [f"{type(e).__name__}: {e}"]
        print(f"[google_trends] skipped: {e}", file=sys.stderr)
    return items


def collect_youtube():
    api_key = os.environ.get("YOUTUBE_API_KEY")
    if not api_key:
        ERRORS["youtube"] = ["YOUTUBE_API_KEY not set — add it as a repo secret to enable this source"]
        return []
    items = []
    try:
        url = (
            "https://www.googleapis.com/youtube/v3/search"
            f"?part=snippet&type=video&order=viewCount&publishedAfter={_since_iso(1)}"
            f"&q=tech+help&maxResults=10&key={api_key}"
        )
        resp = _get_with_retry(url, headers={"Accept": "application/json"})
        for item in resp.json().get("items", []):
            snippet = item["snippet"]
            vid = item["id"].get("videoId")
            items.append(
                {
                    "source": "youtube",
                    "title": snippet.get("title"),
                    "url": f"https://youtube.com/watch?v={vid}" if vid else None,
                    "score": None,
                }
            )
    except Exception as e:
        ERRORS["youtube"] = [f"{type(e).__name__}: {e}"]
        print(f"[youtube] skipped: {e}", file=sys.stderr)
    return items


def collect_twitter():
    token = os.environ.get("TWITTER_BEARER_TOKEN")
    if not token:
        ERRORS["twitter"] = ["TWITTER_BEARER_TOKEN not set — requires a paid X API tier, skipped by default"]
        return []
    items = []
    try:
        headers = {"Authorization": f"Bearer {token}"}
        query = " OR ".join(f'"{t}"' for t in SEARCH_TERMS)
        url = (
            "https://api.twitter.com/2/tweets/search/recent"
            f"?query=({query}) lang:en -is:retweet&max_results=20&tweet.fields=public_metrics"
        )
        resp = _get_with_retry(url, headers=headers)
        for tweet in resp.json().get("data", []):
            items.append(
                {
                    "source": "twitter",
                    "title": tweet.get("text"),
                    "url": f"https://twitter.com/i/web/status/{tweet.get('id')}",
                    "score": tweet.get("public_metrics", {}).get("like_count"),
                }
            )
    except Exception as e:
        ERRORS["twitter"] = [f"{type(e).__name__}: {e}"]
        print(f"[twitter] skipped: {e}", file=sys.stderr)
    return items


def _since_iso(days_ago):
    from datetime import timedelta

    dt = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    collected = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "reddit": collect_reddit(),
        "hackernews": collect_hackernews(),
        "google_trends": collect_google_trends(),
        "youtube": collect_youtube(),
        "twitter": collect_twitter(),
    }
    if ERRORS:
        collected["_errors"] = ERRORS

    os.makedirs("topics", exist_ok=True)
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    with open("topics.json", "w") as f:
        json.dump(collected, f, indent=2)

    with open(f"topics/{date_str}.json", "w") as f:
        json.dump(collected, f, indent=2)

    total = sum(
        len(v) for k, v in collected.items() if isinstance(v, list)
    )
    print(f"Collected {total} items across sources -> topics.json")
    if ERRORS:
        print(f"Sources with issues: {list(ERRORS.keys())}", file=sys.stderr)


if __name__ == "__main__":
    main()
