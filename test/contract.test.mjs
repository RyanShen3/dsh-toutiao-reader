// 契约测试：模拟 cordis ctx 验证插件 apply 契约；不抓真实网络（抓取路径由 fetchArticle 单测覆盖）
const reg = { tools: [], providers: [] }
const ctx = {
  tools: { register: (d) => reg.tools.push(d) },
  skills: { registerProvider: (f) => reg.providers.push(f()) },
  logger: { debug: () => {} },
}
const mod = await import('../lib/index.js')
if (mod.name !== 'dsh-toutiao-reader') throw new Error('name 不符')
if (!JSON.stringify(mod.inject).includes('tools') || !JSON.stringify(mod.inject).includes('skills')) throw new Error('inject 不符')
mod.apply(ctx, { workspace: 'D:/DSH_Workspace' })
if (reg.tools.length !== 1 || reg.tools[0].name !== 'webfetch') throw new Error('webfetch 工具未注册')
const tool = reg.tools[0]
if (tool.timeoutMs !== 120000) throw new Error('timeoutMs 不符')
const list = await reg.providers[0].list()
if (list.length !== 1 || list[0].name !== 'toutiao-reader') throw new Error('技能未注册')
const sk = await reg.providers[0].get(list[0])
if (sk.content.startsWith('---')) throw new Error('frontmatter 未剥离')
if (!sk.content.includes('浏览头条文章')) throw new Error('技能正文异常')
// 非法 URL 错误形态（不触发网络）
const bad = await tool.execute({ url: 'ftp://x' }, { signal: undefined })
if (!bad.error || !bad.error.includes('http')) throw new Error('错误形态不符: ' + JSON.stringify(bad))
console.log('contract test OK: tools=[' + reg.tools.map(t => t.name) + '] skills=[' + list.map(s => s.name) + ']')
