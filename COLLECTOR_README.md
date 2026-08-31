# QuickTechSolve — Daily Topic Collector

Runs once a day via GitHub Actions and writes a fresh `topics.json` with
candidate blog topics pulled from Reddit, Hacker News, Google Trends,
YouTube, and (optionally) Twitter/X.

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
   Skip this if you don't want to pay for it — Reddit + Hacker News +
   Google Trends already give solid daily coverage for free.
4. That's it. The workflow (`.github/workflows/daily-topics.yml`) runs
   every day at 07:00 UTC and commits the updated `topics.json` back to
   the repo. You can also trigger it manually from the **Actions** tab
   any time ("Run workflow").

## Reliability notes

- **Hacker News** (via Algolia's public API) is the most reliable
  source — no key, rarely blocked, always returns something for a
  tech-help niche.
- **Reddit** can occasionally return empty from hosted CI runners if
  Reddit rate-limits or blocks that IP range. The script now sends a
  real browser user-agent and retries with backoff, which fixes this
  most of the time.
- **Google Trends** goes through the unofficial `pytrends` library,
  which breaks periodically when Google changes its internal
  endpoints. Treat it as best-effort.
- If any source comes back empty, check the `_errors` key in
  `topics.json` — each failed source records its actual exception
  message there, viewable right in the content-engine tool's
  "Trending research" panel (no need to dig through Actions logs).

## Output shape

```json
{
  "generated_at": "2026-08-13T07:00:00+00:00",
  "reddit": [{ "source": "reddit", "subreddit": "techsupport", "title": "...", "url": "...", "score": 42 }],
  "hackernews": [{ "source": "hackernews", "title": "...", "url": "...", "score": 87 }],
  "google_trends": [{ "source": "google_trends", "title": "...", "url": null, "score": null }],
  "youtube": [{ "source": "youtube", "title": "...", "url": "...", "score": null }],
  "twitter": [{ "source": "twitter", "title": "...", "url": "...", "score": 12 }],
  "_errors": { "google_trends": ["ConnectionError: ..."] }
}
```

`_errors` only appears when a source actually failed — a normal run
with everything working won't have this key.

A dated copy is also kept in `topics/YYYY-MM-DD.json` so you build up a
searchable history over time.

## Wiring it into the content engine

The content-engine tool routes its `topics.json` fetch through
Anthropic's server-side web-fetch tool (since artifacts can't call
arbitrary external domains directly from the browser). If that ever
fails, use the "Paste topics.json instead" fallback in the tool: open
`https://raw.githubusercontent.com/<you>/<repo>/main/topics.json` in
your own browser, copy the JSON, and paste it in.

## Local test run

```bash
pip install -r requirements.txt
python collect_topics.py
```
