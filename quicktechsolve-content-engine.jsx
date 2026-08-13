import React, { useState, useEffect, useCallback } from "react";
import { Sparkles, Copy, Check, Loader2, ChevronDown, ChevronUp, RefreshCw, FileDown, Archive, AlertCircle, Settings, ExternalLink, Radar } from "lucide-react";

const SOURCE_LABEL = {
  reddit: "Reddit",
  google_trends: "Google Trends",
  youtube: "YouTube",
  twitter: "Twitter/X",
};

// ---------- helpers ----------

function mondayOf(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function weekKey(date) {
  return date.toISOString().slice(0, 10);
}

function weekLabel(date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function upcomingWeeks(n = 6) {
  const start = mondayOf(new Date());
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i * 7);
    return d;
  });
}

async function callClaude(prompt, maxTokens = 4096) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error("Request failed (" + res.status + ")");
  const data = await res.json();
  const text = (data.content || [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();
  return text;
}

function parseJSON(text) {
  const cleaned = text.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  return JSON.parse(cleaned);
}

function mdToHtml(md) {
  if (!md) return "";
  let html = md
    .replace(/^### (.*$)/gim, "<h3>$1</h3>")
    .replace(/^## (.*$)/gim, "<h2>$1</h2>")
    .replace(/^# (.*$)/gim, "<h2>$1</h2>")
    .replace(/\*\*(.*?)\*\*/gim, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/gim, "<em>$1</em>")
    .replace(/^\s*-\s+(.*$)/gim, "<li>$1</li>");
  html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/gim, (m) => "<ul>" + m + "</ul>");
  html = html
    .split(/\n{2,}/)
    .map((block) =>
      /^\s*<(h2|h3|ul)/.test(block.trim()) ? block : block.trim() ? `<p>${block.trim()}</p>` : ""
    )
    .join("\n");
  return html;
}

// ---------- small UI atoms ----------

function CopyBtn({ text, label = "Copy" }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text || "");
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch (e) {}
      }}
      className="copy-btn"
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Copied" : label}
    </button>
  );
}

function Field({ label, value, mono }) {
  return (
    <div className="field">
      <div className="field-head">
        <span className="field-label">{label}</span>
        <CopyBtn text={value} />
      </div>
      <div className={mono ? "field-value mono" : "field-value"}>{value}</div>
    </div>
  );
}

// ---------- main component ----------

