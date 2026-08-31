/**
 * QuickTechSolve — Content Engine
 * ---------------------------------------------------------------
 * Weekly SEO blog post generator with:
 *  - Research-grounded generation (live web search before writing)
 *  - Multi-provider AI (Claude / Gemini / Groq, switchable + own API keys)
 *  - Trending topic research (Reddit, Hacker News, Google Trends, YouTube,
 *    Twitter/X via the companion daily-topics GitHub Action)
 *  - WordPress-ready export (HTML, excerpt, category, tags, featured image,
 *    focus keyword, FAQ schema-ready Q&A)
 *  - Humanize + AI-detection self-check pass
 *  - Persistent weekly queue + history (window.storage)
 *
 * See README.md in the repo root for full setup instructions.
 * v1.0 — final consolidated build
 * ---------------------------------------------------------------
 */
import React, { useState, useEffect, useCallback } from "react";
import { Sparkles, Copy, Check, Loader2, ChevronDown, ChevronUp, RefreshCw, FileDown, Archive, AlertCircle, Settings, ExternalLink, Radar } from "lucide-react";

const SOURCE_LABEL = {
  reddit: "Reddit",
  hackernews: "Hacker News",
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

async function callClaude(prompt, maxTokens = 4096, useSearch = false) {
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (useSearch) {
    body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Request failed (" + res.status + ")");
  const data = await res.json();
  const text = (data.content || [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();
  // Collect the actual pages Claude looked at, for a "sources" trail —
  // separate from whatever the model itself reports in its JSON answer.
  const citedUrls = [];
  (data.content || []).forEach((b) => {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      b.content.forEach((r) => {
        if (r.url) citedUrls.push({ title: r.title || r.url, url: r.url });
      });
    }
  });
  return { text, sources: citedUrls };
}

async function callGemini(prompt, maxTokens, apiKey, useSearch = false) {
  if (!apiKey) throw new Error("No Gemini API key set");
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (useSearch) {
    body.tools = [{ google_search: {} }];
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error("Gemini request failed (" + res.status + ")");
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") || "";
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = chunks
    .map((c) => (c.web ? { title: c.web.title || c.web.uri, url: c.web.uri } : null))
    .filter(Boolean);
  return { text: text.trim(), sources };
}

async function callGroq(prompt, maxTokens, apiKey) {
  if (!apiKey) throw new Error("No Groq API key set");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error("Groq request failed (" + res.status + ")");
  const data = await res.json();
  // Groq/Llama has no built-in web search grounding — always returns
  // text-only with no sources, regardless of the useSearch flag.
  return { text: (data?.choices?.[0]?.message?.content || "").trim(), sources: [] };
}

// Single entry point every generation call goes through — dispatches to
// whichever provider is currently selected. Claude needs no key (Claude.ai
// covers that call); Gemini/Groq require the user's own key. When useSearch
// is true and the provider supports it, the model researches the topic via
// live web search before answering, instead of writing from memory alone.
// Returns { text, sources } — sources is [] when grounding wasn't used/available.
async function callAI(prompt, maxTokens, providerConfig, useSearch = false) {
  const { provider, geminiKey, groqKey } = providerConfig || { provider: "claude" };
  if (provider === "gemini") return callGemini(prompt, maxTokens, geminiKey, useSearch);
  if (provider === "groq") return callGroq(prompt, maxTokens, groqKey);
  return callClaude(prompt, maxTokens, useSearch);
}

// Artifacts can't fetch arbitrary external domains directly from the browser
// (sandbox blocks it) — so this routes the fetch through Anthropic's own
// server-side web_fetch tool, which runs on Anthropic's servers, not in-browser.
async function fetchUrlViaClaude(url) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-beta": "web-fetch-2025-09-10",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `Fetch this exact URL: ${url}\n\nReturn ONLY the raw file content verbatim — no markdown code fences, no commentary, no explanation before or after. If the URL can't be fetched (e.g. 404), respond with exactly: FETCH_ERROR`,
        },
      ],
      tools: [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 2 }],
    }),
  });
  if (!res.ok) throw new Error("Request failed (" + res.status + ")");
  const data = await res.json();
  const text = (data.content || [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();
  if (!text || text.startsWith("FETCH_ERROR")) throw new Error("not accessible");
  return text;
}

function parseJSON(text) {
  let cleaned = text.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Model sometimes adds stray prose before/after the JSON despite
    // instructions — fall back to grabbing the outermost {...} block.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw e;
  }
}

