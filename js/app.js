/* 交易复盘工具 · 界面逻辑 */
(function () {
  'use strict';
  const C = window.TJCore, S = window.TJSync;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (v, sign = true) => { const n = Number(v) || 0; const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return (n < 0 ? '-' : (sign && n > 0 ? '+' : '')) + s; };
  const cls = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  const SETTINGS_KEY = 'mt5_journal_settings';

  // ---------- 状态 ----------
  const loaded = C.loadStore(localStorage);
  const state = loaded.state;
  const settings = Object.assign({ theme: 'auto', ocrLang: 'auto', period: 'all', sync: { backend: '', token: '', gistId: '', auto: true, lastSync: 0, lastError: '' } }, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  if (!settings.deviceId) settings.deviceId = 'dev-' + C.uid();
  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  saveSettings();
  let currentTab = 'dashboard';
  let calMonth = null;
  let listLimit = 60;
  let ocrRows = [];
  let importRows = [];
  const charts = {};

  const liveTrades = () => C.live(state.trades);
  function persist(opts = {}) {
    C.saveStore(localStorage, state);
    if (!opts.silent) scheduleSync();
    refreshLists();
    renderCurrent();
  }

  // ---------- 提示 ----------
  let toastTimer;
  function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms); }
  const alertHTML = (msg, type = 'info') => `<div class="alert alert-${type}">${msg}</div>`;

  // ---------- 主题 ----------
  function applyTheme() {
    let t = settings.theme; if (t === 'auto') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name=theme-color]').content = t === 'light' ? '#f3f6fb' : '#0b1220';
    $('#theme-select').value = settings.theme;
  }
  $('#theme-btn').onclick = () => { const cur = document.documentElement.dataset.theme; settings.theme = cur === 'dark' ? 'light' : 'dark'; saveSettings(); applyTheme(); renderCurrent(); };
  $('#theme-select').onchange = e => { settings.theme = e.target.value; saveSettings(); applyTheme(); renderCurrent(); };
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (settings.theme === 'auto') { applyTheme(); renderCurrent(); } });

  // ---------- 导航 ----------
  function showTab(name) {
    currentTab = name;
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$('.panel').forEach(p => p.classList.toggle('active', p.id === name));
    if (name === 'add' && !$('#edit-id').value && !$('#date').value) $('#date').value = toInputDT(new Date());
    renderCurrent();
    window.scrollTo({ top: 0 });
  }
  $$('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
  $('#sync-pill').onclick = () => showTab('more');
  function renderCurrent() {
    if (currentTab === 'dashboard') renderDashboard();
    else if (currentTab === 'trades') renderTrades();
    else if (currentTab === 'more') renderMore();
  }

  // ---------- 下拉选项 ----------
  function fillSelect(sel, values, keepFirst = true) {
    const el = $(sel); const cur = el.value;
    const first = keepFirst ? el.options[0].outerHTML : '';
    el.innerHTML = first + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    if ([...el.options].some(o => o.value === cur)) el.value = cur;
  }
  function refreshLists() {
    const lt = liveTrades();
    const syms = [...new Set(lt.map(t => t.symbol))].sort();
    const strats = [...new Set(lt.map(t => t.strategy).filter(Boolean))].sort();
    fillSelect('#filter-symbol', syms);
    fillSelect('#filter-strategy', strats);
    $('#symbol-list').innerHTML = syms.map(s => `<option value="${esc(s)}">`).join('');
    $('#strategy-list').innerHTML = strats.map(s => `<option value="${esc(s)}">`).join('');
    $('#sub-title').textContent = `共 ${lt.length} 笔交易`;
  }
  fillSelect('#filter-asset', C.ASSET_TYPES);
  $('#assetType').innerHTML = C.ASSET_TYPES.map(v => `<option value="${v}">${v}</option>`).join('');
  $('#emotion').innerHTML = '<option value="">无</option>' + C.EMOTIONS.map(v => `<option value="${v}">${v}</option>`).join('');

  // ---------- 图表 ----------
  const CHART_CDNS = [
    'https://registry.npmmirror.com/chart.js/4.4.1/files/dist/chart.umd.js',
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
    'https://fastly.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
    'https://unpkg.com/chart.js@4.4.1/dist/chart.umd.min.js'
  ];
  let chartPromise = null;
  function loadChart() {
    if (window.Chart) return Promise.resolve(window.Chart);
    if (chartPromise) return chartPromise;
    chartPromise = (async () => {
      for (const u of CHART_CDNS) {
        try {
          await new Promise((res, rej) => { const s = document.createElement('script'); s.src = u; s.async = true; const tm = setTimeout(() => { s.remove(); rej(); }, 8000); s.onload = () => { clearTimeout(tm); res(); }; s.onerror = () => { clearTimeout(tm); s.remove(); rej(); }; document.head.appendChild(s); });
          if (window.Chart) return window.Chart;
        } catch (e) { /* 下一个 */ }
      }
      throw new Error('图表库加载失败');
    })();
    chartPromise.catch(() => { chartPromise = null; });
    return chartPromise;
  }
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  function drawChart(id, config) {
    const el = document.getElementById(id); if (!el) return;
    if (!window.Chart) { loadChart().then(() => renderCurrent()).catch(() => { el.parentElement.innerHTML = '<div class="empty" style="padding:20px">图表库加载失败（网络问题），数据统计不受影响</div>'; }); return; }
    const muted = css('--muted'), grid = css('--grid');
    const base = {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { intersect: false, mode: 'index' },
      plugins: { legend: { display: config.type === 'doughnut', position: 'bottom', labels: { color: muted, boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: {} } },
      scales: config.type === 'doughnut' ? {} : {
        x: { ticks: { color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 6, font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: muted, font: { size: 10 } }, grid: { color: grid } }
      }
    };
    const options = Object.assign(base, config.options || {});
    if (charts[id] && charts[id].canvas !== el) { charts[id].destroy(); charts[id] = null; }
    if (charts[id]) {
      if (charts[id].config.type === config.type) { charts[id].data = config.data; charts[id].options = options; charts[id].update(); return; }
      charts[id].destroy(); charts[id] = null;
    }
    charts[id] = new window.Chart(el.getContext('2d'), { type: config.type, data: config.data, options });
  }
  const barColors = arr => arr.map(v => v >= 0 ? 'rgba(34,197,94,.75)' : 'rgba(240,77,94,.75)');

  // ---------- 概览 ----------
  $('#period-chips').addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; settings.period = b.dataset.p; saveSettings(); renderDashboard(); });
  function periodTrades() {
    const r = C.periodRange(settings.period);
    const lt = liveTrades();
    return r ? C.filterTrades(lt, { from: r.from, to: r.to }) : lt;
  }
  function renderDashboard() {
    $$('#period-chips .chip').forEach(c => c.classList.toggle('active', c.dataset.p === settings.period));
    const list = periodTrades();
    const s = C.computeStats(list);
    const pf = s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2);
    $('#hero').innerHTML = `
      <div class="label">总盈亏 · ${esc($('#period-chips .chip.active')?.textContent || '全部')}</div>
      <div class="big num">${money(s.totalPnL)}</div>
      <div class="row num"><span>胜率 <b>${s.winRate.toFixed(1)}%</b></span><span>交易 <b>${s.total}</b> 笔</span><span>盈利因子 <b>${pf}</b></span><span>期望 <b>${money(s.expectancy)}</b>/笔</span></div>`;
    const stat = (k, v, h = '', c = '') => `<div class="stat"><div class="k">${k}</div><div class="v num ${c}">${v}</div>${h ? `<div class="h num">${h}</div>` : ''}</div>`;
    $('#stats-grid').innerHTML = [
      stat('盈 / 亏 笔数', `<span class="pos">${s.wins}</span> / <span class="neg">${s.losses}</span>`, s.flat ? `持平 ${s.flat}` : ''),
      stat('平均盈利', money(s.avgWin), '', 'pos'),
      stat('平均亏损', money(s.avgLoss), '', 'neg'),
      stat('盈亏比', s.payoff ? s.payoff.toFixed(2) : '-', '平均盈利 ÷ 平均亏损'),
      stat('最大回撤', money(-s.maxDD), s.maxDDPct ? `峰值的 ${s.maxDDPct.toFixed(1)}%` : '', s.maxDD ? 'neg' : ''),
      stat('最大连胜 / 连亏', `${s.maxWinStreak} / ${s.maxLossStreak}`),
      stat('最佳单笔', s.best ? money(s.best.pnl) : '-', s.best ? esc(s.best.symbol) : '', 'pos'),
      stat('最差单笔', s.worst ? money(s.worst.pnl) : '-', s.worst ? esc(s.worst.symbol) : '', 'neg'),
      stat('毛利 / 毛损', `<span class="pos">${money(s.grossProfit, false)}</span>`, `<span class="neg">${money(s.grossLoss)}</span>`),
      stat('交易天数', s.tradingDays, s.tradingDays ? `日均 ${money(s.totalPnL / s.tradingDays)}` : ''),
      stat('总手数', C.round(s.totalLots, 2)),
      stat('多 / 空 笔数', `${s.longN} / ${s.shortN}`)
    ].join('');
    $('#eq-sub').textContent = s.total ? `${s.equity[0].x.slice(0, 10)} ~ ${s.equity[s.equity.length - 1].x.slice(0, 10)}` : '';
    const primary = css('--primary');
    drawChart('equityChart', {
      type: 'line',
      data: { labels: ['起点', ...s.equity.map(e => e.x.slice(5))], datasets: [{ label: '累计盈亏', data: [0, ...s.equity.map(e => e.y)], borderColor: primary, borderWidth: 2, pointRadius: s.total > 40 ? 0 : 2, fill: true, tension: .25, backgroundColor: ctxBg(primary) }] }
    });
    const recent = C.sortByTime(list).slice(-60);
    drawChart('pnlChart', { type: 'bar', data: { labels: recent.map(t => t.symbol + ' ' + (t.closeTime || t.date).slice(5, 10)), datasets: [{ label: '单笔盈亏', data: recent.map(t => t.pnl), backgroundColor: barColors(recent.map(t => t.pnl)), borderRadius: 3 }] } });
    const months = Object.keys(s.byMonth).sort().slice(-12);
    drawChart('monthChart', { type: 'bar', data: { labels: months, datasets: [{ label: '月度盈亏', data: months.map(m => C.round(s.byMonth[m])), backgroundColor: barColors(months.map(m => s.byMonth[m])), borderRadius: 4 }] } });
    const wd = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    drawChart('weekdayChart', { type: 'bar', data: { labels: wd, datasets: [{ label: '盈亏', data: s.byWeekday.map(v => C.round(v)), backgroundColor: barColors(s.byWeekday), borderRadius: 4 }] } });
    drawChart('hourChart', { type: 'bar', data: { labels: s.byHour.map((_, i) => i + '时'), datasets: [{ label: '盈亏', data: s.byHour.map(v => C.round(v)), backgroundColor: barColors(s.byHour), borderRadius: 3 }] } });
    const assets = Object.keys(s.byAsset);
    drawChart('assetChart', { type: 'doughnut', data: { labels: assets.map(a => `${a} ${money(s.byAsset[a].pnl)}`), datasets: [{ data: assets.map(a => Math.abs(C.round(s.byAsset[a].pnl)) || 0.0001), backgroundColor: ['#4f8cff', '#22c55e', '#f5a524', '#a855f7', '#f04d5e', '#06b6d4', '#84cc16', '#ec4899', '#94a3b8'], borderWidth: 0 }] }, options: { cutout: '62%' } });
    const ls = (n, p, label, c) => `<div class="list-row"><div><div class="t"><span class="side ${c}">${label}</span></div><div class="d">${n} 笔</div></div><div class="num ${cls(p)}" style="font-weight:700">${money(p)}</div></div>`;
    $('#longshort').innerHTML = ls(s.longN, s.longPnL, '做多 Buy', 'b') + ls(s.shortN, s.shortPnL, '做空 Sell', 's');
    $('#symbol-table').innerHTML = groupTable(s.bySymbol, '品种', true);
    $('#strategy-table').innerHTML = groupTable(s.byStrategy, '策略');
    $('#emotion-table').innerHTML = groupTable(s.byEmotion, '情绪');
    renderCalendar(list);
  }
  function ctxBg(color) {
    return ctx => { const ch = ctx.chart; const { ctx: c, chartArea } = ch; if (!chartArea) return 'transparent'; const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom); g.addColorStop(0, color + '55'); g.addColorStop(1, color + '00'); return g; };
  }
  function groupTable(obj, title, lots = false) {
    const rows = Object.entries(obj).sort((a, b) => b[1].pnl - a[1].pnl);
    if (!rows.length) return `<tr><td class="muted">暂无数据</td></tr>`;
    return `<tr><th>${title}</th><th>笔数</th><th>胜率</th>${lots ? '<th>手数</th>' : ''}<th>盈亏</th></tr>` + rows.map(([k, o]) => `<tr><td>${esc(k)}</td><td>${o.n}</td><td>${(o.wins / o.n * 100).toFixed(0)}%</td>${lots ? `<td>${C.round(o.lots, 2)}</td>` : ''}<td class="${cls(o.pnl)}">${money(o.pnl)}</td></tr>`).join('');
  }
  function renderCalendar(list) {
    const s = C.computeStats(list);
    if (!calMonth) {
      const last = C.sortByTime(liveTrades()).pop();
      const d = last ? C.tradeTime(last) : new Date();
      calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    }
    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    $('#cal-title').textContent = `${y}年${m + 1}月`;
    const first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7;
    let maxAbs = 0, sum = 0, n = 0, win = 0;
    for (let d = 1; d <= days; d++) { const o = s.byDay[C.dayKey(new Date(y, m, d))]; if (o) { maxAbs = Math.max(maxAbs, Math.abs(o.pnl)); sum += o.pnl; n += o.n; if (o.pnl > 0) win++; } }
    const todayKey = C.dayKey(new Date());
    let html = ['一', '二', '三', '四', '五', '六', '日'].map(w => `<div class="cal-wd">${w}</div>`).join('');
    for (let i = 0; i < lead; i++) html += '<div class="cal-cell empty"></div>';
    for (let d = 1; d <= days; d++) {
      const k = C.dayKey(new Date(y, m, d)); const o = s.byDay[k];
      let style = '';
      if (o && o.pnl) { const a = (0.18 + 0.62 * Math.min(1, Math.abs(o.pnl) / (maxAbs || 1))).toFixed(2); style = `background:${o.pnl > 0 ? `rgba(34,197,94,${a})` : `rgba(240,77,94,${a})`}`; }
      html += `<div class="cal-cell num ${k === todayKey ? 'today' : ''}" style="${style}" data-day="${k}" title="${k}${o ? ` ${o.n} 笔 ${money(o.pnl)}` : ''}"><span class="d">${d}</span>${o ? `<span class="p">${shortMoney(o.pnl)}</span>` : ''}</div>`;
    }
    $('#calendar').innerHTML = html;
    const tradingDays = Object.keys(s.byDay).filter(k => k.startsWith(`${y}-${C.pad(m + 1)}`)).length;
    $('#cal-sum').innerHTML = `<span>本月 ${n} 笔 · 盈利天数 ${win}/${tradingDays}</span><span class="num ${cls(sum)}" style="font-weight:700">${money(sum)}</span>`;
  }
  const shortMoney = v => { const a = Math.abs(v); const s = a >= 10000 ? (a / 1000).toFixed(0) + 'k' : a >= 1000 ? (a / 1000).toFixed(1) + 'k' : a.toFixed(a >= 100 ? 0 : 1); return (v < 0 ? '-' : '+') + s; };
  $('#cal-prev').onclick = () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); renderCalendar(periodTrades()); };
  $('#cal-next').onclick = () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); renderCalendar(periodTrades()); };
  $('#calendar').addEventListener('click', e => {
    const c = e.target.closest('[data-day]'); if (!c || !c.querySelector('.p')) return;
    $('#filter-from').value = c.dataset.day; $('#filter-to').value = c.dataset.day; $('#filters').classList.remove('hidden');
    showTab('trades');
  });

  // ---------- 交易列表 ----------
  function currentFilter() {
    return { keyword: $('#filter-keyword').value, symbol: $('#filter-symbol').value, asset: $('#filter-asset').value, side: $('#filter-side').value, result: $('#filter-result').value, strategy: $('#filter-strategy').value, from: $('#filter-from').value, to: $('#filter-to').value };
  }
  function renderTrades() {
    const list = C.sortByTime(C.filterTrades(liveTrades(), currentFilter()), true);
    const total = list.reduce((a, t) => a + t.pnl, 0);
    const wins = list.filter(t => t.pnl > 0).length;
    $('#list-summary').innerHTML = `<span>${list.length} 笔 · 胜率 ${list.length ? (wins / list.length * 100).toFixed(1) : 0}%</span><span class="${cls(total)}" style="font-weight:700">${money(total)}</span>`;
    if (!list.length) {
      $('#trade-list').innerHTML = `<div class="empty"><div class="em">🗂️</div>${liveTrades().length ? '没有符合条件的交易' : '还没有交易记录<br>点下方「截图记账」上传 MT5 截图，或「手动添加」'}</div>`;
      $('#list-more').innerHTML = '';
      return;
    }
    $('#trade-list').innerHTML = list.slice(0, listLimit).map(tradeCard).join('');
    $('#list-more').innerHTML = list.length > listLimit ? `<button class="btn btn-ghost btn-block" id="more-btn">加载更多（剩余 ${list.length - listLimit} 笔）</button>` : '';
    const mb = $('#more-btn'); if (mb) mb.onclick = () => { listLimit += 100; renderTrades(); };
  }
  function tradeCard(t) {
    const tags = [t.strategy, t.emotion, ...(t.tags || [])].filter(Boolean);
    return `<div class="trade ${t.pnl > 0 ? 'w' : t.pnl < 0 ? 'l' : ''}" data-id="${esc(t.id)}">
      <div class="sym">${esc(t.symbol)} <span class="side ${t.side === '空' ? 's' : 'b'}">${t.side === '空' ? 'sell' : 'buy'} ${esc(t.qty)}</span></div>
      <div class="pnl num ${cls(t.pnl)}">${money(t.pnl)}</div>
      <div class="meta num">${esc(t.entryPrice)} → ${esc(t.exitPrice)}</div>
      <div class="meta r num">${esc((t.closeTime || t.date || '').slice(0, 16))}</div>
      ${tags.length ? `<div class="tags">${tags.map(x => `<span class="tag">${esc(x)}</span>`).join('')}${t.notes ? '<span class="tag">📝</span>' : ''}</div>` : ''}
    </div>`;
  }
  let filterTimer;
  ['#filter-keyword'].forEach(s => $(s).addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => { listLimit = 60; renderTrades(); }, 150); }));
  ['#filter-symbol', '#filter-asset', '#filter-side', '#filter-result', '#filter-strategy', '#filter-from', '#filter-to'].forEach(s => $(s).addEventListener('change', () => { listLimit = 60; renderTrades(); }));
  $('#filter-toggle').onclick = () => $('#filters').classList.toggle('hidden');
  $('#filter-reset').onclick = () => { $$('#filters select, #filters input').forEach(e => e.value = ''); $('#filter-keyword').value = ''; renderTrades(); };
  $('#trade-list').addEventListener('click', e => { const c = e.target.closest('.trade'); if (c) openDetail(c.dataset.id); });

  // ---------- 详情弹层 ----------
  function openSheet(html) { $('#sheet').innerHTML = '<div class="grab"></div>' + html; $('#sheet-mask').classList.add('show'); }
  function closeSheet() { $('#sheet-mask').classList.remove('show'); }
  $('#sheet-mask').addEventListener('click', e => { if (e.target.id === 'sheet-mask') closeSheet(); });
  function openDetail(id) {
    const t = state.trades.find(x => x.id === id); if (!t) return;
    const row = (k, v) => v === '' || v === null || v === undefined ? '' : `<dt>${k}</dt><dd>${esc(v)}</dd>`;
    openSheet(`
      <div class="card-title"><h2>${esc(t.symbol)} <span class="side ${t.side === '空' ? 's' : 'b'}">${t.side === '空' ? 'sell' : 'buy'} ${esc(t.qty)}</span></h2><div class="num ${cls(t.pnl)}" style="font-size:1.4rem;font-weight:800">${money(t.pnl)}</div></div>
      <dl class="kv num">
        ${row('开仓价 → 平仓价', `${t.entryPrice} → ${t.exitPrice}`)}${row('平仓时间', t.closeTime || t.date)}${row('开仓时间', t.openTime)}
        ${row('订单号', t.ticket)}${row('资产类型', t.assetType)}${row('杠杆', t.leverage + 'x')}${row('实际盈亏', C.isNum(t.profit) ? t.profit : '')}${row('手续费', t.fee || '')}
        ${row('策略', t.strategy)}${row('情绪', t.emotion)}${row('标签', (t.tags || []).join(' '))}${row('来源', ({ manual: '手动', csv: 'CSV', mt5: 'MT5 报告', ocr: '截图识别' })[t.source] || t.source)}
      </dl>
      ${t.notes ? `<div class="card mt12" style="white-space:pre-wrap;font-size:.88rem">${esc(t.notes)}</div>` : ''}
      <div class="btn-row mt12"><button class="btn btn-danger" id="d-del">删除</button><button class="btn btn-ghost" id="d-dup">复制一笔</button><button class="btn btn-primary" id="d-edit">编辑 / 复盘</button></div>`);
    $('#d-edit').onclick = () => { closeSheet(); editTrade(id); };
    $('#d-dup').onclick = () => { closeSheet(); editTrade(id, true); };
    $('#d-del').onclick = () => { if (confirm('确定删除这条交易记录？')) { deleteTrade(id); closeSheet(); toast('已删除'); } };
  }
  function deleteTrade(id) {
    const i = state.trades.findIndex(x => x.id === id); if (i < 0) return;
    state.trades[i] = { id, deleted: true, updatedAt: Date.now() };
    persist();
  }

  // ---------- 表单 ----------
  const toInputDT = d => d ? `${d.getFullYear()}-${C.pad(d.getMonth() + 1)}-${C.pad(d.getDate())}T${C.pad(d.getHours())}:${C.pad(d.getMinutes())}:${C.pad(d.getSeconds())}` : '';
  function setSide(v) { $('#side').value = v; $$('#side-seg button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); updatePreview(); }
  $('#side-seg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setSide(b.dataset.v); });
  $('#assetType').addEventListener('change', () => {
    const lev = $('#leverage'); const cur = Number(lev.value);
    if (!lev.value || Object.values(C.DEFAULT_LEVERAGE).includes(cur)) lev.value = C.DEFAULT_LEVERAGE[$('#assetType').value] || 1;
    updatePreview();
  });
  $('#symbol').addEventListener('change', () => { if (!$('#edit-id').value) { $('#assetType').value = C.guessAssetType($('#symbol').value); $('#assetType').dispatchEvent(new Event('change')); } });
  function formRaw() {
    return {
      id: $('#edit-id').value || undefined, date: $('#date').value, closeTime: $('#date').value, openTime: $('#openTime').value,
      symbol: $('#symbol').value, assetType: $('#assetType').value, side: $('#side').value, qty: $('#qty').value,
      entryPrice: $('#entryPrice').value, exitPrice: $('#exitPrice').value, leverage: $('#leverage').value, fee: $('#fee').value,
      profit: $('#profit').value, ticket: $('#ticket').value, strategy: $('#strategy').value, emotion: $('#emotion').value, tags: $('#tags').value, notes: $('#notes').value
    };
  }
  function updatePreview() {
    const t = C.normalizeTrade(formRaw());
    $('#pnl-preview').innerHTML = (t.qty && t.entryPrice) ? `预计盈亏：<b class="${cls(t.pnl)}">${money(t.pnl)}</b>${C.isNum(t.profit) ? '（按实际盈亏）' : '（按公式）'}` : '';
  }
  $('#trade-form').addEventListener('input', updatePreview);
  $('#trade-form').addEventListener('submit', e => {
    e.preventDefault();
    const raw = formRaw();
    const old = raw.id ? state.trades.find(x => x.id === raw.id) : null;
    const t = C.normalizeTrade(raw, { source: old ? old.source : 'manual', createdAt: old ? old.createdAt : undefined });
    t.updatedAt = Date.now();
    if (old) { t.createdAt = old.createdAt || t.createdAt; t.source = old.source || 'manual'; }
    const errs = C.validateTrade(t);
    if (errs.length) { $('#form-alert').innerHTML = alertHTML('请检查：' + errs.join('；'), 'error'); return; }
    if (old) state.trades[state.trades.indexOf(old)] = t; else state.trades.push(t);
    persist();
    resetForm();
    toast(old ? '已更新' : '已保存');
    if (old) showTab('trades');
  });
  function resetForm() {
    $('#trade-form').reset(); $('#edit-id').value = ''; $('#form-title').textContent = '添加交易'; $('#submit-btn').textContent = '保存交易';
    $('#fee').value = 0; $('#date').value = toInputDT(new Date()); $('#assetType').value = '外汇'; $('#leverage').value = 100; setSide('多');
    $('#form-alert').innerHTML = ''; $('#pnl-preview').innerHTML = '';
  }
  $('#form-reset').onclick = resetForm;
  function editTrade(id, asCopy = false) {
    const t = state.trades.find(x => x.id === id); if (!t) return;
    $('#edit-id').value = asCopy ? '' : t.id;
    $('#date').value = toInputDT(C.parseDate(t.closeTime || t.date));
    $('#openTime').value = toInputDT(C.parseDate(t.openTime));
    $('#symbol').value = t.symbol; $('#assetType').value = C.ASSET_TYPES.includes(t.assetType) ? t.assetType : '其他';
    setSide(t.side); $('#qty').value = t.qty; $('#entryPrice').value = t.entryPrice; $('#exitPrice').value = t.exitPrice;
    $('#leverage').value = t.leverage || 1; $('#fee').value = t.fee || 0; $('#profit').value = C.isNum(t.profit) ? t.profit : '';
    $('#ticket').value = asCopy ? '' : (t.ticket || ''); $('#strategy').value = t.strategy || ''; $('#emotion').value = t.emotion || '';
    $('#tags').value = (t.tags || []).join(' '); $('#notes').value = t.notes || '';
    $('#form-title').textContent = asCopy ? '复制交易' : '编辑交易'; $('#submit-btn').textContent = asCopy ? '保存为新交易' : '更新交易';
    showTab('add'); updatePreview();
  }

  // ---------- 截图识别 ----------
  const ocrDrop = $('#ocr-drop'), ocrFile = $('#ocr-file');
  ocrDrop.onclick = () => ocrFile.click();
  ocrFile.onchange = () => { if (ocrFile.files.length) handleImages([...ocrFile.files]); ocrFile.value = ''; };
  ocrDrop.addEventListener('dragover', e => { e.preventDefault(); ocrDrop.classList.add('over'); });
  ocrDrop.addEventListener('dragleave', () => ocrDrop.classList.remove('over'));
  ocrDrop.addEventListener('drop', e => { e.preventDefault(); ocrDrop.classList.remove('over'); const fs = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/')); if (fs.length) handleImages(fs); });
  document.addEventListener('paste', e => {
    const fs = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (fs.length && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) { e.preventDefault(); showTab('quick'); handleImages(fs); }
  });
  $('#ocr-lang').value = settings.ocrLang;
  $('#ocr-lang').onchange = e => { settings.ocrLang = e.target.value; saveSettings(); };

  function setOCRProgress(msg, p) { $('#ocr-status').style.display = 'block'; $('#ocr-msg').textContent = msg; if (p !== undefined) $('#ocr-bar').style.width = Math.round(p * 100) + '%'; }
  async function ocrOne(file, log) {
    const mode = settings.ocrLang;
    const tryLang = async lang => {
      const r = await window.TJOCR.recognize(file, { lang, log });
      let rows = C.parseMT5Lines(C.groupWordsToLines(r.words));
      if (!rows.length && r.text) rows = C.parseMT5Lines(r.text.split('\n'));
      return { rows, text: r.text };
    };
    let res = await tryLang(mode === 'auto' ? 'eng' : mode);
    if (!res.rows.length && mode === 'auto') res = await tryLang('chi_sim+eng');
    return res;
  }
  let ocrBusy = false;
  async function handleImages(files) {
    if (ocrBusy) { toast('正在识别中，请稍候'); return; }
    ocrBusy = true;
    $('#ocr-alert').innerHTML = '';
    $('#ocr-thumbs').innerHTML = files.map(f => `<img src="${URL.createObjectURL(f)}" alt="截图">`).join('');
    const all = []; const raws = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const prefix = files.length > 1 ? `第 ${i + 1}/${files.length} 张：` : '';
        const { rows, text } = await ocrOne(files[i], (m, p) => setOCRProgress(prefix + m, p));
        rows.forEach(r => { r.group = i; all.push(r); });
        raws.push(`【图 ${i + 1}】\n` + text.trim());
      }
      C.reconcileRows(all, state.trades);
      C.assessImport(all, state.trades);
      all.forEach(r => { r.checked = r.status === 'new' && !r.flags.some(f => /未识别|未完整/.test(f)); });
      ocrRows = all;
      $('#ocr-raw').textContent = raws.join('\n\n');
      setOCRProgress(`识别完成：${all.length} 笔，新订单 ${all.filter(r => r.status === 'new').length} 笔`, 1);
      if (!all.length) $('#ocr-alert').innerHTML = alertHTML('没有识别到订单。请确认是 MT5「历史 → 持仓」列表截图，或切换识别语言后重试。', 'error');
      renderReview();
    } catch (e) {
      console.warn(e);
      $('#ocr-alert').innerHTML = alertHTML('识别失败：' + esc(e.message || e), 'error');
      setOCRProgress('识别失败', 0);
    } finally { ocrBusy = false; }
  }
  const STATUS = { new: ['new', '新订单'], dup: ['dup', '重复'], maybe: ['maybe', '疑似重复'] };
  function renderReview() {
    const card = $('#review-card');
    if (!ocrRows.length) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    const n = ocrRows.filter(r => r.checked).length;
    $('#review-sub').textContent = `${ocrRows.length} 笔 · 已选 ${n}`;
    $('#review-confirm').textContent = `添加选中（${n}）`;
    $('#review-confirm').disabled = !n;
    $('#review-list').innerHTML = ocrRows.map((r, i) => {
      const [c, label] = STATUS[r.status] || STATUS.new;
      const fixed = r.flags.some(f => /校正|推算|正负/.test(f));
      const pnl = Number(r.profit);
      if (r.open === undefined) r.open = r.flags.length > 0;
      return `<div class="rv ${r.status === 'dup' ? 'dup' : ''}" data-i="${i}">
        <div class="rv-top">
          <input type="checkbox" data-k="checked" ${r.checked ? 'checked' : ''} aria-label="选择">
          <b>${esc(r.symbol)}</b><span class="side ${r.side === '空' ? 's' : 'b'}">${r.side === '空' ? 'sell' : 'buy'}</span>
          <span class="badge ${c}">${label}${r.dupInBatch ? '(本批)' : ''}</span>${fixed ? '<span class="badge fix">已校正</span>' : ''}
          <span class="num ${cls(pnl)}" style="margin-left:auto;font-weight:700">${isFinite(pnl) ? money(pnl) : '?'}</span>
        </div>
        <div class="rv-meta num"><span>${esc(isFinite(r.entryPrice) ? r.entryPrice : '?')} → ${esc(isFinite(r.exitPrice) ? r.exitPrice : '?')} · ${esc(isFinite(r.qty) ? r.qty : '?')} 手</span><span>${esc(r.closeTime || '时间未识别')}</span><button type="button" class="rv-edit" data-act="edit">${r.open ? '收起' : '修改'}</button></div>
        <div class="rv-grid num" ${r.open ? '' : 'hidden'}>
          <div><label>方向</label><select data-k="side"><option value="多" ${r.side === '多' ? 'selected' : ''}>buy</option><option value="空" ${r.side === '空' ? 'selected' : ''}>sell</option></select></div>
          <div><label>手数</label><input data-k="qty" inputmode="decimal" value="${esc(isFinite(r.qty) ? r.qty : '')}"></div>
          <div><label>盈亏</label><input data-k="profit" inputmode="decimal" value="${esc(isFinite(r.profit) ? r.profit : '')}"></div>
          <div><label>开仓价</label><input data-k="entryPrice" inputmode="decimal" value="${esc(isFinite(r.entryPrice) ? r.entryPrice : '')}"></div>
          <div><label>平仓价</label><input data-k="exitPrice" inputmode="decimal" value="${esc(isFinite(r.exitPrice) ? r.exitPrice : '')}"></div>
          <div><label>品种</label><input data-k="symbol" value="${esc(r.symbol)}" autocapitalize="characters"></div>
          <div class="full" style="grid-column:1/-1"><label>平仓时间</label><input data-k="closeTime" value="${esc(r.closeTime)}" placeholder="YYYY-MM-DD HH:mm:ss"></div>
        </div>
        ${r.flags.length ? `<div class="rv-flags">⚠️ ${esc(r.flags.join('；'))}</div>` : ''}
      </div>`;
    }).join('');
  }
  $('#review-list').addEventListener('click', e => {
    const b = e.target.closest('[data-act=edit]'); if (!b) return;
    const r = ocrRows[+b.closest('.rv').dataset.i]; r.open = !r.open; renderReview();
  });
  $('#review-list').addEventListener('change', e => {
    const el = e.target, box = el.closest('.rv'); if (!box) return;
    const r = ocrRows[+box.dataset.i], k = el.dataset.k;
    if (k === 'checked') { r.checked = el.checked; r.userTouched = true; renderReview(); return; }
    r[k] = ['qty', 'profit', 'entryPrice', 'exitPrice'].includes(k) ? Number(String(el.value).replace(',', '.')) : (k === 'closeTime' ? C.normDateStr(el.value) || el.value : (k === 'symbol' ? el.value.trim().toUpperCase() : el.value));
    if (k === 'side') r.side = el.value;
    // 重新判重（保留用户手动勾选的行）
    const copy = ocrRows.map(x => Object.assign(x, { status: undefined }));
    C.assessImport(copy, state.trades);
    copy.forEach(x => { if (!x.userTouched) x.checked = x.status === 'new'; });
    renderReview();
  });
  $('#review-cancel').onclick = () => { ocrRows = []; renderReview(); $('#ocr-thumbs').innerHTML = ''; $('#ocr-status').style.display = 'none'; };
  $('#review-confirm').onclick = () => {
    const strategy = $('#batch-strategy').value.trim(), tags = $('#batch-tags').value.trim();
    const sel = ocrRows.filter(r => r.checked);
    const bad = []; let added = 0;
    for (const r of sel) {
      const t = C.ocrRowToTrade(r);
      if (strategy) t.strategy = strategy;
      if (tags) t.tags = tags.split(/\s+/);
      const e = C.validateTrade(t);
      if (e.length) { bad.push(`${r.symbol} ${r.closeTime}：${e.join('，')}`); continue; }
      state.trades.push(t); added++;
    }
    persist();
    if (bad.length) $('#ocr-alert').innerHTML = alertHTML('以下订单数据不完整未添加，请修正后再试：<br>' + bad.map(esc).join('<br>'), 'error');
    const failed = new Set(sel.filter(r => C.validateTrade(C.ocrRowToTrade(r)).length));
    ocrRows = ocrRows.filter(r => failed.has(r));
    renderReview();
    if (!ocrRows.length) { $('#ocr-thumbs').innerHTML = ''; }
    toast(`已添加 ${added} 笔交易`);
  };

  // ---------- 文件导入 ----------
  const fileDrop = $('#file-drop'), dataFile = $('#data-file');
  fileDrop.onclick = () => dataFile.click();
  fileDrop.addEventListener('dragover', e => { e.preventDefault(); fileDrop.classList.add('over'); });
  fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('over'));
  fileDrop.addEventListener('drop', e => { e.preventDefault(); fileDrop.classList.remove('over'); if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]); });
  dataFile.onchange = () => { if (dataFile.files[0]) importFile(dataFile.files[0]); dataFile.value = ''; };
  async function importFile(file) {
    const box = $('#import-alert');
    try {
      const text = C.decodeBytes(await file.arrayBuffer());
      const name = file.name.toLowerCase();
      if (name.endsWith('.json') || /^\s*[\[{]/.test(text)) {
        const incoming = C.parsePayload(JSON.parse(text));
        const before = liveTrades().length;
        const { merged } = C.mergeTrades(state.trades, incoming);
        if (!confirm(`备份中有 ${C.live(incoming).length} 笔交易，将与本机 ${before} 笔合并（相同记录保留较新的版本）。继续？`)) return;
        state.trades = merged; persist();
        box.innerHTML = alertHTML(`恢复完成：现在共有 ${liveTrades().length} 笔（新增 ${liveTrades().length - before}）`, 'success');
        return;
      }
      const res = /<html|<table/i.test(text) ? C.importMT5ReportHTML(text, DOMParser) : C.importCSVText(text);
      if (!res.trades.length) { box.innerHTML = alertHTML('没有可导入的交易：' + esc(res.errors.slice(0, 6).join('；')), 'error'); return; }
      importRows = C.assessImport(res.trades.map(t => Object.assign(t, {})), state.trades);
      importRows.forEach(r => r.checked = r.status === 'new');
      box.innerHTML = alertHTML(`识别为「${res.format}」：${res.trades.length} 笔，其中新交易 ${importRows.filter(r => r.status === 'new').length} 笔` + (res.errors.length ? `，跳过 ${res.errors.length} 行错误` : ''), res.errors.length ? 'info' : 'success');
      renderImport();
    } catch (e) { box.innerHTML = alertHTML('导入失败：' + esc(e.message), 'error'); }
  }
  function renderImport() {
    $('#import-preview').style.display = importRows.length ? 'block' : 'none';
    $('#import-list').innerHTML = importRows.slice(0, 300).map((t, i) => {
      const [c, label] = STATUS[t.status] || STATUS.new;
      return `<div class="rv ${t.status === 'dup' ? 'dup' : ''}" data-i="${i}"><div class="rv-top"><input type="checkbox" ${t.checked ? 'checked' : ''}><b>${esc(t.symbol)}</b><span class="side ${t.side === '空' ? 's' : 'b'}">${t.side === '空' ? 'sell' : 'buy'} ${esc(t.qty)}</span><span class="badge ${c}">${label}</span><span class="num ${cls(t.pnl)}" style="margin-left:auto;font-weight:700">${money(t.pnl)}</span></div><div class="meta muted num" style="font-size:.76rem;margin-top:4px">${esc(t.entryPrice)} → ${esc(t.exitPrice)} · ${esc(t.closeTime || t.date)}${t.ticket ? ' · #' + esc(t.ticket) : ''}</div></div>`;
    }).join('') + (importRows.length > 300 ? `<div class="muted hint">…其余 ${importRows.length - 300} 笔按默认勾选状态导入</div>` : '');
    $('#import-confirm').textContent = `确认导入（${importRows.filter(r => r.checked).length}）`;
  }
  $('#import-list').addEventListener('change', e => { const b = e.target.closest('.rv'); if (b) { importRows[+b.dataset.i].checked = e.target.checked; renderImport(); } });
  $('#import-cancel').onclick = () => { importRows = []; renderImport(); $('#import-alert').innerHTML = ''; };
  $('#import-confirm').onclick = () => {
    const sel = importRows.filter(r => r.checked);
    sel.forEach(r => { delete r.status; delete r.checked; delete r.dupOf; delete r.dupInBatch; delete r.group; r.updatedAt = Date.now(); state.trades.push(r); });
    importRows = []; renderImport(); persist();
    $('#import-alert').innerHTML = alertHTML(`导入完成：新增 ${sel.length} 笔`, 'success');
  };
  $('#tpl-btn').onclick = () => download('交易导入模板.csv', new Blob(['\ufeff' + C.toCSV([['date', 'symbol', 'assetType', 'side', 'qty', 'entryPrice', 'exitPrice', 'leverage', 'fee', 'profit', 'ticket', 'strategy', 'emotion', 'tags', 'notes'], ['2026-01-15 09:30:00', 'XAUUSD', '贵金属', 'buy', '0.10', '2650.5', '2662.1', '100', '0', '116', '', '突破', '冷静', '伦敦盘', '示例'], ['2026-01-16 14:00', 'EURUSD', '外汇', 'sell', '1', '1.0920', '1.0850', '100', '7', '', '', '趋势跟踪', '冷静', '', '不填 profit 则按公式计算']])], { type: 'text/csv;charset=utf-8' }));

  // ---------- 导出 ----------
  async function download(name, blob) {
    const isIOSApp = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    if (isIOSApp && navigator.canShare) {
      try { const f = new File([blob], name, { type: blob.type }); if (navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: name }); return; } } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const today = () => C.fmtDate(new Date(), false).slice(0, 10);
  $('#export-csv').onclick = () => { const lt = C.sortByTime(liveTrades()); if (!lt.length) return toast('暂无数据'); download(`交易记录_${today()}.csv`, new Blob([C.exportCSV(lt)], { type: 'text/csv;charset=utf-8' })); };
  $('#export-json').onclick = () => { if (!state.trades.length) return toast('暂无数据'); download(`交易复盘备份_${today()}.json`, new Blob([JSON.stringify(C.buildPayload(state.trades, settings.deviceId), null, 1)], { type: 'application/json' })); };
  $('#clear-btn').onclick = () => {
    const syncing = settings.sync.backend && settings.sync.token;
    if (!confirm('确定清空所有交易数据？' + (syncing ? '\n已开启同步：云端和其它设备上的记录也会被删除！' : '此操作不可恢复！') + '\n建议先导出 JSON 备份。')) return;
    const now = Date.now();
    state.trades = state.trades.map(t => ({ id: t.id, deleted: true, updatedAt: now }));
    persist(); toast('已清空');
  };

  // ---------- 同步 ----------
  Object.entries(S.BACKENDS).forEach(([k, b]) => $('#sync-backend').insertAdjacentHTML('beforeend', `<option value="${k}">${esc(b.name)}</option>`));
  let syncTimer = null, syncing = false, syncAgain = false;
  function syncConfigured() { const s = settings.sync; return !!(s.backend && s.token && S.BACKENDS[s.backend]); }
  function setSyncUI(status, text) {
    $('#sync-dot').className = 'dot ' + (status || '');
    $('#sync-text').textContent = text;
  }
  function idleSyncUI() {
    if (!syncConfigured()) return setSyncUI('', '本机');
    if (settings.sync.lastError) return setSyncUI('err', '同步失败');
    setSyncUI('ok', settings.sync.lastSync ? '已同步' : '待同步');
  }
  function scheduleSync(delay = 2500) {
    if (!syncConfigured() || !settings.sync.auto) return;
    clearTimeout(syncTimer); syncTimer = setTimeout(() => runSync(), delay);
  }
  async function runSync(manual = false) {
    if (!syncConfigured()) return null;
    if (syncing) { syncAgain = true; return null; }
    if (!navigator.onLine) { setSyncUI('err', '离线'); return null; }
    syncing = true; setSyncUI('busy', '同步中');
    const s = settings.sync;
    try {
      const backend = S.BACKENDS[s.backend].create({ token: s.token, gistId: s.gistId });
      const r = await S.syncOnce(backend, {
        getLocal: () => state.trades,
        setLocal: list => { state.trades = list; C.saveStore(localStorage, state); },
        device: settings.deviceId
      });
      s.gistId = r.remoteId || s.gistId; s.lastSync = Date.now(); s.lastError = ''; saveSettings();
      if (r.localChanged) { refreshLists(); renderCurrent(); }
      if (manual) toast(`同步完成：共 ${r.total} 笔${r.fromRemote ? `，从云端更新 ${r.fromRemote} 笔` : ''}${r.pushed ? '，已上传' : ''}`);
      if (currentTab === 'more') renderMore();
      return r;
    } catch (e) {
      s.lastError = e.message || String(e); saveSettings();
      if (manual) $('#sync-alert').innerHTML = alertHTML('同步失败：' + esc(s.lastError), 'error');
      if (currentTab === 'more') renderMore();
      return null;
    } finally {
      syncing = false; idleSyncUI();
      if (syncAgain) { syncAgain = false; scheduleSync(800); }
    }
  }
  function readSyncForm() {
    const s = settings.sync;
    const backend = $('#sync-backend').value, token = $('#sync-token').value.trim(), gist = $('#sync-gist').value.trim();
    if (backend !== s.backend || token !== s.token) { s.lastSync = 0; }
    s.backend = backend; s.token = token; s.gistId = gist.replace(/^https?:\/\/gist\.github\.com\/[^/]+\//, '').replace(/[^\w-]/g, ''); s.auto = $('#sync-auto').checked; s.lastError = '';
    saveSettings();
  }
  $('#sync-save').onclick = async () => {
    readSyncForm();
    if (!syncConfigured()) { $('#sync-alert').innerHTML = alertHTML(settings.sync.backend ? '请填写访问令牌' : '已设为仅本机保存', settings.sync.backend ? 'error' : 'info'); idleSyncUI(); return; }
    $('#sync-alert').innerHTML = alertHTML('正在同步…');
    const r = await runSync(true);
    if (r) $('#sync-alert').innerHTML = alertHTML(`✅ 同步成功！本机共 ${r.total} 笔。Gist ID：<code>${esc(settings.sync.gistId)}</code>`, 'success');
  };
  $('#sync-test').onclick = async () => {
    readSyncForm();
    if (!syncConfigured()) { $('#sync-alert').innerHTML = alertHTML('请先选择同步服务并填写令牌', 'error'); return; }
    $('#sync-alert').innerHTML = alertHTML('正在测试…');
    try { const msg = await S.BACKENDS[settings.sync.backend].create({ token: settings.sync.token }).test(); $('#sync-alert').innerHTML = alertHTML('✅ ' + esc(msg), 'success'); }
    catch (e) { $('#sync-alert').innerHTML = alertHTML('❌ ' + esc(e.message), 'error'); }
  };
  $('#sync-off').onclick = () => {
    if (!confirm('断开后本机不再同步（本机数据和云端 Gist 都会保留）。继续？')) return;
    Object.assign(settings.sync, { backend: '', token: '', gistId: '', lastSync: 0, lastError: '' }); saveSettings(); renderMore(); idleSyncUI(); $('#sync-alert').innerHTML = alertHTML('已断开同步');
  };
  $('#sync-auto').onchange = () => { settings.sync.auto = $('#sync-auto').checked; saveSettings(); };
  function renderMore() {
    const s = settings.sync;
    if (document.activeElement?.closest?.('#sync-card') == null) {
      $('#sync-backend').value = s.backend || ''; $('#sync-token').value = s.token || ''; $('#sync-gist').value = s.gistId || ''; $('#sync-auto').checked = s.auto !== false;
    }
    $('#sync-last').textContent = s.lastSync ? '上次 ' + C.fmtDate(new Date(s.lastSync), false).slice(5) : '';
    $('#token-help').open = !s.token;
    const lt = liveTrades();
    const bytes = (localStorage.getItem(C.DATA_KEY) || '').length * 2;
    $('#data-info').textContent = `${lt.length} 笔交易 · 约 ${(bytes / 1024).toFixed(0)} KB` + (state.migratedFrom ? ' · 已从旧版自动迁移' : '');
    if (s.lastError && !$('#sync-alert').innerHTML) $('#sync-alert').innerHTML = alertHTML('上次同步失败：' + esc(s.lastError), 'error');
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(300); });
  window.addEventListener('online', () => scheduleSync(500));

  // ---------- 启动 ----------
  applyTheme();
  resetForm();
  refreshLists();
  idleSyncUI();
  renderDashboard();
  loadChart().then(() => renderCurrent()).catch(() => {});
  if (loaded.migrated) toast(`已自动迁移旧版数据 ${state.trades.length} 笔`, 3500);
  if (syncConfigured() && settings.sync.auto) scheduleSync(600);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});

  // 测试 / 调试钩子
  window.__journal = { state, settings, handleImages, runSync, get ocrRows() { return ocrRows; }, renderCurrent, showTab };
})();
