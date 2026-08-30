---
name: toutiao-reader
description: "浏览今日头条文章与反爬网页的实战经验（配合 webfetch 工具）。需要读取头条/微信/百家号等文章全文、web_search 摘要不够用、抓取结果异常（安全验证/正文过短）需要排查、或管理常驻无头浏览器（端口 9333）时使用。包含头条 URL 形态、method 字段解读、质询页处理、沙箱与代理注意事项、工作区脚本后备路径。"
---

# 浏览头条文章经验（toutiao-reader）

本技能沉淀「用 DSH 读今日头条文章」的完整实战经验。核心工具是插件提供的 `webfetch`（优先直接调用）；本文件讲什么时候用、怎么解读结果、出问题怎么排查。

## 工具分工

- **找线索/摘要/新闻事实** → `web_search`
- **读某篇文章的全文** → `webfetch`（本插件，给 URL 即可）
- 两者互补：先 search 定位文章 URL，再 webfetch 读全文；不要用 search 的摘要冒充全文。

## 头条 URL 形态（都已支持）

| 形态 | 例子 | 说明 |
|---|---|---|
| PC 文章页 | `https://www.toutiao.com/article/7277868520720073231/` | 标准形态，wid 参数可留可去 |
| 移动/分享页 | `https://m.toutiao.com/article/7535253846747890217/` | 实测多为 App 引导页（正文仅 ~40 字），**优先换 PC 链接** |
| 分享短链 | `https://m.toutiao.com/is/xxxx/` | 302 到文章页，工具自动跟随 |

## 三级策略（自动进行，无需干预）

`webfetch` 返回的 `method` 字段说明走了哪条路：

- `direct-fetch`：静态直连，最快（~1s）。首次遇到新域名会试探；若 HTML 像质询页，会记住「该域走浏览器」，下次直接跳过试探。
- `headless-cdp`：Edge 常驻无头浏览器渲染（**头条默认走这条**，因为头条静态页必命中反爬）。首次冷启动 ~20s，之后常驻端口 9333，单次抓取 ~3-6s。已禁图并屏蔽字节跳动 CDN（pstatp/byteimg/snssdk）——禁这些是为了提速，不是异常。
- `headless-dumpdom`：CDP 不可用时的一次性兜底渲染，最慢但保底。

## 反爬与质询页

头条识别到自动化会出「安全验证/滑动验证」，HTML 特征：`__ac_nonce`、`__ac_signature`、`acrawler`。插件自动识别并转浏览器渲染，且首见域名保留 1.2s 宽限窗口等页面 reload 后再取正文；同一域名解过一次会记住（domain cache），后续跳过宽限等待。

仍失败时：**等几秒重试一次**即可；不要连续高频重试（会触发更严的风控）。

## 结果解读

- **正文 <100 字或为空**：多半是视频页/问答页/需要登录，如实告诉用户「该页没有文字正文」，不要编造。
- **`truncated: true`**：正文按 maxChars（默认 12000）截断了。需要全文时加大 maxChars（≤60000），或传 outfile 存盘后用 read 工具分段读。
- **`error: 三级策略均未取到正文`**：视频页或登录墙；换该文章的 **PC 版链接**（www.toutiao.com/article/<id>/）通常可解。

## 常驻无头浏览器管理

- 端口 **9333**；pid 在 `%TEMP%\webfetch-edge.pid`；浏览器 profile 在 `%TEMP%\webfetch-profile`。
- 停止：读 pid 后 `taskkill /PID <pid> /T /F`。浏览器状态坏了就杀掉，下次调用自动冷启动。
- 与工作区脚本 `node tools/webfetch.mjs <url> [outfile]` **共享同一个常驻浏览器和标签页**（同名 pid/tab 文件）。插件不可用时的后备路径就是这条命令。

## 本工作区通用网络经验（读文章失败时先查这些）

- `curl.exe` 在本环境不可靠（总是 000）——抓网页一律用 node fetch、`webfetch` 工具或 `tools/webfetch.mjs`。
- 沙箱下子进程**捕获输出必须用文件重定向**（`cmd /c "... > file"`），stdio 管道会 EPERM。
- 境外站直连大多超时；本机代理 `127.0.0.1:7897` 可用（node 走 net+tls CONNECT 隧道）。
- 调试临时文件用下划线前缀（`_xxx`）放工作区根目录，用完可清理。