export default function ContentEngine() {
  const [queue, setQueue] = useState([]);
  const [loadedQueue, setLoadedQueue] = useState(false);
  const [weeks] = useState(upcomingWeeks(6));
  const [activeWeek, setActiveWeek] = useState(weekKey(upcomingWeeks(1)[0]));

  const [topics, setTopics] = useState([]);
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState(null);
  const [customTopic, setCustomTopic] = useState("");

  const [loadingPost, setLoadingPost] = useState(false);
  const [post, setPost] = useState(null);
  const [error, setError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contentOpen, setContentOpen] = useState(true);

  // trending research (GitHub Actions daily collector output)
  const [repoConfig, setRepoConfig] = useState({ owner: "", repo: "", branch: "main" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trending, setTrending] = useState(null);
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [trendingError, setTrendingError] = useState("");
  const [activeSource, setActiveSource] = useState("all");

  // load queue + repo config + cached trending data from storage
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("qts_posts", false);
        if (r && r.value) setQueue(JSON.parse(r.value));
      } catch (e) {
        // no data yet
      } finally {
        setLoadedQueue(true);
      }
      try {
        const rc = await window.storage.get("qts_repo_config", false);
        if (rc && rc.value) {
          const cfg = JSON.parse(rc.value);
          setRepoConfig(cfg);
          if (cfg.owner && cfg.repo) fetchTrending(cfg);
        } else {
          setSettingsOpen(true);
        }
      } catch (e) {
        setSettingsOpen(true);
      }
      try {
        const tc = await window.storage.get("qts_trending_cache", false);
        if (tc && tc.value) setTrending(JSON.parse(tc.value));
      } catch (e) {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = useCallback(async (next) => {
    setQueue(next);
    try {
      await window.storage.set("qts_posts", JSON.stringify(next), false);
    } catch (e) {}
  }, []);

  const saveRepoConfig = useCallback(async (cfg) => {
    setRepoConfig(cfg);
    try {
      await window.storage.set("qts_repo_config", JSON.stringify(cfg), false);
    } catch (e) {}
  }, []);

  async function fetchTrending(cfg) {
    const c = cfg || repoConfig;
    if (!c.owner || !c.repo) {
      setTrendingError("Add your GitHub username and repo name first.");
      setSettingsOpen(true);
      return;
    }
    setTrendingLoading(true);
    setTrendingError("");
    try {
      const url = `https://raw.githubusercontent.com/${c.owner}/${c.repo}/${c.branch || "main"}/topics.json`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error("not found (" + res.status + ")");
      const data = await res.json();
      setTrending(data);
      try {
        await window.storage.set("qts_trending_cache", JSON.stringify(data), false);
      } catch (e) {}
    } catch (e) {
      setTrendingError(
        "Couldn't load topics.json from that repo yet. Make sure the daily-topics workflow has run at least once, and the repo/branch/path are correct."
      );
    } finally {
      setTrendingLoading(false);
    }
  }

  const trendingItems = trending
    ? ["reddit", "google_trends", "youtube", "twitter"]
        .filter((s) => activeSource === "all" || activeSource === s)
        .flatMap((s) => (trending[s] || []))
    : [];

  const postForWeek = (wk) => queue.find((p) => p.weekKey === wk);
  const currentSaved = postForWeek(activeWeek);

  async function suggestTopics() {
    setLoadingTopics(true);
    setError("");
    setTopics([]);
    setSelectedTopic(null);
    try {
      const trendingContext =
        trendingItems.length > 0
          ? `\n\nHere is real trending/discussion data collected today from Reddit, Google Trends, YouTube, and Twitter/X — use it to ground your suggestions in what people are actually searching and talking about right now, don't just invent generic ideas:\n${trendingItems
              .slice(0, 40)
              .map((it) => `- [${SOURCE_LABEL[it.source] || it.source}] ${it.title}`)
              .join("\n")}`
          : "";

      const prompt = `You are a content strategist for QuickTechSolve, a WordPress blog at quicktechsolve.com that gives everyday, non-technical readers practical tech help and software/device update news (Windows, Android, iOS, browsers, apps, common error fixes, "how do I..." questions, security basics).

Suggest 5 blog topic ideas for this week's post. Favor topics people actively search for right now (recent OS/app updates, common error messages, "how to" fixes). Avoid duplicating generic listicles.${trendingContext}

Respond with ONLY raw JSON, no markdown fences, no preamble, in this exact shape:
{"topics":[{"title":"short working title","angle":"one sentence on the reader problem it solves and why it's timely"}]}`;
      const text = await callClaude(prompt, 1200);
      const parsed = parseJSON(text);
      setTopics(parsed.topics || []);
    } catch (e) {
      setError("Couldn't fetch topic ideas. Try again.");
    } finally {
      setLoadingTopics(false);
    }
  }

  async function generatePost() {
    const topic = customTopic.trim() || selectedTopic;
    if (!topic) {
      setError("Pick a suggested topic or type your own first.");
      return;
    }
    setLoadingPost(true);
    setError("");
    setPost(null);
    try {
      const prompt = `You are an SEO content writer for QuickTechSolve (quicktechsolve.com), a friendly, plain-English tech help and updates blog for non-technical readers.

Write a complete, publish-ready, SEO-friendly blog post on this topic: "${topic}"

Requirements:
- Title: 50-60 characters, includes the focus keyword naturally, written to earn clicks in search results.
- Meta description: 150-160 characters, includes the focus keyword, states the concrete benefit/fix.
- URL slug: lowercase, hyphenated, short, keyword-focused.
- One clear focus keyword and 4-6 relevant secondary keywords/phrases.
- Outline: the H2/H3 heading structure as a flat list of strings like "H2: ..." / "H3: ...".
- Content: 800-1100 words in Markdown using ## for H2 and ### for H3, short paragraphs, at least one bulleted or numbered list, written in plain, step-by-step, non-jargon language for everyday readers. Open with the reader's problem, close with a short wrap-up. Do not include the title as an H1 inside the content.
- FAQ: 3 short question/answer pairs suited for an FAQ schema block, using real questions people search.
- estimatedWordCount: integer.

Respond with ONLY raw JSON, no markdown fences, no preamble, in this exact shape:
{"title":"","metaDescription":"","slug":"","focusKeyword":"","secondaryKeywords":["",""],"outline":["H2: ...","H3: ..."],"content":"markdown string","faq":[{"q":"","a":""}],"estimatedWordCount":0}`;
      const text = await callClaude(prompt, 4096);
      const parsed = parseJSON(text);
      const record = {
        weekKey: activeWeek,
        weekLabel: weekLabel(new Date(activeWeek)),
        topic,
        status: "draft",
        createdAt: new Date().toISOString(),
        ...parsed,
      };
      setPost(record);
      const next = [record, ...queue.filter((p) => p.weekKey !== activeWeek)];
      persist(next);
    } catch (e) {
      setError("Couldn't generate the post. Try again — sometimes the response needs a retry.");
    } finally {
      setLoadingPost(false);
    }
  }

  function togglePublished(wk) {
    const next = queue.map((p) =>
      p.weekKey === wk ? { ...p, status: p.status === "published" ? "draft" : "published" } : p
    );
    persist(next);
    if (post && post.weekKey === wk) setPost(next.find((p) => p.weekKey === wk));
  }

  function downloadMd(record) {
    const md = `# ${record.title}\n\n${record.content}\n\n## FAQ\n\n${(record.faq || [])
      .map((f) => `**${f.q}**\n\n${f.a}`)
      .join("\n\n")}`;
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${record.slug || "post"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const displayed = post && post.weekKey === activeWeek ? post : currentSaved;

  return (
    <div className="app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

        :root {
          --bg: #F1F3F4;
          --surface: #FFFFFF;
          --ink: #14171A;
          --ink-soft: #565D63;
          --teal: #0F9D8C;
          --teal-deep: #0B7A6D;
          --amber: #F5A623;
          --border: #DDE1E3;
        }
        * { box-sizing: border-box; }
        .app {
          background: var(--bg);
          min-height: 100vh;
          font-family: 'Inter', sans-serif;
          color: var(--ink);
          padding: 28px 20px 60px;
        }
        @media (min-width: 720px) { .app { padding: 40px 48px 80px; } }

        .header {
          display: flex; justify-content: space-between; align-items: flex-start;
          max-width: 880px; margin: 0 auto 28px; gap: 16px; flex-wrap: wrap;
        }
        .brand { display: flex; flex-direction: column; gap: 4px; }
        .brand-mark { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 22px; letter-spacing: -0.01em; }
        .brand-mark span { color: var(--teal); }
        .brand-sub { font-size: 13px; color: var(--ink-soft); font-family: 'JetBrains Mono', monospace; }
        .status-chip {
          font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--teal-deep);
          background: #E4F5F2; border: 1px solid #BFE7E1; padding: 6px 10px; border-radius: 6px;
          white-space: nowrap;
        }

        .queue-strip {
          max-width: 880px; margin: 0 auto 28px; display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px;
        }
        .week-pill {
          font-family: 'JetBrains Mono', monospace; font-size: 12.5px; flex-shrink: 0;
          padding: 8px 12px; border-radius: 999px; border: 1px solid var(--border);
          background: var(--surface); cursor: pointer; display: flex; align-items: center; gap: 6px;
          transition: border-color .15s, background .15s;
        }
        .week-pill:hover { border-color: var(--teal); }
        .week-pill.active { border-color: var(--teal); background: #E4F5F2; color: var(--teal-deep); }
        .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--border); flex-shrink: 0; }
        .dot.filled { background: var(--teal); }
        .dot.published { background: var(--amber); }

        .card {
          max-width: 880px; margin: 0 auto 20px; background: var(--surface);
          border: 1px solid var(--border); border-radius: 12px; padding: 22px;
        }
        .card-title {
          font-family: 'Space Grotesk', sans-serif; font-weight: 600; font-size: 15px;
          margin: 0 0 14px; display: flex; align-items: center; gap: 8px;
        }

        .row { display: flex; gap: 10px; flex-wrap: wrap; }
        .btn {
          font-family: 'Inter', sans-serif; font-weight: 600; font-size: 13.5px;
          padding: 10px 16px; border-radius: 8px; border: 1px solid var(--teal);
          background: var(--teal); color: white; cursor: pointer; display: inline-flex;
          align-items: center; gap: 7px; transition: background .15s;
        }
        .btn:hover { background: var(--teal-deep); }
        .btn:disabled { opacity: 0.55; cursor: default; }
        .btn.ghost { background: transparent; color: var(--teal-deep); }
        .btn.ghost:hover { background: #E4F5F2; }

        input[type="text"] {
          width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border);
          font-family: 'Inter', sans-serif; font-size: 13.5px; background: #FAFBFB;
        }
        input[type="text"]:focus { outline: 2px solid var(--teal); outline-offset: 1px; }

        .topic-list { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
        .topic-item {
          text-align: left; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
          background: #FAFBFB; cursor: pointer; font-family: 'Inter', sans-serif;
        }
        .topic-item.selected { border-color: var(--teal); background: #E4F5F2; }
        .topic-item strong { font-size: 13.5px; display: block; margin-bottom: 3px; }
        .topic-item small { color: var(--ink-soft); font-size: 12.5px; }

        .divider-label {
          font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--ink-soft);
          text-transform: uppercase; letter-spacing: .06em; margin: 16px 0 8px;
        }

        .field { margin-bottom: 14px; }
        .field-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
        .field-label { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: .05em; }
        .field-value { font-size: 14.5px; line-height: 1.5; }
        .field-value.mono { font-family: 'JetBrains Mono', monospace; font-size: 13px; }

        .copy-btn {
          font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--teal-deep);
          background: transparent; border: 1px solid #BFE7E1; border-radius: 6px; padding: 3px 8px;
          cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
        }
        .copy-btn:hover { background: #E4F5F2; }

        .chips { display: flex; flex-wrap: wrap; gap: 6px; }
        .chip {
          font-family: 'JetBrains Mono', monospace; font-size: 12px; padding: 4px 9px;
          background: #F1F3F4; border-radius: 6px; border: 1px solid var(--border);
        }

        .outline-list { margin: 0; padding-left: 0; list-style: none; font-size: 13.5px; }
        .outline-list li { padding: 4px 0; border-bottom: 1px dashed var(--border); }

        .content-body { font-size: 14.5px; line-height: 1.7; white-space: pre-wrap; }

        .faq-item { margin-bottom: 10px; }
        .faq-q { font-weight: 600; font-size: 13.5px; margin-bottom: 2px; }
        .faq-a { font-size: 13.5px; color: var(--ink-soft); }

        .section-toggle {
          display: flex; align-items: center; justify-content: space-between; cursor: pointer;
        }

        .error-box {
          max-width: 880px; margin: 0 auto 16px; background: #FDECEC; border: 1px solid #F3B9B9;
          color: #9B2C2C; padding: 10px 14px; border-radius: 8px; font-size: 13px;
          display: flex; align-items: center; gap: 8px;
        }

        .history-row {
          display: flex; justify-content: space-between; align-items: center; padding: 10px 0;
          border-bottom: 1px solid var(--border); font-size: 13.5px; gap: 10px;
        }
        .history-row:last-child { border-bottom: none; }
        .history-meta { font-family: 'JetBrains Mono', monospace; font-size: 11.5px; color: var(--ink-soft); }
        .pub-badge {
          font-family: 'JetBrains Mono', monospace; font-size: 10.5px; padding: 2px 7px; border-radius: 5px;
        }
        .pub-badge.draft { background: #F1F3F4; color: var(--ink-soft); }
        .pub-badge.published { background: #FCEED2; color: #8A5A00; }

        .empty-note { color: var(--ink-soft); font-size: 13.5px; }
      `}</style>

      <div className="header">
        <div className="brand">
          <div className="brand-mark">quicktechsolve<span>.engine</span></div>
          <div className="brand-sub">weekly SEO post generator</div>
        </div>
        <div className="status-chip">{queue.length} post{queue.length === 1 ? "" : "s"} in queue</div>
      </div>

      <div className="queue-strip">
        {weeks.map((d) => {
          const wk = weekKey(d);
          const saved = postForWeek(wk);
          return (
            <div
              key={wk}
              className={"week-pill" + (activeWeek === wk ? " active" : "")}
              onClick={() => {
                setActiveWeek(wk);
                setPost(null);
                setTopics([]);
                setSelectedTopic(null);
                setCustomTopic("");
                setError("");
              }}
            >
              <span className={"dot" + (saved ? saved.status === "published" ? " published" : " filled" : "")} />
              week of {weekLabel(d)}
            </div>
          );
        })}
      </div>

      {error && (
        <div className="error-box">
          <AlertCircle size={15} />
          {error}
        </div>
      )}

      {!displayed && (
        <div className="card">
          <div className="section-toggle" onClick={() => setSettingsOpen((o) => !o)}>
            <h3 className="card-title" style={{ marginBottom: 0 }}>
              <Radar size={16} color="var(--teal)" /> Trending research
              {trending && trending.generated_at && (
                <span className="history-meta" style={{ marginLeft: 4 }}>
                  · updated {new Date(trending.generated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
              )}
            </h3>
            <Settings size={15} />
          </div>

          {settingsOpen && (
            <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                type="text"
                style={{ flex: "1 1 140px" }}
                placeholder="GitHub username"
                value={repoConfig.owner}
                onChange={(e) => setRepoConfig((c) => ({ ...c, owner: e.target.value }))}
              />
              <input
                type="text"
                style={{ flex: "1 1 140px" }}
                placeholder="repo name"
                value={repoConfig.repo}
                onChange={(e) => setRepoConfig((c) => ({ ...c, repo: e.target.value }))}
              />
              <input
                type="text"
                style={{ flex: "0 1 90px" }}
                placeholder="branch"
                value={repoConfig.branch}
                onChange={(e) => setRepoConfig((c) => ({ ...c, branch: e.target.value }))}
              />
              <button
                className="btn"
                onClick={() => {
                  saveRepoConfig(repoConfig);
                  fetchTrending(repoConfig);
                }}
              >
                Save &amp; fetch
              </button>
            </div>
          )}

          {trendingError && (
            <div className="error-box" style={{ margin: "12px 0 0", maxWidth: "none" }}>
              <AlertCircle size={15} />
              {trendingError}
            </div>
          )}

          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn ghost" onClick={() => fetchTrending()} disabled={trendingLoading}>
              {trendingLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
              {trendingLoading ? "Fetching..." : "Refresh from GitHub"}
            </button>
            {["all", "reddit", "google_trends", "youtube", "twitter"].map((s) => (
              <button
                key={s}
                className="btn ghost"
                style={{
                  padding: "6px 12px",
                  background: activeSource === s ? "#E4F5F2" : "transparent",
                }}
                onClick={() => setActiveSource(s)}
              >
                {s === "all" ? "All sources" : SOURCE_LABEL[s]}
              </button>
            ))}
          </div>

          {trending && trendingItems.length > 0 ? (
            <div className="topic-list" style={{ marginTop: 14, maxHeight: 260, overflowY: "auto" }}>
              {trendingItems.slice(0, 25).map((it, i) => (
                <div
                  key={i}
                  className={"topic-item" + (customTopic === it.title ? " selected" : "")}
                  onClick={() => {
                    setCustomTopic(it.title);
                    setSelectedTopic(null);
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong>{it.title}</strong>
                    {it.url && (
                      <a
                        href={it.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        style={{ flexShrink: 0, color: "var(--ink-soft)" }}
                      >
                        <ExternalLink size={13} />
                      </a>
                    )}
                  </div>
                  <small>{SOURCE_LABEL[it.source] || it.source}{it.score != null ? ` · score ${it.score}` : ""}</small>
                </div>
              ))}
            </div>
          ) : (
            !trendingLoading &&
            !trendingError && (
              <div className="empty-note" style={{ marginTop: 12 }}>
                No trending data loaded yet. Set your repo above and click "Save &amp; fetch" — it reads the
                topics.json produced daily by the GitHub Actions collector.
              </div>
            )
          )}
        </div>
      )}

      {!displayed && (
        <div className="card">
          <h3 className="card-title"><Sparkles size={16} color="var(--teal)" /> Pick this week's topic</h3>
          <div className="row">
            <button className="btn" onClick={suggestTopics} disabled={loadingTopics}>
              {loadingTopics ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
              {loadingTopics ? "Thinking..." : trendingItems.length > 0 ? "Suggest 5 topics (from trends)" : "Suggest 5 topics"}
            </button>
          </div>

          {topics.length > 0 && (
            <div className="topic-list">
              {topics.map((t, i) => (
                <div
                  key={i}
                  className={"topic-item" + (selectedTopic === t.title ? " selected" : "")}
                  onClick={() => {
                    setSelectedTopic(t.title);
                    setCustomTopic("");
                  }}
                >
                  <strong>{t.title}</strong>
                  <small>{t.angle}</small>
                </div>
              ))}
            </div>
          )}

          <div className="divider-label">or write your own</div>
          <input
            type="text"
            placeholder="e.g. How to fix Windows Update stuck at 0%"
            value={customTopic}
            onChange={(e) => {
              setCustomTopic(e.target.value);
              setSelectedTopic(null);
            }}
          />

          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn" onClick={generatePost} disabled={loadingPost}>
              {loadingPost ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
              {loadingPost ? "Writing post..." : "Generate SEO post"}
            </button>
          </div>
        </div>
      )}

      {displayed && (
        <div className="card">
          <h3 className="card-title">
            <Sparkles size={16} color="var(--teal)" /> Week of {displayed.weekLabel}
          </h3>

          <Field label="Title" value={displayed.title} />
          <Field label="Meta description" value={displayed.metaDescription} />

          <div className="field">
            <div className="field-head">
              <span className="field-label">Slug</span>
              <CopyBtn text={displayed.slug} />
            </div>
            <div className="field-value mono">/{displayed.slug}</div>
          </div>

          <div className="field">
            <span className="field-label">Keywords</span>
            <div className="chips" style={{ marginTop: 6 }}>
              <span className="chip">focus: {displayed.focusKeyword}</span>
              {(displayed.secondaryKeywords || []).map((k, i) => (
                <span className="chip" key={i}>{k}</span>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="field-label">Outline</span>
            <ul className="outline-list">
              {(displayed.outline || []).map((o, i) => (
                <li key={i}>{o}</li>
              ))}
            </ul>
          </div>

          <div className="section-toggle" onClick={() => setContentOpen((o) => !o)}>
            <span className="field-label">Content ({displayed.estimatedWordCount || "?"} words)</span>
            {contentOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </div>
          {contentOpen && (
            <>
              <div className="content-body" style={{ marginTop: 10 }}>{displayed.content}</div>
              {(displayed.faq || []).length > 0 && (
                <div style={{ marginTop: 18 }}>
                  <div className="divider-label">FAQ</div>
                  {displayed.faq.map((f, i) => (
                    <div className="faq-item" key={i}>
                      <div className="faq-q">{f.q}</div>
                      <div className="faq-a">{f.a}</div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          <div className="row" style={{ marginTop: 18 }}>
            <CopyBtn
              label="Copy Markdown"
              text={`# ${displayed.title}\n\n${displayed.content}\n\n## FAQ\n\n${(displayed.faq || [])
                .map((f) => `**${f.q}**\n\n${f.a}`)
                .join("\n\n")}`}
            />
            <CopyBtn label="Copy HTML" text={mdToHtml(displayed.content)} />
            <button className="btn ghost" onClick={() => downloadMd(displayed)}>
              <FileDown size={13} /> Download .md
            </button>
            <button className="btn ghost" onClick={() => togglePublished(displayed.weekKey)}>
              {displayed.status === "published" ? "Mark as draft" : "Mark as published"}
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                setPost(null);
                setTopics([]);
                setSelectedTopic(null);
                setCustomTopic("");
              }}
            >
              <RefreshCw size={13} /> Start over for this week
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="section-toggle" onClick={() => setHistoryOpen((o) => !o)}>
          <h3 className="card-title" style={{ marginBottom: 0 }}>
            <Archive size={16} color="var(--teal)" /> History ({queue.length})
          </h3>
          {historyOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </div>
        {historyOpen && (
          <div style={{ marginTop: 14 }}>
            {!loadedQueue && <div className="empty-note">Loading...</div>}
            {loadedQueue && queue.length === 0 && (
              <div className="empty-note">Nothing generated yet — your weekly posts will collect here.</div>
            )}
            {queue
              .slice()
              .sort((a, b) => (a.weekKey < b.weekKey ? 1 : -1))
              .map((p) => (
                <div className="history-row" key={p.weekKey}>
                  <div>
                    <div>{p.title}</div>
                    <div className="history-meta">week of {p.weekLabel}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className={"pub-badge " + p.status}>{p.status}</span>
                    <button
                      className="btn ghost"
                      style={{ padding: "6px 10px" }}
                      onClick={() => {
                        setActiveWeek(p.weekKey);
                        setPost(p);
                      }}
                    >
                      Open
                    </button>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>

      <style>{`.spin { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
