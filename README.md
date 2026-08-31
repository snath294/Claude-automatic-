# QuickTechSolve — Automation Suite

A weekly content pipeline for [quicktechsolve.com](https://quicktechsolve.com): research-grounded, SEO-structured, WordPress-ready blog posts, backed by a daily trending-topic collector.

## What's in this repo

| File | What it does |
|---|---|
| `quicktechsolve-content-engine.jsx` | The main tool — open it in a Claude.ai chat (as an artifact) to generate weekly posts |
| `collect_topics.py` | Pulls daily trending topics from Reddit, Hacker News, Google Trends, YouTube, Twitter/X |
| `.github/workflows/daily-topics.yml` | Runs the collector automatically every day via GitHub Actions |
| `requirements.txt` | Python dependencies for the collector |
| `COLLECTOR_README.md` | Detailed collector setup + troubleshooting |

## Quick start

### 1. The content engine (the tool itself)
Upload `quicktechsolve-content-engine.jsx` into a Claude.ai conversation and open it — it runs as an interactive artifact right there. No build step, no hosting needed for this part.

### 2. The daily topic collector (optional but recommended)
Already set up in this repo if you're reading this from GitHub. If starting fresh:
1. Push these files to your repo (this one already has them)
2. Add secrets under **Settings → Secrets and variables → Actions** if you want YouTube (`YOUTUBE_API_KEY`, free) or Twitter/X (`TWITTER_BEARER_TOKEN`, paid) — both optional
3. Go to **Actions → Daily Topic Collection → Run workflow** once to generate the first `topics.json`
4. It'll then run automatically every day at 07:00 UTC

See `COLLECTOR_README.md` for troubleshooting (empty sources, failed runs, etc.).

## Using the tool

1. **Pick a week** from the queue strip at the top
2. **AI Provider** (optional) — defaults to Claude (no key needed). Switch to Gemini or Groq and paste your own free API key if you'd rather use those.
3. **Trending research** — enter your GitHub username/repo once to pull in real trending topics from the daily collector, or use the manual paste fallback
4. **Pick this week's topic** — AI-suggested (grounded in trending data + live search) or type your own
5. **Generate SEO post** — researches the topic live via web search, then writes a full post: title, excerpt, meta description, category, tags, featured image suggestion, keywords, outline, 800-1100 word content, FAQ, internal link ideas, and a note on what was actually verified during research
6. **Humanize post** — rewrites the prose to read more naturally, cutting AI-sounding filler
7. **Check AI-detection risk** — self-assessed Low/Medium/High risk score with specific flagged phrases and fixes
8. **Copy WordPress HTML** or **Download WP .html** — paste straight into WordPress's Code editor view, then fill in excerpt/category/tags/featured image from the fields shown

Everything you generate is saved automatically and shows up in **History** at the bottom, persisted across sessions.

## Notes & limitations

- The content engine runs inside Claude.ai's artifact sandbox, which can only reliably reach `api.anthropic.com` directly. Gemini/Groq calls and the "Trending research" GitHub fetch are built to work from a standalone deployment; inside Claude.ai they route through Claude's own server-side tools where possible (search grounding, web-fetch), with a manual paste fallback for topics.json if needed.
- "Check AI-detection risk" is the model's own self-assessment, not a certified detector — treat it as an editing prompt.
- Free-tier limits (Reddit, Hacker News, Google Trends, Gemini, Groq) are all well above what a once-a-week posting cadence needs.

## Deeper SEO work (optional)

For technical SEO audits beyond what this tool covers (Core Web Vitals, backlink strategy, Search Console analysis), grab the SEO Specialist Claude Code sub-agent from [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents/blob/main/marketing/marketing-seo-specialist.md) and drop it in `.claude/agents/` — it's a separate, more heavyweight tool for periodic audits rather than weekly content.
