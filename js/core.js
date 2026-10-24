/*
 * 交易复盘工具 · 核心逻辑（无 DOM 依赖，可在 Node 中测试）
 * 数据模型、旧数据迁移、盈亏计算、统计、CSV / MT5 报表解析、截图 OCR 行解析、去重、同步合并
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TJCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OLD_KEY = 'trading_journal_v1';
  const DATA_KEY = 'mt5_journal_v2';
  const SCHEMA = 2;

  const ASSET_TYPES = ['外汇', '贵金属', '指数', '股票', '基金', '加密货币', '期货', '期权', '其他'];
  const DEFAULT_LEVERAGE = { '股票': 1, '基金': 1, '外汇': 100, '贵金属': 100, '指数': 100, '加密货币': 10, '期货': 10, '期权': 1, '其他': 1 };
  const EMOTIONS = ['冷静', '自信', '贪婪', '恐惧', 'FOMO', '报复交易', '犹豫', '疲惫'];

  // ---------- 小工具 ----------
  const pad = n => String(n).padStart(2, '0');
  const round = (v, d = 2) => { const p = Math.pow(10, d); return Math.round((Number(v) + Number.EPSILON) * p) / p; };
  const isNum = v => v !== null && v !== '' && v !== undefined && isFinite(Number(v));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /** 统一解析日期（Safari 不认 "YYYY-MM-DD HH:mm"，所以自己解析）；返回本地时间 Date 或 null */
  function parseDate(s) {
    if (s instanceof Date) return isNaN(s) ? null : s;
    if (s === null || s === undefined || s === '') return null;
    if (typeof s === 'number') { const d = new Date(s); return isNaN(d) ? null : d; }
    const str = String(s).trim();
    let m = str.match(/^(\d{4})[.\-\/年](\d{1,2})[.\-\/月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
      return isNaN(d) ? null : d;
    }
    m = str.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/); // DD.MM.YYYY
    if (m) {
      const d = new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
      return isNaN(d) ? null : d;
    }
    const d = new Date(str);
    return isNaN(d) ? null : d;
  }
  /** Date -> "YYYY-MM-DD HH:mm[:ss]" */
  function fmtDate(d, withSec = true) {
    if (!d) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` + (withSec ? `:${pad(d.getSeconds())}` : '');
  }
  function normDateStr(s) {
    const d = parseDate(s);
    if (!d) return '';
    const hasSec = /\d{1,2}:\d{2}:\d{2}/.test(String(s));
    return fmtDate(d, hasSec);
  }
  const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function normSide(v) {
    const s = String(v || '').trim().toLowerCase();
    if (/^(多|做多|买|买入|buy|long|b)/.test(s)) return '多';
    if (/^(空|做空|卖|卖出|sell|short|s)/.test(s)) return '空';
    return '';
  }
  function normSymbolKey(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  function guessAssetType(symbol) {
    const s = normSymbolKey(symbol);
    if (!s) return '其他';
    if (/^(XAU|XAG|XPT|XPD|GOLD|SILVER)/.test(s)) return '贵金属';
    if (/^(BTC|ETH|LTC|XRP|SOL|DOGE|BNB|ADA)/.test(s)) return '加密货币';
    if (/^(US30|US100|US500|NAS|NDX|SPX|SP500|DJ|DOW|GER|DE30|DE40|UK100|HK50|HSI|JP225|NIKKEI|CHINA50|CN50|AUS200|FRA40|EU50|USTEC)/.test(s)) return '指数';
    if (/^(USOIL|UKOIL|WTI|BRENT|XTI|XBR|NGAS|CL)/.test(s)) return '期货';
    const ccy = 'USD|EUR|JPY|GBP|AUD|NZD|CAD|CHF|CNH|HKD|SGD|SEK|NOK|MXN|ZAR|TRY|PLN';
    if (new RegExp(`^(${ccy})(${ccy})`).test(s)) return '外汇';
    if (/^\d{6}$/.test(s)) return '股票';
    return '其他';
  }

  const ASSET_MAP = {
    stock: '股票', stocks: '股票', equity: '股票', fund: '基金', funds: '基金', etf: '基金',
    forex: '外汇', fx: '外汇', currency: '外汇', crypto: '加密货币', cryptocurrency: '加密货币', btc: '加密货币',
    futures: '期货', future: '期货', option: '期权', options: '期权', metal: '贵金属', metals: '贵金属', gold: '贵金属',
    index: '指数', indices: '指数', cfd: '指数'
  };

  // ---------- 交易标准化 ----------
  function pick(raw, ...keys) { for (const k of keys) if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') return raw[k]; return undefined; }

  function normalizeTrade(raw, opts = {}) {
    raw = raw || {};
    const symbol = String(pick(raw, 'symbol', 'Symbol', '品种', '代码') || '').trim().toUpperCase();
    let assetType = pick(raw, 'assetType', 'asset_type', '资产类型');
    if (assetType && ASSET_MAP[String(assetType).toLowerCase()]) assetType = ASSET_MAP[String(assetType).toLowerCase()];
    if (!assetType || !ASSET_TYPES.includes(assetType)) assetType = assetType && String(assetType).trim() ? String(assetType).trim() : guessAssetType(symbol);
    let leverage = Number(pick(raw, 'leverage', '杠杆'));
    if (!isFinite(leverage) || leverage <= 0) leverage = DEFAULT_LEVERAGE[assetType] || 1;
    const profitRaw = pick(raw, 'profit', 'Profit', '实际盈亏');
    const tags = Array.isArray(raw.tags) ? raw.tags : String(raw.tags || '').split(/[,，;；\s]+/);
    const now = Date.now();
    const closeTime = normDateStr(pick(raw, 'closeTime', 'close_time'));
    const openTime = normDateStr(pick(raw, 'openTime', 'open_time'));
    const date = normDateStr(pick(raw, 'date', '日期')) || closeTime || openTime;
    const t = {
      id: raw.id ? String(raw.id) : uid(),
      date,
      symbol,
      assetType,
      side: normSide(pick(raw, 'side', 'type', '方向')) || '多',
      qty: Number(pick(raw, 'qty', 'lots', 'volume', '数量')) || 0,
      entryPrice: Number(pick(raw, 'entryPrice', 'entry_price', 'openPrice', '开仓价')) || 0,
      exitPrice: Number(pick(raw, 'exitPrice', 'exit_price', 'closePrice', '平仓价')) || 0,
      leverage,
      fee: Number(pick(raw, 'fee', '手续费')) || 0,
      profit: isNum(profitRaw) ? round(Number(profitRaw), 2) : null,
      ticket: String(pick(raw, 'ticket', 'position', '订单号') || '').trim(),
      openTime,
      closeTime,
      strategy: String(raw.strategy || '').trim(),
      emotion: String(raw.emotion || '').trim(),
      tags: [...new Set(tags.map(x => String(x).trim()).filter(Boolean))],
      notes: String(raw.notes || ''),
      source: raw.source || opts.source || 'manual',
      createdAt: Number(raw.createdAt) || opts.createdAt || now,
      updatedAt: Number(raw.updatedAt) || opts.updatedAt || now
    };
    if (raw.commission !== undefined) t.commission = Number(raw.commission) || 0;
    if (raw.swap !== undefined) t.swap = Number(raw.swap) || 0;
    t.pnl = calcPnL(t);
    return t;
  }

  /** 盈亏：若填写了「实际盈亏」（MT5 显示的利润）则直接使用；否则按旧版公式 (价差 × 数量 × 杠杆 − 手续费) */
  function calcPnL(t) {
    const fee = Number(t.fee) || 0;
    if (isNum(t.profit)) return round(Number(t.profit) - fee, 2);
    const qty = Number(t.qty) || 0, entry = Number(t.entryPrice) || 0, exit = Number(t.exitPrice) || 0;
    const lev = Number(t.leverage) || 1;
    const dir = normSide(t.side) === '空' ? -1 : 1;
    return round((exit - entry) * dir * qty * lev - fee, 2);
  }

  function validateTrade(t) {
    const e = [];
    if (!t.date || !parseDate(t.date)) e.push('日期缺失或格式无效');
    if (!t.symbol) e.push('缺少品种代码');
    if (!['多', '空'].includes(t.side)) e.push('方向必须是 多/空');
    if (!(Number(t.qty) > 0)) e.push('数量必须为正数');
    if (!(Number(t.entryPrice) >= 0)) e.push('开仓价无效');
    if (!(Number(t.exitPrice) >= 0)) e.push('平仓价无效');
    if (!(Number(t.leverage) > 0)) e.push('杠杆必须为正数');
    if (!isFinite(Number(t.fee))) e.push('手续费无效');
    if (t.profit !== null && t.profit !== undefined && !isFinite(Number(t.profit))) e.push('实际盈亏无效');
    return e;
  }

  // ---------- 存储 / 迁移 ----------
  /** 从旧 id（Date.now().toString(36)+随机）里解出创建时间 */
  function tsFromOldId(id) {
    const n = parseInt(String(id).slice(0, 8), 36);
    return n > 1.4e12 && n < 4.1e12 ? n : 0;
  }
  function migrateOld(oldArr) {
    if (!Array.isArray(oldArr)) return [];
    return oldArr.filter(x => x && typeof x === 'object').map(o => {
      const ts = tsFromOldId(o.id) || 1;
      return normalizeTrade(o, { createdAt: ts, updatedAt: ts, source: 'manual' });
    });
  }
  /** 读取数据；若只有旧版数据则自动迁移（旧键保留作备份，不删除） */
  function loadStore(storage) {
    let migrated = false;
    let state = null;
    try { state = JSON.parse(storage.getItem(DATA_KEY) || 'null'); } catch (e) { state = null; }
    if (!state || !Array.isArray(state.trades)) {
      let old = [];
      try { old = JSON.parse(storage.getItem(OLD_KEY) || '[]'); } catch (e) { old = []; }
      state = { schema: SCHEMA, trades: migrateOld(old), migratedFrom: old.length ? OLD_KEY : undefined, migratedAt: old.length ? Date.now() : undefined };
      migrated = old.length > 0;
      storage.setItem(DATA_KEY, JSON.stringify(state));
    } else {
      state.trades = state.trades.map(t => t.deleted ? t : Object.assign(t, { pnl: calcPnL(t) }));
    }
    return { state, migrated };
  }
  function saveStore(storage, state) { storage.setItem(DATA_KEY, JSON.stringify(state)); }
  const live = trades => trades.filter(t => !t.deleted);

  // ---------- 统计 ----------
  const tradeTime = t => parseDate(t.closeTime || t.date);
  function sortByTime(list, desc = false) {
    const k = list.map(t => [t, (tradeTime(t) || new Date(0)).getTime()]);
    k.sort((a, b) => desc ? b[1] - a[1] : a[1] - b[1]);
    return k.map(x => x[0]);
  }
  function computeStats(list) {
    const sorted = sortByTime(list);
    const s = {
      total: sorted.length, wins: 0, losses: 0, flat: 0, totalPnL: 0, grossProfit: 0, grossLoss: 0,
      maxDD: 0, maxDDPct: 0, best: null, worst: null, maxWinStreak: 0, maxLossStreak: 0, totalLots: 0,
      equity: [], bySymbol: {}, byWeekday: Array(7).fill(0), byWeekdayN: Array(7).fill(0), byHour: Array(24).fill(0), byHourN: Array(24).fill(0),
      byDay: {}, byMonth: {}, byAsset: {}, byStrategy: {}, byEmotion: {}, longPnL: 0, shortPnL: 0, longN: 0, shortN: 0
    };
    let eq = 0, peak = 0, ws = 0, ls = 0;
    const bump = (obj, k, p) => { if (!k) return; const o = obj[k] || (obj[k] = { n: 0, pnl: 0, wins: 0, lots: 0 }); o.n++; o.pnl += p; if (p > 0) o.wins++; };
    for (const t of sorted) {
      const p = Number(t.pnl) || 0;
      s.totalPnL += p; s.totalLots += Number(t.qty) || 0;
      if (p > 0) { s.wins++; s.grossProfit += p; ws++; ls = 0; } else if (p < 0) { s.losses++; s.grossLoss += p; ls++; ws = 0; } else { s.flat++; ws = 0; ls = 0; }
      s.maxWinStreak = Math.max(s.maxWinStreak, ws); s.maxLossStreak = Math.max(s.maxLossStreak, ls);
      if (!s.best || p > s.best.pnl) s.best = t;
      if (!s.worst || p < s.worst.pnl) s.worst = t;
      eq += p; if (eq > peak) peak = eq;
      const dd = peak - eq; if (dd > s.maxDD) { s.maxDD = dd; s.maxDDPct = peak > 0 ? dd / peak * 100 : 0; }
      const d = tradeTime(t);
      s.equity.push({ x: d ? fmtDate(d, false) : '', y: round(eq) });
      bump(s.bySymbol, t.symbol, p); if (s.bySymbol[t.symbol]) s.bySymbol[t.symbol].lots += Number(t.qty) || 0;
      bump(s.byAsset, t.assetType, p);
      bump(s.byStrategy, t.strategy || '未设置', p);
      bump(s.byEmotion, t.emotion || '未设置', p);
      if (t.side === '空') { s.shortPnL += p; s.shortN++; } else { s.longPnL += p; s.longN++; }
      if (d) {
        const wd = (d.getDay() + 6) % 7; // 周一=0
        s.byWeekday[wd] += p; s.byWeekdayN[wd]++;
        s.byHour[d.getHours()] += p; s.byHourN[d.getHours()]++;
        const dk = dayKey(d); const o = s.byDay[dk] || (s.byDay[dk] = { pnl: 0, n: 0 }); o.pnl += p; o.n++;
        const mk = dk.slice(0, 7); s.byMonth[mk] = (s.byMonth[mk] || 0) + p;
      }
    }
    s.winRate = s.total ? s.wins / s.total * 100 : 0;
    s.avgWin = s.wins ? s.grossProfit / s.wins : 0;
    s.avgLoss = s.losses ? s.grossLoss / s.losses : 0;
    s.profitFactor = s.grossLoss ? s.grossProfit / Math.abs(s.grossLoss) : (s.grossProfit > 0 ? Infinity : 0);
    s.payoff = s.avgLoss ? s.avgWin / Math.abs(s.avgLoss) : 0;
    s.expectancy = s.total ? s.totalPnL / s.total : 0;
    s.tradingDays = Object.keys(s.byDay).length;
    return s;
  }

  function filterTrades(list, f = {}) {
    const kw = (f.keyword || '').trim().toLowerCase();
    const from = f.from ? parseDate(f.from) : null;
    const to = f.to ? parseDate(f.to) : null;
    if (to) to.setHours(23, 59, 59, 999);
    return list.filter(t => {
      if (f.asset && t.assetType !== f.asset) return false;
      if (f.side && t.side !== f.side) return false;
      if (f.symbol && t.symbol !== f.symbol) return false;
      if (f.strategy && t.strategy !== f.strategy) return false;
      if (f.result === 'win' && !(t.pnl > 0)) return false;
      if (f.result === 'loss' && !(t.pnl < 0)) return false;
      if (from || to) {
        const d = tradeTime(t); if (!d) return false;
        if (from && d < from) return false;
        if (to && d > to) return false;
      }
      if (kw) {
        const hay = [t.symbol, t.strategy, t.emotion, t.notes, t.ticket, (t.tags || []).join(' ')].join(' ').toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }

  function periodRange(key, now = new Date()) {
    const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    switch (key) {
      case 'today': return { from: d0, to: now };
      case 'week': { const d = new Date(d0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return { from: d, to: now }; }
      case 'month': return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
      case '30d': { const d = new Date(d0); d.setDate(d.getDate() - 29); return { from: d, to: now }; }
      case 'year': return { from: new Date(now.getFullYear(), 0, 1), to: now };
      default: return null;
    }
  }

  // ---------- CSV ----------
  function parseCSV(text) {
    text = String(text || '').replace(/^\ufeff/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const delim = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }
  function toCSV(rows) {
    return rows.map(r => r.map(v => {
      v = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(',')).join('\r\n');
  }
  const EXPORT_COLS = ['date', 'symbol', 'assetType', 'side', 'qty', 'entryPrice', 'exitPrice', 'leverage', 'fee', 'profit', 'pnl', 'ticket', 'openTime', 'closeTime', 'strategy', 'emotion', 'tags', 'notes'];
  function exportCSV(trades) {
    return '\ufeff' + toCSV([EXPORT_COLS, ...trades.map(t => EXPORT_COLS.map(c => c === 'tags' ? (t.tags || []).join(' ') : t[c]))]);
  }

  // MT5 表头别名（英文 / 中文）
  const MT5_HEAD = {
    time: /^(time|open\s*time|时间|开仓时间)$/i,
    ticket: /^(position|ticket|order|deal|持仓|订单|编号|单号|成交)$/i,
    symbol: /^(symbol|交易品种|品种)$/i,
    type: /^(type|类型|方向)$/i,
    volume: /^(volume|lots|交易量|手数|数量)$/i,
    price: /^(price|open\s*price|价格|开仓价)$/i,
    commission: /^(commission|手续费|佣金)$/i,
    swap: /^(swap|库存费|隔夜利息|过夜费)$/i,
    profit: /^(profit|利润|盈亏|获利)$/i
  };
  function mapMT5Header(cells) {
    const idx = {}; let timeN = 0, priceN = 0;
    cells.forEach((c, i) => {
      const h = String(c).trim().replace(/\s+/g, ' ');
      if (MT5_HEAD.time.test(h)) { idx[timeN++ ? 'closeTime' : 'openTime'] = i; }
      else if (MT5_HEAD.price.test(h)) { idx[priceN++ ? 'closePrice' : 'openPrice'] = i; }
      else if (/^close\s*time|平仓时间$/i.test(h)) idx.closeTime = i;
      else if (/^close\s*price|平仓价$/i.test(h)) idx.closePrice = i;
      else for (const k of ['ticket', 'symbol', 'type', 'volume', 'commission', 'swap', 'profit']) if (idx[k] === undefined && MT5_HEAD[k].test(h)) { idx[k] = i; break; }
    });
    return (idx.symbol !== undefined && idx.type !== undefined && idx.volume !== undefined && idx.openPrice !== undefined) ? idx : null;
  }
  const num = v => { const s = String(v ?? '').replace(/[\s\u00a0]/g, '').replace(/,(?=\d{3}\b)/g, ''); return s === '' ? NaN : Number(s.replace(',', '.')); };
  function mt5RowToTrade(cells, idx, source) {
    const side = normSide(cells[idx.type]);
    if (!side) return null; // balance / credit 等非交易行
    const profit = num(cells[idx.profit]), commission = num(cells[idx.commission]) || 0, swap = num(cells[idx.swap]) || 0;
    const closeTime = idx.closeTime !== undefined ? cells[idx.closeTime] : '';
    const openTime = idx.openTime !== undefined ? cells[idx.openTime] : '';
    return normalizeTrade({
      symbol: cells[idx.symbol], side, qty: num(cells[idx.volume]), entryPrice: num(cells[idx.openPrice]),
      exitPrice: idx.closePrice !== undefined ? num(cells[idx.closePrice]) : num(cells[idx.openPrice]),
      ticket: idx.ticket !== undefined ? cells[idx.ticket] : '', openTime, closeTime, date: closeTime || openTime,
      profit: isFinite(profit) ? round(profit + commission + swap, 2) : null, commission, swap, source
    }, { source });
  }

  /** 解析 CSV 文本：自动识别本工具模板 / MT5 历史（Positions 表头）格式 */
  function importCSVText(text) {
    const rows = parseCSV(text);
    const out = { trades: [], errors: [], format: '' };
    if (!rows.length) { out.errors.push('文件为空'); return out; }
    // MT5 格式：找到表头行
    for (let r = 0; r < Math.min(rows.length, 30); r++) {
      const idx = mapMT5Header(rows[r]);
      if (idx) {
        out.format = 'MT5 历史';
        for (let i = r + 1; i < rows.length; i++) {
          if (mapMT5Header(rows[i])) break;
          const t = mt5RowToTrade(rows[i], idx, 'mt5');
          if (!t) continue;
          const e = validateTrade(t);
          e.length ? out.errors.push(`第 ${i + 1} 行：${e.join('，')}`) : out.trades.push(t);
        }
        return out;
      }
    }
    out.format = '通用模板';
    const head = rows[0].map(h => String(h).trim());
    rows.slice(1).forEach((r, i) => {
      const raw = {}; head.forEach((h, j) => { raw[h] = r[j]; });
      delete raw.id; delete raw.pnl;
      const t = normalizeTrade(raw, { source: 'csv' });
      const e = validateTrade(t);
      e.length ? out.errors.push(`第 ${i + 2} 行：${e.join('，')}`) : out.trades.push(t);
    });
    return out;
  }

  /** 解析 MT5 桌面端「报告 → HTML」导出的历史报告（传入已解码的 HTML 字符串与 DOMParser） */
  function importMT5ReportHTML(html, DOMParserImpl) {
    const doc = new DOMParserImpl().parseFromString(html, 'text/html');
    const out = { trades: [], errors: [], format: 'MT5 HTML 报告' };
    const trs = [...doc.querySelectorAll('tr')];
    let idx = null, inPositions = false;
    for (const tr of trs) {
      const cells = [...tr.children].flatMap(td => { const n = Number(td.getAttribute('colspan')) || 1; const v = td.textContent.trim(); return [v, ...Array(n - 1).fill('')]; });
      const visible = cells.filter(c => c !== '');
      if (visible.length === 1 && /^(positions|持仓|仓位)$/i.test(visible[0])) { inPositions = true; idx = null; continue; }
      if (visible.length === 1 && /^(orders|deals|订单|成交|交易|working orders|results|结果)$/i.test(visible[0])) { if (out.trades.length) break; inPositions = false; idx = null; continue; }
      const h = mapMT5Header(cells);
      if (h && h.closeTime !== undefined) { idx = h; continue; }
      if (idx && (inPositions || out.trades.length || true)) {
        const t = mt5RowToTrade(cells, idx, 'mt5');
        if (t && !validateTrade(t).length) out.trades.push(t);
      }
    }
    if (!out.trades.length) out.errors.push('未找到「持仓 / Positions」表，请确认是 MT5 历史报告');
    return out;
  }

  /** 识别文本编码（MT5 报告常为 UTF-16LE） */
  function decodeBytes(buf) {
    const b = new Uint8Array(buf);
    let enc = 'utf-8';
    if (b[0] === 0xff && b[1] === 0xfe) enc = 'utf-16le';
    else if (b[0] === 0xfe && b[1] === 0xff) enc = 'utf-16be';
    else if (b.length > 3 && b[1] === 0 && b[3] === 0) enc = 'utf-16le';
    let text = new TextDecoder(enc).decode(b);
    if (enc === 'utf-8' && text.includes('\ufffd')) { try { text = new TextDecoder('gb18030').decode(b); } catch (e) { /* ignore */ } }
    return text;
  }

  // ---------- 截图 OCR 解析 ----------
  /** Tesseract 单词 -> 按 y 坐标聚成行 */
  function groupWordsToLines(words) {
    const ws = words.filter(w => w && String(w.text).trim()).map(w => {
      const b = w.bbox; return { text: String(w.text).trim(), x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, cy: (b.y0 + b.y1) / 2, h: b.y1 - b.y0, conf: w.confidence };
    });
    if (!ws.length) return [];
    const hs = ws.map(w => w.h).sort((a, b) => a - b); const mh = hs[Math.floor(hs.length / 2)] || 10;
    ws.sort((a, b) => a.cy - b.cy);
    const lines = [];
    for (const w of ws) {
      const L = lines[lines.length - 1];
      if (L && Math.abs(w.cy - L.cy) < mh * 0.55) { L.words.push(w); L.cy = (L.cy * (L.words.length - 1) + w.cy) / L.words.length; }
      else lines.push({ cy: w.cy, words: [w] });
    }
    return lines.map(L => { L.words.sort((a, b) => a.x0 - b.x0); return { text: L.words.map(w => w.text).join(' '), y: L.cy, words: L.words }; });
  }

  // 不用后行断言（旧版 iOS Safari 不支持）：方向词前可以是空白/逗号，或直接紧跟品种字符（OCR 漏掉空格）
  const SIDE_RE = /(^|[\s,，:]|[A-Za-z0-9+.#])(buy|sell|买入|卖出|做多|做空|买|卖)(?:\s*(limit|stop|stop\s*limit))?(?=[\s\d.,]|$)/i;
  const DT_RE = /(20\d{2})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})\s*(\d{1,2})\s*[:.]\s*(\d{2})(?:\s*[:.]\s*(\d{2}))?/;
  const DATE_ONLY_RE = /(20\d{2})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})/;

  function cleanOCRText(s) {
    return String(s)
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[，]/g, ',').replace(/[：]/g, ':').replace(/[。]/g, '.')
      .replace(/[−–—―‒﹣－]/g, '-')
      .replace(/(\d)\s*[,](\d{2,})(?!\d*[.,]\d)/g, '$1.$2') // 0,03 -> 0.03（单个逗号小数）
      .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1') // 中文识别常在汉字间插空格
      .replace(/\s+/g, ' ').trim();
  }
  function parseLots(tok) {
    if (!tok) return NaN;
    let s = tok.replace(',', '.').replace(/[^\d.]/g, '');
    if (!s) return NaN;
    if (!s.includes('.') && /^0\d+$/.test(s)) s = '0.' + s.slice(1); // "003" -> 0.03
    const v = Number(s);
    return v > 0 && v < 10000 ? v : NaN;
  }
  function parseProfitStr(s) {
    // 允许空格千分位："1 234.56"、"-1 234.56"
    const m = String(s).match(/(-\s?)?(?:\d{1,3}(?:[ \u00a0]\d{3})+|\d+)(?:[.,]\d{1,2})?(?!\d)/g);
    if (!m) return NaN;
    const last = m[m.length - 1].replace(/[ \u00a0]/g, '').replace(',', '.');
    return Number(last);
  }
  const PRICE_RE = /\d+(?:[.,]\d+)?/g;

  /**
   * 解析 MT5 历史「持仓」列表的 OCR 文本行。
   * 典型（iOS）：行1 "XAUUSD+ sell 0.03        7.62"；行2 "4165.58 → 4163.04   2026.10.15 16:19:33"
   * 也兼容 Android：行1 "XAUUSD, sell 0.03   2026.10.15 16:19:33"；行2 "4165.58 → 4163.04   7.62"
   */
  function parseMT5Lines(lines) {
    const L = lines.map(l => typeof l === 'string' ? { text: l } : l).map(l => Object.assign({}, l, { text: cleanOCRText(l.text) })).filter(l => l.text);
    const records = [];
    let cur = null;
    for (const l of L) {
      const m = l.text.match(SIDE_RE);
      const sideIdx = m ? m.index + m[1].length : -1; // m[1]=前缀字符，m[2]=方向词
      const before = m ? l.text.slice(0, sideIdx).trim() : '';
      const symM = before.match(/([A-Za-z][A-Za-z0-9._#+\-]{1,20})[,\s]*$/);
      if (m && symM) {
        cur = { header: l, side: m[2], sym: symM[1], after: l.text.slice(m.index + m[0].length), details: [] };
        records.push(cur);
      } else if (cur && !cur.closed && cur.details.length < 2) {
        cur.details.push(l);
        // 明细已包含时间与两个价格 -> 本条记录完整，后续零散行不再并入
        const dt = cur.details.map(d => d.text).join(' ');
        if (DT_RE.test(dt) && (dt.replace(DT_RE, ' ').match(PRICE_RE) || []).length >= 2) cur.closed = true;
      }
    }
    const rows = [];
    for (const r of records) {
      const flags = [];
      let headerRest = r.after.trim();
      const detailText = r.details.map(d => d.text).join(' | ');
      // 时间：优先在明细行，其次表头行
      let dtm = detailText.match(DT_RE) || headerRest.match(DT_RE);
      let closeTime = '';
      if (dtm) {
        closeTime = `${dtm[1]}-${pad(dtm[2])}-${pad(dtm[3])} ${pad(dtm[4])}:${dtm[5]}` + (dtm[6] ? `:${dtm[6]}` : '');
      } else {
        const dm = detailText.match(DATE_ONLY_RE) || headerRest.match(DATE_ONLY_RE);
        if (dm) closeTime = `${dm[1]}-${pad(dm[2])}-${pad(dm[3])} 00:00`;
      }
      const stripDT = s => s.replace(DT_RE, ' ').replace(DATE_ONLY_RE, ' ');
      headerRest = stripDT(headerRest);
      const lotsM = headerRest.match(/^[^\d\-]{0,14}?([0-9]+(?:[.,][0-9]+)?)/); // 跳过 "入"、"limit" 等残留字符
      const lots = parseLots(lotsM && lotsM[1]);
      const afterLots = lotsM ? headerRest.slice(lotsM[0].length) : headerRest;
      let profit = parseProfitStr(afterLots.replace(/(\d)\s*[:;]\s*(\d{2})(?!\d)/g, '$1.$2'));
      // 价格：明细行中（去掉时间后）的数字
      const detNoDT = stripDT(r.details.map(d => d.text).join(' '));
      const nums = (detNoDT.match(PRICE_RE) || []).map(x => Number(x.replace(',', '.'))).filter(v => isFinite(v));
      let openPrice = NaN, closePrice = NaN;
      if (isFinite(profit)) {
        if (nums.length >= 2) { openPrice = nums[0]; closePrice = nums[nums.length - 1]; }
        else if (nums.length === 1) openPrice = nums[0];
      } else {
        // 利润可能在明细行最后（Android 布局）
        if (nums.length >= 3) { openPrice = nums[0]; closePrice = nums[1]; profit = signedLast(detNoDT); }
        else if (nums.length === 2) { openPrice = nums[0]; closePrice = nums[1]; }
      }
      if (!closeTime) flags.push('未识别到平仓时间');
      if (!isFinite(lots)) flags.push('手数未识别');
      if (!isFinite(openPrice) || !isFinite(closePrice)) flags.push('价格未完整识别');
      rows.push({
        symbol: r.sym.toUpperCase(), side: normSide(r.side), sideRaw: r.side.toLowerCase(), qty: lots,
        entryPrice: openPrice, exitPrice: closePrice, closeTime, profit: isFinite(profit) ? round(profit, 2) : NaN,
        raw: [r.header.text, ...r.details.map(d => d.text)].join(' / '), flags,
        profitBox: r.header.words ? (r.header.words[r.header.words.length - 1] || null) : null
      });
    }
    return rows;
    function signedLast(s) { const m = s.match(/-?\s?\d+(?:[.,]\d+)?/g); return m ? Number(m[m.length - 1].replace(/\s/g, '').replace(',', '.')) : NaN; }
  }

  /**
   * 用价格校验 / 修正 OCR 利润：同一品种的 合约乘数 k = 利润 / (方向×价差×手数) 应一致。
   * 若某行利润与其它行推算值明显不符（如 7.62 被识别成 71.62），则改用推算值并标记。
   */
  function reconcileRows(rows, existing = []) {
    const ks = {};
    const addK = (sym, k) => { if (isFinite(k) && k > 0) (ks[sym] || (ks[sym] = [])).push(k); };
    const impliedK = r => {
      const dir = r.side === '空' ? -1 : 1; const diff = (r.exitPrice - r.entryPrice) * dir;
      if (!isFinite(diff) || Math.abs(diff) < 1e-9 || !(r.qty > 0) || !isFinite(r.profit)) return NaN;
      return r.profit / (diff * r.qty);
    };
    rows.forEach(r => addK(normSymbolKey(r.symbol), impliedK(r)));
    existing.filter(t => !t.deleted && isNum(t.profit)).slice(-300).forEach(t => addK(normSymbolKey(t.symbol), impliedK({ side: t.side, exitPrice: t.exitPrice, entryPrice: t.entryPrice, qty: t.qty, profit: t.profit })));
    const kMed = {};
    for (const [sym, arr] of Object.entries(ks)) {
      // 取「与最多其它值一致（±3%）」的那个 k 作为基准
      let best = null, bestN = 0;
      for (const k of arr) { const n = arr.filter(x => Math.abs(x - k) <= 0.03 * k).length; if (n > bestN) { bestN = n; best = k; } }
      if (best && bestN >= 2) {
        const close = arr.filter(x => Math.abs(x - best) <= 0.03 * best).sort((a, b) => a - b);
        const med = close[Math.floor(close.length / 2)];
        const devs = close.map(x => Math.abs(x - med) / med).sort((a, b) => a - b);
        kMed[sym] = { k: med, mad: devs[Math.floor(devs.length / 2)] };
      }
    }
    for (const r of rows) {
      const km = kMed[normSymbolKey(r.symbol)];
      if (!km) continue;
      const k = km.k;
      const dir = r.side === '空' ? -1 : 1; const diff = (r.exitPrice - r.entryPrice) * dir;
      if (!isFinite(diff) || !(r.qty > 0)) continue;
      const expected = round(diff * r.qty * k, 2);
      if (!isFinite(r.profit)) { r.profit = expected; r.flags.push('盈亏按价格推算'); continue; }
      const tol = 0.011 + Math.abs(expected) * Math.min(0.03, km.mad * 2 + 0.001);
      if (Math.abs(r.profit - expected) > tol) {
        if (Math.abs(-r.profit - expected) <= tol) r.flags.push('已修正盈亏正负号');
        else r.flags.push(`盈亏由 ${r.profit} 校正`);
        r.profit = expected;
      }
    }
    return rows;
  }

  /** 把 OCR 行转成交易对象 */
  function ocrRowToTrade(r) {
    return normalizeTrade({
      symbol: r.symbol, side: r.side, qty: r.qty, entryPrice: r.entryPrice, exitPrice: r.exitPrice,
      closeTime: r.closeTime, date: r.closeTime, profit: isFinite(r.profit) ? r.profit : null, ticket: r.ticket || '', source: 'ocr'
    }, { source: 'ocr' });
  }

  // ---------- 去重 ----------
  const near = (a, b, tol) => isFinite(a) && isFinite(b) && Math.abs(a - b) <= tol;
  const priceTol = p => Math.max(1e-9, Math.abs(p) * 1e-7);
  /** 比较一条待导入记录与一条已有交易：返回 'dup' | 'maybe' | null */
  function compareTrade(row, t) {
    if (row.ticket && t.ticket) return String(row.ticket) === String(t.ticket) ? 'dup' : null;
    if (normSymbolKey(row.symbol) !== normSymbolKey(t.symbol)) return null;
    if (normSide(row.side) !== normSide(t.side)) return null;
    const lotsEq = near(Number(row.qty), Number(t.qty), 1e-6);
    const openEq = near(Number(row.entryPrice), Number(t.entryPrice), priceTol(Number(t.entryPrice)));
    const closeEq = near(Number(row.exitPrice), Number(t.exitPrice), priceTol(Number(t.exitPrice)));
    const rt = parseDate(row.closeTime || row.date), tt = parseDate(t.closeTime || t.date);
    let timeEq = false, sameDay = false;
    if (rt && tt) {
      const precise = /:\d{2}:\d{2}/.test(row.closeTime || row.date || '') && /:\d{2}:\d{2}/.test(t.closeTime || t.date || '');
      const dt = Math.abs(rt - tt);
      timeEq = precise ? dt < 1000 : dt < 60000;
      sameDay = dayKey(rt) === dayKey(tt);
    }
    const bothProfit = isNum(row.profit) && isNum(t.profit);
    const profitEq = bothProfit ? near(Number(row.profit), Number(t.profit), 0.011) : true;
    if (lotsEq && openEq && closeEq && timeEq && profitEq) return 'dup';
    // 疑似：只有一项不一致，或手动录入（时间可能是开仓时间）但价格完全一致且同一天
    const misses = [lotsEq, openEq, closeEq, timeEq, profitEq].filter(x => !x).length;
    if (misses === 1 && timeEq) return 'maybe';
    if (lotsEq && openEq && closeEq && sameDay && t.source === 'manual') return 'maybe';
    return null;
  }
  /**
   * 为一批待导入交易打标：status = new | dup | maybe。
   * 已有交易按「一对一」消耗，避免同一条已有记录吞掉两条真实存在的相同交易；
   * 同一张图里的行彼此不判重，不同图片之间会互相判重（重叠截图）。
   */
  function assessImport(rows, existing) {
    const pool = live(existing).map(t => ({ t, used: false, group: null }));
    for (const r of rows) {
      let hit = null, maybe = null;
      for (const p of pool) {
        if (p.used || (p.group !== null && p.group === r.group)) continue;
        const c = compareTrade(r, p.t);
        if (c === 'dup') { hit = p; break; }
        if (c === 'maybe' && !maybe) maybe = p;
      }
      if (hit) { hit.used = true; r.status = 'dup'; r.dupOf = hit.t.id; r.dupInBatch = hit.group !== null; }
      else if (maybe) { r.status = 'maybe'; r.dupOf = maybe.t.id; }
      else r.status = 'new';
      if (r.status !== 'dup') pool.push({ t: r, used: false, group: r.group === undefined ? null : r.group });
    }
    return rows;
  }

  // ---------- 同步合并 ----------
  /** 按 id 合并，updatedAt 新者胜（删除用墓碑 deleted:true 表示）；再按订单号去重 */
  function mergeTrades(local, remote) {
    const map = new Map();
    for (const t of local || []) map.set(String(t.id), t);
    let fromRemote = 0, localWins = 0;
    for (const r of remote || []) {
      const id = String(r.id); const l = map.get(id);
      if (!l) { map.set(id, r); fromRemote++; }
      else if ((Number(r.updatedAt) || 0) > (Number(l.updatedAt) || 0)) { map.set(id, r); fromRemote++; }
      else if ((Number(l.updatedAt) || 0) > (Number(r.updatedAt) || 0)) localWins++;
    }
    // 两台设备分别导入同一订单号 -> 保留较早创建的那条
    const byTicket = new Map();
    for (const t of map.values()) {
      if (t.deleted || !t.ticket) continue;
      const k = normSymbolKey(t.symbol) + '#' + t.ticket;
      const o = byTicket.get(k);
      if (!o) byTicket.set(k, t);
      else {
        const [keep, drop] = (Number(o.createdAt) || 0) <= (Number(t.createdAt) || 0) ? [o, t] : [t, o];
        byTicket.set(k, keep);
        map.set(String(drop.id), { id: drop.id, deleted: true, updatedAt: Math.max(Number(drop.updatedAt) || 0, Number(keep.updatedAt) || 0) + 1 });
      }
    }
    const merged = [...map.values()].map(t => t.deleted ? t : Object.assign({}, t, { pnl: calcPnL(t) }));
    return { merged, fromRemote, localWins };
  }
  /** 比较两份数据是否等价（用于判断是否需要上传） */
  function sameTrades(a, b) {
    if ((a || []).length !== (b || []).length) return false;
    const m = new Map((b || []).map(t => [String(t.id), Number(t.updatedAt) || 0]));
    return (a || []).every(t => m.get(String(t.id)) === (Number(t.updatedAt) || 0));
  }
  /** 清理 90 天前的删除墓碑 */
  function pruneTombstones(trades, now = Date.now(), days = 90) {
    return trades.filter(t => !t.deleted || now - (Number(t.updatedAt) || 0) < days * 864e5);
  }
  function buildPayload(trades, device) {
    return { app: 'mt5-journal', schema: SCHEMA, updatedAt: new Date().toISOString(), device: device || '', trades };
  }
  function parsePayload(obj) {
    if (Array.isArray(obj)) return migrateOld(obj); // 旧版导出的 JSON 数组
    if (obj && Array.isArray(obj.trades)) return obj.trades.map(t => t.deleted ? t : normalizeTrade(t));
    throw new Error('无法识别的数据格式');
  }

  return {
    OLD_KEY, DATA_KEY, SCHEMA, ASSET_TYPES, DEFAULT_LEVERAGE, EMOTIONS,
    pad, round, uid, isNum, parseDate, fmtDate, normDateStr, dayKey, normSide, normSymbolKey, guessAssetType,
    normalizeTrade, calcPnL, validateTrade, migrateOld, loadStore, saveStore, live, tradeTime, sortByTime,
    computeStats, filterTrades, periodRange, parseCSV, toCSV, exportCSV, EXPORT_COLS, importCSVText, importMT5ReportHTML, decodeBytes,
    groupWordsToLines, cleanOCRText, parseMT5Lines, reconcileRows, ocrRowToTrade, compareTrade, assessImport,
    mergeTrades, sameTrades, pruneTombstones, buildPayload, parsePayload
  };
});
