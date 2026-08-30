<p align="center"><img src="assets/banner.png" alt="dsh-toutiao-reader" width="640"></p>

# dsh-toutiao-reader

[中文](README.zh.md) | English

**Packaged real-world experience of reading Toutiao (今日头条) articles as a DeepSeek Harness (DSH) plugin**: a `webfetch` tool + a `toutiao-reader` skill.

```
model calls webfetch(url)
   ├─ ① direct-fetch        static direct ~1s (domain cache remembers which sites need a browser)
   ├─ ② resident Edge CDP   cold start ~20s once → resident on port 9333, then ~3-6s per fetch
   │     · reuses a persistent tab (saves ~4s)   · blocks images + ByteDance CDNs for speed
   │     · auto grace window for Toutiao challenge pages (安全验证/__ac_signature/acrawler)
   └─ ③ dump-dom fallback   one-shot render when CDP is unavailable
```

## Why

Toutiao's static HTML always trips its anti-bot layer (`__ac_nonce`/`__ac_signature`/`acrawler`) — a plain fetch gets a "security verification" page, and `web_search` only returns snippets. This plugin fills the gap: **give it an article URL, get back title + full plain text**. Tuned for Toutiao, and works for ordinary pages (blogs, news sites, anything reachable directly) too.

## What you get

### Tool: `webfetch`

| Arg | Type | Notes |
|---|---|---|
| `url` | string, required | Article URL (PC pages at `www.toutiao.com/article/<id>/` work best; mobile/share pages are usually App-interstitials with no article text) |
| `maxChars` | number | Cap on returned text, default 12000, max 60000; sets `truncated` when cut |
| `outfile` | string | Optional: save full text to a file (title + blank line + body); absolute path, or relative to the `workspace` config |

Returns `{ method, title, text, textLength, truncated, outfile?, error? }`

- Failures come back as `{ error }` instead of throwing — fetching never breaks the main flow
- Declares `isConcurrencySafe: false` (CDP reuses one tab, so calls are forced sequential) and `timeoutMs: 120000`
- The `method` field tells you which tier served the request

### Skill: `toutiao-reader`

A bundled experience doc (model-invocable): Toutiao URL forms, reading the `method` field, challenge-page handling and retry pacing, troubleshooting short/empty bodies (video pages, Q&A pages, App interstitials), managing the resident headless browser (port/pid/stop command), network-environment notes, and the fallback script path.

## Install

### Option 1: the plugin market (recommended)

DSH Web → Settings → **Plugin Market** → search "toutiao" → install.

### Option 2: CLI

```sh
dsh plugin --profile web add dsh-toutiao-reader
```

### Option 3: manual (local development)

```powershell
# junction into the profile (no admin needed)
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-toutiao-reader" -Target "<plugin dir>"
# profile package.json: add "dsh-toutiao-reader": "link:<plugin dir>" to dependencies and "dsh-toutiao-reader" to dsh.profile.bundles
```

Restart dsh web to load. **Never run pnpm install inside the profile** (it duplicates official packages as physical copies).

## Configuration

Use the **id-override mode** in the profile's `cordis.patch.yml` (id only — never re-insert):

```yaml
- id: dsh-toutiao-reader
  config:
    workspace: D:/DSH_Workspace  # base for relative outfile paths
    cdpPort: 9333                # CDP debugging port
    browserPath: ""              # Edge/Chrome override; empty = auto-detect
    maxChars: 12000              # default text cap
    domainCachePath: ""          # domain cache path; empty = %TEMP%/webfetch-domains.json
```

## FAQ

**Slow fetches?** The first cold start of the resident browser takes ~20s; afterwards ~3-6s per fetch. Image blocking and ByteDance CDN filtering in the CDP tier are intentional speedups.

**Very short or empty text?** Usually a video page, Q&A page, or App interstitial (mobile share pages carry only ~40 chars of promo text in practice). Switch to the **PC URL** (`www.toutiao.com/article/<id>/`).

**Stuck in a challenge loop?** Wait a few seconds and retry once; avoid hammering (stricter risk control). Solved domains are remembered by the domain cache.

**Browser in a bad state?** Read `%TEMP%\webfetch-edge.pid`, then `taskkill /PID <pid> /T /F`; the next call cold-starts a fresh one.

**Already using a script?** The plugin **shares the resident browser and tab** with the workspace script `node tools/webfetch.mjs <url> [outfile]` (same pid/tab/profile files) — they accelerate each other; the script is the fallback path when the plugin is unavailable.

## Security & privacy

- Read-only fetching: writes nothing (unless you pass `outfile`), reads no credentials, phones nowhere
- The resident headless browser listens on localhost only (127.0.0.1)
- The domain cache stores a single string per domain (whether the site needs a browser) — no content is recorded

## Compatibility

- Requires local Edge or Chrome (auto-detected; override with `browserPath`)
- Node.js ≥ 20 (global fetch / WebSocket / AbortSignal.any); tested on DSH web 0.1.0-rc.6+

## License

[MIT](LICENSE)
