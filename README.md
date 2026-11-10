# 交易复盘工具 v2（MT5 交易日志）

纯前端、无需服务器。打开 `index.html` 即可使用；部署到任意静态网站（推荐 GitHub Pages，也可用 Cloudflare Pages / Netlify 等）后，两台手机访问同一网址并在「同步设置」中填入同一个 GitHub 令牌即可同步。

## 文件
- `index.html` 页面与样式
- `js/core.js` 数据模型、旧数据迁移、统计、CSV/MT5 报告解析、截图文字解析、去重、同步合并
- `js/sync.js` 可插拔同步层（GitHub Gist / Gitee 码云 Gist）
- `js/ocr.js` 截图识别（Tesseract.js，CDN：npmmirror → jsDelivr → unpkg）
- `js/app.js` 界面逻辑
- `tessdata/` 识别语言包（英文、简体中文），与网页同源加载，国内可用
- `manifest.webmanifest`、`sw.js`、`icons/` PWA（添加到主屏幕、离线可用）

## 部署到 GitHub Pages（示例）
1. 新建仓库（可设为 Private，需要 GitHub Pro 才能对私有仓库开 Pages；否则用 Public 仓库——仓库里只有程序，没有你的交易数据）。
2. 上传本文件夹全部内容到仓库根目录。
3. 仓库 Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`，目录 `/ (root)`，保存。
4. 约 1 分钟后访问 `https://你的用户名.github.io/仓库名/`，在 iPhone Safari 中「分享 → 添加到主屏幕」。

数据只保存在各自手机浏览器中，以及（开启同步后）你自己账号下的私密 Gist。

## 资金账户

在「资金」页设置初始资金（默认美元 USD），并记录入金（金额为正）和出金（金额为负）。每条流水包含日期、金额和备注，可以修改或删除。

当前余额 = 初始资金 + 净入金 + 全部未删除交易的已实现净盈亏。净盈亏与 `calcPnL` 相同：手动记录为「实际盈亏 − 手续费」；MT5 导入时利润、手续费和库存费已经合进净盈亏。

同步文件 `mt5-journal-data.json` 升级为：

```json
{
  "version": 2,
  "trades": [],
  "account": {
    "currency": "USD",
    "initialBalance": 0,
    "cashflows": [{ "id": "…", "date": "2026-11-10", "amount": 1000, "note": "" }],
    "updatedAt": 0
  }
}
```

读取时兼容旧的纯交易数组，以及只有 `trades`、没有 `account` 的旧对象。合并时交易仍按 id、`updatedAt` 新者胜；`account` 整份按 `updatedAt` 新者胜。旧文件没有账户时，保留本机账户并在下次同步写回，不会丢交易，也不会用空账户覆盖已有出入金。

同域页面（例如全能资产管家）可读 `localStorage['mt5_journal_account_summary']`：`currency`、`initialBalance`、`netDeposits`、`realizedPnl`、`balance`、`daily`（按平仓日汇总净盈亏，日期为北京时间）、`cashflows`、`updatedAt`。交易或账户每次变动都会更新这份快照。本机状态在 `localStorage['mt5_journal_v2']` 的 `account` 字段，结构与 Gist 的 `account` 相同。
