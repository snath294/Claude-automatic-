# QuickTechSolve — Daily Topic Collector

Runs once a day via GitHub Actions and writes a fresh `topics.json` with
candidate blog topics pulled from Reddit, Google Trends, YouTube, and
(optionally) Twitter/X.

## Setup

1. Push this folder to your GitHub repo (root, or wherever you keep the
   content-engine tool).
2. **Optional — YouTube:** get a free API key from the
   [Google Cloud Console](https://console.cloud.google.com/) (enable
   "YouTube Data API v3"). Add it as a repo secret named
   `YOUTUBE_API_KEY` (Settings → Secrets and variables → Actions).
3. **Optional — Twitter/X:** requires a paid API tier (Basic or higher)
   from the [X Developer Portal](https://developer.twitter.com/). Add
   the bearer token as a repo secret named `TWITTER_BEARER_TOKEN`.
   Skip this if you don't want to pay for it — Reddit + Google Trends
   + YouTube already give solid daily coverage for free.
4. That's it. The workflow (`.github/workflows/daily-topics.yml`) runs
   every day at 07:00 UTC and commits the updated `topics.json` back to
   the repo. You can also trigger it manually from the **Actions** tab
   any time ("Run workflow").

## Output shape

```json
{
  "generated_at": "2026-08-13T07:00:00+00:00",
  "reddit": [{ "source": "reddit", "subreddit": "techsupport", "title": "...", "url": "...", "score": 42 }],
  "google_trends": [{ "source": "google_trends", "title": "...", "url": null, "score": null }],
  "youtube": [{ "source": "youtube", "title": "...", "url": "...", "score": null }],
  "twitter": [{ "source": "twitter", "title": "...", "url": "...", "score": 12 }]
}
```

A dated copy is also kept in `topics/YYYY-MM-DD.json` so you build up a
searchable history over time.

## Wiring it into the content engine

Once `topics.json` lives in your public repo, the content-engine tool
can fetch it directly from the raw GitHub URL, e.g.:

```
https://raw.githubusercontent.com/<you>/<repo>/main/topics.json
```

and use those real, source-backed items as the topic list instead of
(or alongside) AI-suggested ideas. Tell me your repo name once it's up
and I'll wire that fetch into the React tool.

## Local test run

```bash
pip install -r requirements.txt
python collect_topics.py
```