function mdToHtml(md) {
  if (!md) return "";
  let html = md
    .replace(/^### (.*$)/gim, "<h3>$1</h3>")
    .replace(/^## (.*$)/gim, "<h2>$1</h2>")
    .replace(/^# (.*$)/gim, "<h2>$1</h2>")
    .replace(/\*\*(.*?)\*\*/gim, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/gim, "<em>$1</em>")
    .replace(/^\s*\d+\.\s+(.*$)/gim, "OL_ITEM::$1")
    .replace(/^\s*-\s+(.*$)/gim, "<li>$1</li>");
  // ordered lists
  html = html.replace(/(OL_ITEM::.*(\n|$))+/gim, (m) => {
    const items = m
      .trim()
      .split("\n")
      .map((l) => `<li>${l.replace("OL_ITEM::", "")}</li>`)
      .join("");
    return `<ol>${items}</ol>`;
  });
  // unordered lists
  html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/gim, (m) =>
    m.includes("<ol>") ? m : "<ul>" + m + "</ul>"
  );
  html = html
    .split(/\n{2,}/)
    .map((block) =>
      /^\s*<(h2|h3|ul|ol)/.test(block.trim()) ? block : block.trim() ? `<p>${block.trim()}</p>` : ""
    )
    .join("\n");
  return html;
}

function buildWordPressHtml(record) {
  const bodyHtml = mdToHtml(record.content);
  const faqHtml = (record.faq || [])
    .map((f) => `<h3>${f.q}</h3>\n<p>${f.a}</p>`)
    .join("\n");
  return [
    `<!-- Paste everything below into the WordPress editor's "Code editor" / HTML view -->`,
    bodyHtml,
    faqHtml ? `<h2>Frequently Asked Questions</h2>\n${faqHtml}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
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

  // AI provider selection — Claude works with no key (Claude.ai covers it);
  // Gemini/Groq need the user's own key. Keys stay in personal (non-shared)
  // storage, never sent anywhere except directly to that provider's API.
  const [providerConfig, setProviderConfig] = useState({ provider: "claude", geminiKey: "", groqKey: "" });
  const [providerOpen, setProviderOpen] = useState(false);

  const [humanizing, setHumanizing] = useState(false);
  const [checkingHuman, setCheckingHuman] = useState(false);
  const [humanCheck, setHumanCheck] = useState(null);
  const [humanCheckOpen, setHumanCheckOpen] = useState(true);

  // trending research (GitHub Actions daily collector output)
  const [repoConfig, setRepoConfig] = useState({ owner: "", repo: "", branch: "main" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trending, setTrending] = useState(null);
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [trendingError, setTrendingError] = useState("");
  const [activeSource, setActiveSource] = useState("all");
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState("");

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
      try {
        const pc = await window.storage.get("qts_provider_config", false);
        if (pc && pc.value) setProviderConfig(JSON.parse(pc.value));
      } catch (e) {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveProviderConfig = useCallback(async (cfg) => {
    setProviderConfig(cfg);
    try {
      await window.storage.set("qts_provider_config", JSON.stringify(cfg), false);
    } catch (e) {}
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
      const text = await fetchUrlViaClaude(url);
      const data = JSON.parse(text.replace(/^```(json)?/i, "").replace(/```$/, "").trim());
      setTrending(data);
      try {
        await window.storage.set("qts_trending_cache", JSON.stringify(data), false);
      } catch (e) {}
    } catch (e) {
      setTrendingError(
        "Couldn't load topics.json yet. Either the daily-topics workflow hasn't produced that file at the repo root, or the repo/branch name is off. Double-check the exact filename and that it's committed to the branch shown."
      );
    } finally {
      setTrendingLoading(false);
    }
  }

  async function importPastedTopics() {
    setPasteError("");
    try {
      const data = JSON.parse(pasteText.trim());
      setTrending(data);
      try {
        await window.storage.set("qts_trending_cache", JSON.stringify(data), false);
      } catch (e) {}
      setPasteMode(false);
      setPasteText("");
    } catch (e) {
      setPasteError("That doesn't look like valid JSON — make sure you copied the whole file, starting with { and ending with }.");
    }
  }

  const trendingItems = trending
    ? ["reddit", "hackernews", "google_trends", "youtube", "twitter"]
        .filter((s) => activeSource === "all" || activeSource === s)
        .flatMap((s) => (trending[s] || []))
    : [];

  const postForWeek = (wk) => queue.find((p) => p.weekKey === wk);
  const currentSaved = postForWeek(activeWeek);

  function providerKeyMissing() {
    if (providerConfig.provider === "gemini" && !providerConfig.geminiKey) return "Add your Gemini API key in AI Provider settings first.";
    if (providerConfig.provider === "groq" && !providerConfig.groqKey) return "Add your Groq API key in AI Provider settings first.";
    return null;
  }

  async function suggestTopics() {
    const missing = providerKeyMissing();
    if (missing) {
      setError(missing);
      setProviderOpen(true);
      return;
    }
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
      const { text } = await callAI(prompt, 1200, providerConfig, true);
      const parsed = parseJSON(text);
      setTopics(parsed.topics || []);
    } catch (e) {
      setError(`Couldn't fetch topic ideas: ${e.message || e}`);
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
    const missing = providerKeyMissing();
    if (missing) {
      setError(missing);
      setProviderOpen(true);
      return;
    }
    setLoadingPost(true);
    setError("");
    setPost(null);
    try {
      const prompt = `You are an SEO content writer and researcher for QuickTechSolve (quicktechsolve.com), a friendly, plain-English tech help and updates blog for non-technical readers.

Before writing, research this topic using web search: "${topic}". Look for the current official version numbers, exact menu paths/UI labels, recent known issues, and any official support documentation relevant right now. Do not rely on memory alone for anything that could have changed — verify it.

Then write a complete, publish-ready, SEO-friendly blog post grounded in what you found.

Requirements:
- Title: 50-60 characters, includes the focus keyword naturally, written to earn clicks in search results.
- Meta description: 150-160 characters, includes the focus keyword, states the concrete benefit/fix.
- Excerpt: 1-2 plain-text sentences (25-35 words) for the WordPress post excerpt field — a hook, not a repeat of the meta description.
- URL slug: lowercase, hyphenated, short, keyword-focused.
- Category: ONE WordPress category this post belongs to, picked from: Windows, Mac, Android, iPhone & iOS, Browsers & Apps, Security & Privacy, Tech News & Updates. Pick the single best fit.
- Tags: 5-8 lowercase WordPress tags (short phrases, no hashtags).
- Featured image: an object with "description" (what the featured image should show, plain description for a photographer or stock search) and "altText" (a concise, keyword-aware alt attribute for accessibility/SEO).
- One clear focus keyword and 4-6 relevant secondary keywords/phrases, worked in naturally rather than stuffed.
- Outline: the H2/H3 heading structure as a flat list of strings like "H2: ..." / "H3: ...".
- Content: 800-1100 words in Markdown using ## for H2 and ### for H3, short paragraphs, at least one bulleted or numbered list, written in plain, step-by-step, non-jargon language for everyday readers. Work the focus keyword naturally into the first 100 words. Open with the reader's problem, close with a short wrap-up. Every instruction/step must reflect what you actually found in research (exact current menu names, version numbers, dated context) rather than generic or possibly-outdated advice. If something is genuinely still uncertain after research, say so plainly instead of guessing. Do not include the title as an H1 inside the content.
- FAQ: 3 short question/answer pairs suited for an FAQ schema block, using real questions people search, answered using your research.
- internalLinkIdeas: 2-3 short phrases describing other QuickTechSolve articles this post should link to once they exist (e.g. "how to check for Windows updates manually") — placeholders for future internal linking, not fabricated URLs.
- researchNotes: 1-2 sentences on what you actually verified or found during research (e.g. "confirmed current Windows 11 24H2 update path as of search results").
- estimatedWordCount: integer.

Respond with ONLY raw JSON, no markdown fences, no preamble, in this exact shape:
{"title":"","metaDescription":"","excerpt":"","slug":"","category":"","tags":["",""],"featuredImage":{"description":"","altText":""},"focusKeyword":"","secondaryKeywords":["",""],"outline":["H2: ...","H3: ..."],"content":"markdown string","faq":[{"q":"","a":""}],"internalLinkIdeas":["",""],"researchNotes":"","estimatedWordCount":0}`;
      const { text, sources } = await callAI(prompt, 8192, providerConfig, true);
      const parsed = parseJSON(text);
      const record = {
        weekKey: activeWeek,
        weekLabel: weekLabel(new Date(activeWeek)),
        topic,
        status: "draft",
        createdAt: new Date().toISOString(),
        sources: sources || [],
        ...parsed,
      };
      setPost(record);
      const next = [record, ...queue.filter((p) => p.weekKey !== activeWeek)];
      persist(next);
    } catch (e) {
      setError(`Couldn't generate the post: ${e.message || e}`);
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

  function updateRecordInPlace(wk, patch) {
    const next = queue.map((p) => (p.weekKey === wk ? { ...p, ...patch } : p));
    persist(next);
    const updated = next.find((p) => p.weekKey === wk);
    if (updated) setPost(updated);
    return updated;
  }

  async function humanizePost() {
    if (!displayed) return;
    const missing = providerKeyMissing();
    if (missing) {
      setError(missing);
      setProviderOpen(true);
      return;
    }
    setHumanizing(true);
    setError("");
    try {
      const prompt = `Rewrite the following blog post content so it reads like it was written by a real person, not an AI. Keep every fact, step, and instruction exactly the same — only change the writing itself.

What to fix:
- Vary sentence length — mix short punchy sentences with longer ones, avoid uniform rhythm
- Cut AI-sounding filler phrases ("in today's digital world", "it's important to note", "in conclusion", "let's dive in", "navigate the landscape of")
- Use natural contractions and a conversational tone where it fits, without becoming sloppy
- Avoid overly symmetrical lists and formulaic transitions ("firstly... secondly... finally")
- Keep the Markdown structure (## and ### headers, lists) exactly as-is — only rewrite the prose inside it
- Do not add new claims, statistics, or facts that weren't already there

Content to rewrite:
${displayed.content}

Respond with ONLY the rewritten Markdown content — no commentary, no preamble, no code fences.`;
      const { text } = await callAI(prompt, 4096, providerConfig);
      const cleaned = text.replace(/^```(markdown|md)?/i, "").replace(/```$/, "").trim();
      updateRecordInPlace(displayed.weekKey, { content: cleaned, humanizedAt: new Date().toISOString() });
      setHumanCheck(null);
    } catch (e) {
      setError(`Couldn't humanize the post: ${e.message || e}`);
    } finally {
      setHumanizing(false);
    }
  }

  async function checkHumanizer() {
    if (!displayed) return;
    const missing = providerKeyMissing();
    if (missing) {
      setError(missing);
      setProviderOpen(true);
      return;
    }
    setCheckingHuman(true);
    setError("");
    try {
      const prompt = `Assess how likely the following blog post content is to be flagged as AI-generated by a human reader or a basic AI-detection tool. This is a self-assessment for editing purposes, not a certified detector result.

Content:
${displayed.content}

Respond with ONLY raw JSON, no markdown fences, no preamble, in this exact shape:
{"risk":"Low|Medium|High","summary":"one sentence overall verdict","flaggedPhrases":["exact short phrase from the text that reads as AI-generated", "..."],"suggestions":["short actionable fix", "..."]}

Include at most 6 flaggedPhrases and 4 suggestions. If the writing already reads naturally, say so and return empty arrays.`;
      const { text } = await callAI(prompt, 2000, providerConfig);
      const parsed = parseJSON(text);
      setHumanCheck(parsed);
      setHumanCheckOpen(true);
    } catch (e) {
      setError(`Couldn't run the humanizer check: ${e.message || e}`);
    } finally {
      setCheckingHuman(false);
    }
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

  function downloadWpHtml(record) {
    const html = `<!doctype html>
<!--
Title: ${record.title}
Excerpt: ${record.excerpt || ""}
Category: ${record.category || ""}
Tags: ${(record.tags || []).join(", ")}
Featured image: ${record.featuredImage ? record.featuredImage.description : ""}
Featured image alt: ${record.featuredImage ? record.featuredImage.altText : ""}
Meta description: ${record.metaDescription || ""}
Focus keyword: ${record.focusKeyword || ""}

Paste the HTML below into WordPress: open the post, use the ⋮ menu → "Code editor"
(or Ctrl/Cmd+Shift+Alt+M in the block editor), paste, then switch back to the visual editor.
-->
${buildWordPressHtml(record)}
`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${record.slug || "post"}-wordpress.html`;
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
          <div className="section-toggle" onClick={() => setProviderOpen((o) => !o)}>
            <h3 className="card-title" style={{ marginBottom: 0 }}>
              <Sparkles size={16} color="var(--teal)" /> AI Provider
              <span className="history-meta" style={{ marginLeft: 4, textTransform: "capitalize" }}>
                · {providerConfig.provider}
              </span>
            </h3>
            <Settings size={15} />
          </div>

          {providerOpen && (
            <div style={{ marginTop: 14 }}>
              <span className="field-label">Provider</span>
              <select
                value={providerConfig.provider}
                onChange={(e) => saveProviderConfig({ ...providerConfig, provider: e.target.value })}
                style={{
                  width: "100%",
                  marginTop: 6,
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 13.5,
                  background: "#FAFBFB",
                }}
              >
                <option value="claude">Claude (default — no key needed here)</option>
                <option value="gemini">Google Gemini 2.5 Flash (needs your API key)</option>
                <option value="groq">Groq / Llama 3.3 (needs your API key)</option>
              </select>

              {providerConfig.provider === "gemini" && (
                <div style={{ marginTop: 10 }}>
                  <span className="field-label">Gemini API key</span>
                  <input
                    type="text"
                    style={{ marginTop: 6 }}
                    placeholder="Paste your Gemini API key"
                    value={providerConfig.geminiKey}
                    onChange={(e) => setProviderConfig((c) => ({ ...c, geminiKey: e.target.value }))}
                  />
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="btn" onClick={() => saveProviderConfig(providerConfig)}>
                      Save key
                    </button>
                  </div>
                  <div className="empty-note" style={{ marginTop: 6 }}>
                    Free from Google AI Studio — 500 requests/day, no credit card needed.
                  </div>
                </div>
              )}

              {providerConfig.provider === "groq" && (
                <div style={{ marginTop: 10 }}>
                  <span className="field-label">Groq API key</span>
                  <input
                    type="text"
                    style={{ marginTop: 6 }}
                    placeholder="Paste your Groq API key"
                    value={providerConfig.groqKey}
                    onChange={(e) => setProviderConfig((c) => ({ ...c, groqKey: e.target.value }))}
                  />
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="btn" onClick={() => saveProviderConfig(providerConfig)}>
                      Save key
                    </button>
                  </div>
                  <div className="empty-note" style={{ marginTop: 6 }}>
                    Free tier at console.groq.com — fast inference, no credit card needed.
                  </div>
                </div>
              )}

              {providerConfig.provider !== "claude" && (
                <div className="empty-note" style={{ marginTop: 10 }}>
                  Keys are stored only in this tool's own storage and sent directly to that provider — never
                  shared elsewhere. Note: this call may not reach external providers while running inside the
                  Claude.ai preview sandbox; it's built for the standalone deployed version.
                </div>
              )}
            </div>
          )}
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
            {["all", "reddit", "hackernews", "google_trends", "youtube", "twitter"].map((s) => (
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
            <button className="btn ghost" onClick={() => setPasteMode((o) => !o)}>
              {pasteMode ? "Cancel paste" : "Paste topics.json instead"}
            </button>
          </div>

          {pasteMode && (
            <div style={{ marginTop: 12 }}>
              <div className="empty-note" style={{ marginBottom: 8 }}>
                Open{" "}
                <span className="mono" style={{ fontSize: 12 }}>
                  raw.githubusercontent.com/{repoConfig.owner || "<user>"}/{repoConfig.repo || "<repo>"}/{repoConfig.branch || "main"}/topics.json
                </span>{" "}
                in your browser, select all, copy, then paste the JSON below.
              </div>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder='{"generated_at": "...", "reddit": [...], ...}'
                style={{
                  width: "100%",
                  minHeight: 120,
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12,
                  background: "#FAFBFB",
                }}
              />
              {pasteError && (
                <div className="error-box" style={{ margin: "8px 0 0", maxWidth: "none" }}>
                  <AlertCircle size={15} />
                  {pasteError}
                </div>
              )}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn" onClick={importPastedTopics} disabled={!pasteText.trim()}>
                  Import pasted JSON
                </button>
              </div>
            </div>
          )}

          {trending && trending._errors && (
            <div className="empty-note" style={{ marginTop: 12 }}>
              <strong style={{ display: "block", marginBottom: 4 }}>Some sources had issues:</strong>
              {Object.entries(trending._errors).map(([src, msgs]) => (
                <div key={src} style={{ marginBottom: 4 }}>
                  <span className="chip">{SOURCE_LABEL[src] || src}</span>{" "}
                  {Array.isArray(msgs) ? msgs[0] : msgs}
                </div>
              ))}
            </div>
          )}

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
              {loadingPost ? "Researching & writing..." : "Generate SEO post"}
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
          <Field label="Excerpt" value={displayed.excerpt} />
          <Field label="Meta description" value={displayed.metaDescription} />

          <div className="field">
            <div className="field-head">
              <span className="field-label">Slug</span>
              <CopyBtn text={displayed.slug} />
            </div>
            <div className="field-value mono">/{displayed.slug}</div>
          </div>

          <div className="row" style={{ marginBottom: 14 }}>
            <div className="field" style={{ flex: 1, marginBottom: 0 }}>
              <div className="field-head">
                <span className="field-label">Category</span>
                <CopyBtn text={displayed.category} />
              </div>
              <div className="field-value">{displayed.category}</div>
            </div>
          </div>

          <div className="field">
            <div className="field-head">
              <span className="field-label">Tags</span>
              <CopyBtn text={(displayed.tags || []).join(", ")} label="Copy all" />
            </div>
            <div className="chips" style={{ marginTop: 6 }}>
              {(displayed.tags || []).map((t, i) => (
                <span className="chip" key={i}>{t}</span>
              ))}
            </div>
          </div>

          {displayed.featuredImage && (
            <div className="field">
              <span className="field-label">Featured image</span>
              <div className="field-value" style={{ marginTop: 4 }}>{displayed.featuredImage.description}</div>
              <div className="field-head" style={{ marginTop: 8 }}>
                <span className="field-label">Alt text</span>
                <CopyBtn text={displayed.featuredImage.altText} />
              </div>
              <div className="field-value mono">{displayed.featuredImage.altText}</div>
            </div>
          )}

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

          {(displayed.internalLinkIdeas || []).length > 0 && (
            <div className="field">
              <span className="field-label">Internal link ideas (for future posts)</span>
              <div className="chips" style={{ marginTop: 6 }}>
                {displayed.internalLinkIdeas.map((l, i) => (
                  <span className="chip" key={i}>{l}</span>
                ))}
              </div>
            </div>
          )}

          {displayed.researchNotes && (
            <div className="field">
              <span className="field-label">Research notes</span>
              <div className="field-value" style={{ marginTop: 4, fontStyle: "italic", color: "var(--ink-soft)" }}>
                {displayed.researchNotes}
              </div>
            </div>
          )}

          {(displayed.sources || []).length > 0 && (
            <div className="field">
              <span className="field-label">Sources checked while researching</span>
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                {displayed.sources.slice(0, 8).map((s, i) => (
                  <a
                    key={i}
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 12.5, color: "var(--teal-deep)", display: "flex", alignItems: "center", gap: 5 }}
                  >
                    <ExternalLink size={12} style={{ flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

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
            <button className="btn" onClick={humanizePost} disabled={humanizing}>
              {humanizing ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
              {humanizing ? "Rewriting..." : "Humanize post"}
            </button>
            <button className="btn ghost" onClick={checkHumanizer} disabled={checkingHuman}>
              {checkingHuman ? <Loader2 size={14} className="spin" /> : <Radar size={14} />}
              {checkingHuman ? "Checking..." : "Check AI-detection risk"}
            </button>
            {displayed.humanizedAt && (
              <span className="history-meta" style={{ alignSelf: "center" }}>
                humanized {new Date(displayed.humanizedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
              </span>
            )}
          </div>

          {humanCheck && (
            <div className="card" style={{ margin: "12px 0 0", padding: 16, background: "#FAFBFB" }}>
              <div className="section-toggle" onClick={() => setHumanCheckOpen((o) => !o)}>
                <span className="field-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  Humanizer check ·{" "}
                  <span
                    className="pub-badge"
                    style={{
                      background:
                        humanCheck.risk === "High" ? "#FDECEC" : humanCheck.risk === "Medium" ? "#FCEED2" : "#E4F5F2",
                      color:
                        humanCheck.risk === "High" ? "#9B2C2C" : humanCheck.risk === "Medium" ? "#8A5A00" : "var(--teal-deep)",
                    }}
                  >
                    {humanCheck.risk || "?"} risk
                  </span>
                </span>
                {humanCheckOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </div>
              {humanCheckOpen && (
                <div style={{ marginTop: 10 }}>
                  <div className="field-value" style={{ marginBottom: 10 }}>{humanCheck.summary}</div>
                  {(humanCheck.flaggedPhrases || []).length > 0 && (
                    <div style={{ marginBottom: 10 }}>
                      <span className="field-label">Phrases that read as AI-generated</span>
                      <div className="chips" style={{ marginTop: 6 }}>
                        {humanCheck.flaggedPhrases.map((p, i) => (
                          <span className="chip" key={i}>{p}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {(humanCheck.suggestions || []).length > 0 && (
                    <div>
                      <span className="field-label">Suggestions</span>
                      <ul className="outline-list">
                        {humanCheck.suggestions.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="empty-note" style={{ marginTop: 10 }}>
                    This is the model's own self-assessment, not a certified AI-detection tool — treat it as an
                    editing prompt, not a guarantee.
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="row" style={{ marginTop: 12 }}>
            <CopyBtn label="Copy WordPress HTML" text={buildWordPressHtml(displayed)} />
            <CopyBtn
              label="Copy Markdown"
              text={`# ${displayed.title}\n\n${displayed.content}\n\n## FAQ\n\n${(displayed.faq || [])
                .map((f) => `**${f.q}**\n\n${f.a}`)
                .join("\n\n")}`}
            />
            <button className="btn ghost" onClick={() => downloadWpHtml(displayed)}>
              <FileDown size={13} /> Download WP .html
            </button>
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
          <div className="empty-note" style={{ marginTop: 10 }}>
            In WordPress: paste the WordPress HTML into the post's Code editor view (⋮ menu → Code editor,
            or Ctrl/Cmd+Shift+Alt+M in the block editor), then set the excerpt, category, tags, and featured
            image using the fields above.
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
