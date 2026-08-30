# Changelog

## 0.1.0 (2026-08-29)

初始版本。

- **工具 `webfetch`**：读网页/头条文章全文，三级策略自动降级（直连 → Edge 常驻无头浏览器 CDP → dump-dom 兜底）
- 头条专项优化：质询页（安全验证/__ac_signature/acrawler）自动转浏览器渲染，1.2s reload 宽限窗，域名缓存，禁图 + 屏蔽字节跳动 CDN，复用常驻标签页
- `maxChars`（默认 12000，上限 60000）与 `outfile` 全文落盘；相对路径按 `workspace` 配置解析
- 失败以 { error } 形态返回；isConcurrencySafe: false 强制串行（CDP 单标签页）；timeoutMs: 120000
- **技能 `toutiao-reader`**：URL 形态、method 解读、质询处理、正文过短排查、常驻浏览器管理、网络环境经验、后备脚本路径
- 与工作区脚本 tools/webfetch.mjs 共享常驻浏览器（同名 pid/tab/profile 文件）
