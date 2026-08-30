/**
 * dsh-toutiao-reader — 把「浏览头条文章」的实战经验打包成 DSH 插件。
 *
 * Cordis 插件（inject + apply），提供两样东西：
 *   1. 工具 `webfetch`：读网页/头条文章全文，三级策略自动降级
 *      （直连 → Edge 常驻无头浏览器 CDP → dump-dom 兜底），自动识别头条反爬质询页。
 *      核心逻辑在 ./fetch.js（与工作区脚本 tools/webfetch.mjs 同源、共享常驻浏览器）。
 *   2. 技能 `toutiao-reader`：经验文档（URL 形态、method 字段解读、质询页处理、
 *      常驻浏览器管理、沙箱与代理注意事项、后备脚本路径），见 ../skills/toutiao-reader/SKILL.md。
 *
 * 契约：apply 里只做注册（注册随调用方 fiber 一并 dispose）；所有降级路径绝不抛出，
 * 不影响 dsh 主流程。工具抓取失败以 { error } 形态返回，不抛异常。
 *
 * @module dsh-toutiao-reader
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createFetcher } from './fetch.js'

/** Cordis 插件名（loader 注册用）。 */
export const name = 'dsh-toutiao-reader'

/** 需要解析的服务：工具注册表 + 技能注册表。 */
export const inject = ['tools', 'skills']

function numOr(v, d, max) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return d
  return max ? Math.min(n, max) : n
}
function strOr(v) {
  return typeof v === 'string' ? v.trim() : ''
}

/** 解析 outfile：绝对路径直用；相对路径仅在配置了 workspace 时相对它解析。 */
function resolveOutfile(outfile, workspace) {
  const p = strOr(outfile)
  if (!p) return null
  if (path.isAbsolute(p)) return p
  if (workspace) return path.join(workspace, p)
  throw new Error('相对 outfile 需要在插件配置里设置 workspace（本机为 D:/DSH_Workspace），或直接给绝对路径')
}

/** 安全取 hostname 供卡片标题用。 */
function hostOf(u) {
  try { return new URL(u).hostname } catch { return strOr(u).slice(0, 40) }
}

