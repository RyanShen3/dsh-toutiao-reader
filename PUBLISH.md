# 发布清单（PUBLISH）

本文档是给维护者的上架操作手册。插件本体已 100% 就绪，剩下的是「放到 GitHub + 向精选列表提 PR」两步。

## 上架原理（30 秒版）

- dsh-market 插件市场的目录来自精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
- 向该仓库提 PR，在 `README.md` 和 `README.zh.md` 的 **🛠️ 工具与能力** 分类下各加一行即可
- PR 合并后，[awesome-dsh-plugin.com/plugins.json](https://awesome-dsh-plugin.com/plugins.json) 与市场自动收录，通常一天内生效
- 安装源按优先级：npm 包（需发布 npm，可后补）→ GitHub Release 预构建 tarball（可后补）→ **整仓 GitHub 源码（现在就能用）**

## 第一步：发布到 GitHub

1. （已完成）`package.json` 的 repository / homepage / bugs 已填为 `RyanShen3/dsh-toutiao-reader`
2. 建仓库 `dsh-toutiao-reader`（Public），任选其一推上去：

```powershell
# 方式 A：本机装 git 后
winget install --id Git.Git -e
cd D:\DSH_Workspace\dsh-toutiao-reader
git init && git add -A && git commit -m "feat: dsh-toutiao-reader 0.1.0"
git branch -M main
git remote add origin https://github.com/RyanShen3/dsh-toutiao-reader.git
git push -u origin main
```

方式 B：不装 git，直接在 github.com 新建仓库后用网页「uploading an existing file」拖拽上传（把 `node_modules/` 排除在外——`.gitignore` 已写好，网页上传时不要拖它）。

3. 仓库 **About → Topics** 添加话题：`dsh-plugin`（DSH 生态发现入口之一）、`deepseek-harness`、`toutiao`

## 第二步：向 awesome-dsh-plugin 提 PR

fork [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 后，在 **两个文件** 的 `### 🛠️ 工具与能力` 小节末尾各加一行（这是官方贡献要求：中英 README 都要加）：

**README.zh.md：**

```markdown
- [RyanShen3/dsh-toutiao-reader](https://github.com/RyanShen3/dsh-toutiao-reader) — 读网页/头条文章全文的 webfetch 工具：三级策略（直连 → Edge 常驻无头浏览器 CDP → dump-dom），自动识别头条反爬质询页，附 toutiao-reader 实战经验技能。
```

**README.md（英文列表）：**

```markdown
- [RyanShen3/dsh-toutiao-reader](https://github.com/RyanShen3/dsh-toutiao-reader) — webfetch tool for full-text web/Toutiao articles: 3-tier strategy (direct → resident Edge CDP headless → dump-dom) with automatic Toutiao anti-bot challenge handling, plus a bundled experience skill.
```

PR 标题建议：`Add dsh-toutiao-reader (webfetch tool + toutiao-reader skill)`

## 可选加强（不阻塞上架）

- **npm 发布**：`npm publish`（包名 `dsh-toutiao-reader`）后，市场安装走「仓库验证过的 npm 包」通道，秒装且不依赖 GitHub 网络。发布前确认 package.json 的 repository 与 GitHub 仓库一致（name-squatting 保护）
- **GitHub Release 预构建**：打 tag `v0.1.0` 并附 `dsh-toutiao-reader-0.1.0.tgz`（内容=files 字段所列），市场会识别同仓库的 release tarball
- **更多截图**：往 `assets/` 放使用截图（市场会从 README 自动抽取图片轮播）

## 上架前自检（已全部完成）

- [x] package.json：name/version/description/type/main/exports/files/dsh.bundle/keywords/license/repository
- [x] cordis.patch.yml：insert 条目
- [x] lib/（工具+技能注册）、skills/（SKILL.md）
- [x] README.md（英）+ README.zh.md（中）+ CHANGELOG.md + LICENSE(MIT) + assets/banner.png
- [x] 真实抓取验证（PC 文章 ~4s 全文；复抓 1.4s；outfile/截断/错误形态）
- [x] profile 实装验证（junction + 按名加载 + 工具/技能注册）