export function apply(ctx, config = {}) {
  const cfg = {
    cdpPort: numOr(config.cdpPort, 9333),
    browserPath: strOr(config.browserPath),
    maxChars: numOr(config.maxChars, 12000, 60000),
    workspace: strOr(config.workspace),
    domainCachePath: strOr(config.domainCachePath),
  }
  // cordis 的 ctx.logger 是可调用服务，.debug 依赖 fiber 上下文（this 绑定）；
  // 每次现取 ctx.logger，任何异常吞掉——日志丢失不影响主流程。
  const debug = (...args) => {
    try {
      const lg = ctx && ctx.logger
      if (lg && typeof lg.debug === 'function') lg.debug('[dsh-toutiao-reader]', ...args)
    } catch { /* 静默降级 */ }
  }
  const fetcher = createFetcher(cfg)

  // ---- 工具：webfetch ------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'webfetch',
    description:
      '读取网页/头条文章全文，返回 { method, title, text }。三级策略自动降级：' +
      '直连抓取 → Edge 常驻无头浏览器(CDP, 端口 9333) → dump-dom 兜底；' +
      '针对今日头条反爬已优化（安全验证/__ac_signature/acrawler 质询页自动转浏览器渲染，' +
      '禁图并屏蔽字节跳动 CDN 提速）。国内站直连可用，与工作区脚本 tools/webfetch.mjs 共享常驻浏览器。' +
      '用法：给文章 URL 即可；正文默认返回前 12000 字，长文可加大 maxChars（≤60000）或用 outfile 存盘。' +
      '搜索找线索用 web_search，读全文用本工具。',
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: '文章 URL（http/https）。头条如 https://www.toutiao.com/article/<id>/、m.toutiao.com 移动页或分享短链，302 自动跟随。',
      },
      maxChars: {
        type: 'number',
        description: '返回正文的最大字符数，默认 12000，上限 60000；超出部分截断并置 truncated=true。',
      },
      outfile: {
        type: 'string',
        description: '可选：把全文另存为文件（title+空行+正文）。绝对路径；或相对路径（需插件配置 workspace，本机 D:/DSH_Workspace）。工作区临时文件约定用下划线前缀，如 _toutiao-xxx.txt。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          method: { type: 'string', enum: ['direct-fetch', 'headless-cdp', 'headless-dumpdom'], description: '实际走的抓取通道' },
          title: { type: 'string', description: '文章标题' },
          text: { type: 'string', description: '正文纯文本（可能按 maxChars 截断）' },
          textLength: { type: 'number', description: '截断前的完整正文字符数' },
          truncated: { type: 'boolean', description: '正文是否被截断' },
          outfile: { type: 'string', description: '全文落盘路径（仅请求 outfile 时出现）' },
          error: { type: 'string', description: '失败原因（仅失败时出现）' },
        },
      },
      render: (_args, v) => {
        if (v.error) return [{ type: 'text', text: 'webfetch error: ' + v.error }]
        const len = v.textLength >= 1000 ? (v.textLength / 1000).toFixed(1) + 'k' : String(v.textLength)
        return [{
          type: 'text',
          text: v.method + ' · ' + v.title + ' · ' + len + ' 字' + (v.truncated ? '（截断）' : '') + (v.outfile ? ' · → ' + v.outfile : ''),
        }]
      },
    },
    timeoutMs: 120000, // 覆盖 CDP 冷启动(~20s) + 页面加载(≤30s) + dump-dom 兜底(≤40s)
    // CDP 阶段复用同一个常驻标签页，并发导航会互相踩踏——强制独占执行
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      try {
        const r = await fetcher.fetchArticle(args.url, { signal: exec && exec.signal, log: debug })
        const cap = numOr(args.maxChars, cfg.maxChars, 60000)
        const full = r.text || ''
        const text = full.slice(0, cap)
        const out = {
          method: r.method,
          title: r.title,
          text,
          textLength: full.length,
          truncated: full.length > text.length,
        }
        const dest = resolveOutfile(args.outfile, cfg.workspace)
        if (dest) {
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.writeFileSync(dest, r.title + '\n\n' + full, 'utf8')
          out.outfile = dest
        }
        return out
      } catch (e) {
        return { error: e && e.message ? e.message : String(e) }
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '读文章: ' + hostOf(args.url),
      kind: 'search',
      rawInput: args,
    }),
  }))

  // ---- 技能提供方：toutiao-reader（经验文档） -------------------------------
  // 与 dsh-media-skills 相同的 registerProvider 模式（本机已验证可用）。
  const PROVIDER_NAME = 'dsh-toutiao-reader'
  const SKILLS = [
    {
      name: 'toutiao-reader',
      description:
        '浏览今日头条文章与反爬网页的实战经验（配合 webfetch 工具）。当需要读取头条/微信/百家号等文章全文、' +
        'web_search 摘要不够用、抓取结果异常（安全验证/正文过短）需要排查、或要管理常驻无头浏览器（端口 9333）时使用。' +
        '包含头条 URL 形态、method 字段解读、质询页处理、沙箱与代理注意事项、工作区脚本后备路径。',
      body: new URL('../skills/toutiao-reader/SKILL.md', import.meta.url),
      resourceDir: '../skills/toutiao-reader/',
    },
  ].map((skill) => ({
    ...skill,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: {
      kind: 'directory',
      path: fileURLToPath(new URL(skill.resourceDir, import.meta.url)),
    },
    rank: 600,
    locator: skill.body,
  }))

  const provider = {
    name: PROVIDER_NAME,
    list: () => Promise.resolve(SKILLS),
    async get(candidate) {
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(candidate.locator, 'utf8')
      // 剥掉 YAML frontmatter，正文即纯指令
      const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
      return {
        name: candidate.name,
        description: candidate.description,
        invocation: candidate.invocation,
        provider: candidate.provider,
        source: candidate.source,
        resourceBase: candidate.resourceBase,
        content,
      }
    },
  }

  ctx.skills.registerProvider(() => provider)
}
