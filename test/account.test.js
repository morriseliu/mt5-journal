/**
 * 资金账户、旧数据兼容、同步合并。node test/account.test.js
 */
const assert = require('assert');
const C = require('../js/core.js');
const S = require('../js/sync.js');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('ok', name); }
  catch (e) { failed++; console.error('FAIL', name, e && e.stack || e); }
}

function mem() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _m: m
  };
}
function trade(extra) {
  return C.normalizeTrade(Object.assign({
    id: extra && extra.id || 't',
    symbol: 'XAUUSD', assetType: '贵金属', side: '多', qty: 0.1,
    entryPrice: 2600, exitPrice: 2610, leverage: 100, fee: 0,
    date: '2026-11-01 15:00:00', closeTime: '2026-11-01 15:00:00',
    updatedAt: 10, createdAt: 10
  }, extra));
}

check('calcPnL 净盈亏含手续费', () => {
  const t = trade({ profit: 50, fee: 2, id: 'fee' });
  assert.strictEqual(t.pnl, 48);
  assert.strictEqual(C.calcPnL(t), 48);
});

check('MT5 口径：利润+手续费+库存费已计入 profit，不再二次扣减', () => {
  const gross = 100, commission = -2, swap = -1.5;
  const t = trade({
    id: 'mt5', profit: C.round(gross + commission + swap, 2), fee: 0, commission, swap
  });
  assert.strictEqual(t.pnl, 96.5);
});

check('余额 = 初始 + 净入金 + 已实现净盈亏；同日合并；删除的交易不计', () => {
  const a = trade({ id: 'a', profit: 50, fee: 2, closeTime: '2026-11-09 23:40:00', date: '2026-11-09 23:40:00' }); // 48
  const b = trade({ id: 'b', profit: 97, fee: 0, closeTime: '2026-11-10 00:30:00', date: '2026-11-10 00:30:00' }); // 97
  const gone = trade({ id: 'c', profit: 999, fee: 0 });
  gone.deleted = true;
  const account = {
    currency: 'USD', initialBalance: 1000, updatedAt: 5,
    cashflows: [
      { id: 'in', date: '2026-11-02', amount: 250.5, note: '入' },
      { id: 'out', date: '2026-11-03', amount: -80.25, note: '出' }
    ]
  };
  const s = C.computeAccountSummary([a, b, gone], account, 123);
  assert.strictEqual(s.currency, 'USD');
  assert.strictEqual(s.initialBalance, 1000);
  assert.strictEqual(s.netDeposits, 170.25);
  assert.strictEqual(s.realizedPnl, 145);
  assert.strictEqual(s.balance, 1315.25);
  assert.deepStrictEqual(s.daily, [
    { date: '2026-11-09', pnl: 48 },
    { date: '2026-11-10', pnl: 97 }
  ]);
  assert.strictEqual(s.updatedAt, 123);
  assert.deepStrictEqual(Object.keys(s).sort(), ['balance', 'cashflows', 'currency', 'daily', 'initialBalance', 'netDeposits', 'realizedPnl', 'updatedAt']);
  assert.deepStrictEqual(Object.keys(s.cashflows[0]).sort(), ['amount', 'date', 'id', 'note']);
  assert.deepStrictEqual(Object.keys(s.daily[0]).sort(), ['date', 'pnl']);
});

check('纯时间戳按北京时间取日历日', () => {
  const key = C.closeDayKey({ closeTime: Date.parse('2026-01-01T16:30:00Z') });
  assert.strictEqual(key, '2026-01-02');
});

check('钟面时间不随运行环境时区平移', () => {
  assert.strictEqual(C.closeDayKey({ closeTime: '2026-11-09 23:30:00' }), '2026-11-09');
  assert.strictEqual(C.closeDayKey({ date: '2026.11.10 00:05:00' }), '2026-11-10');
});

check('同一天多笔相加', () => {
  const a = trade({ id: 'a', profit: 10, fee: 0, closeTime: '2026-05-01 01:00:00', date: '2026-05-01 01:00:00' });
  const b = trade({ id: 'b', profit: -4, fee: 1, closeTime: '2026-05-01 22:00:00', date: '2026-05-01 22:00:00' });
  const s = C.computeAccountSummary([b, a], C.defaultAccount(), 1);
  assert.deepStrictEqual(s.daily, [{ date: '2026-05-01', pnl: 5 }]);
  assert.strictEqual(s.realizedPnl, 5);
});

check('旧版纯数组不丢交易，且不带 account', () => {
  const env = C.parseEnvelope([
    { id: 'a', symbol: 'EURUSD', side: 'buy', qty: 1, entryPrice: 1, exitPrice: 1.1, date: '2026-05-01 00:00:00', updatedAt: 1 },
    { id: 'b', symbol: 'USDJPY', side: 'sell', qty: 2, entryPrice: 150, exitPrice: 149, date: '2026-05-02 00:00:00', updatedAt: 2 }
  ]);
  assert.strictEqual(env.account, null);
  assert.deepStrictEqual(env.trades.map(t => t.id).sort(), ['a', 'b']);
});

check('旧版对象保留墓碑和全部交易，没有 account 时为 null', () => {
  const env = C.parseEnvelope({
    app: 'mt5-journal', schema: 2, updatedAt: '2026-01-01T00:00:00.000Z', device: 'dev',
    trades: [
      { id: 'y', symbol: 'XAUUSD', side: '多', qty: 1, entryPrice: 1, exitPrice: 2, date: '2026-06-01 00:00:00', updatedAt: 4 },
      { id: 'z', deleted: true, updatedAt: 9 }
    ]
  });
  assert.strictEqual(env.account, null);
  assert.strictEqual(env.trades.length, 2);
  assert.strictEqual(env.trades.find(t => t.id === 'z').deleted, true);
  assert.strictEqual(env.trades.find(t => t.id === 'y').symbol, 'XAUUSD');
});

check('新版信封来回不丢字段', () => {
  const account = { currency: 'usd', initialBalance: 10, updatedAt: 8, cashflows: [{ id: 'c1', date: '2026-01-02', amount: -3.5, note: '出' }] };
  const payload = C.buildPayload([{ id: 't1', updatedAt: 1 }], account);
  assert.strictEqual(payload.version, 2);
  assert.strictEqual(payload.schema, undefined);
  const env = C.parseEnvelope(payload);
  assert.strictEqual(env.trades.length, 1);
  assert.strictEqual(env.trades[0].id, 't1');
  assert.strictEqual(env.account.currency, 'USD');
  assert.strictEqual(env.account.initialBalance, 10);
  assert.strictEqual(env.account.cashflows[0].amount, -3.5);
  assert.strictEqual(env.account.updatedAt, 8);
});

check('account 新者胜，旧的远端不会清掉本地流水', () => {
  const local = { currency: 'USD', initialBalance: 1000, updatedAt: 300, cashflows: [{ id: 'a', date: '2026-01-01', amount: 50, note: '' }] };
  const older = { currency: 'USD', initialBalance: 1, updatedAt: 100, cashflows: [] };
  const newer = { currency: 'CNY', initialBalance: 9, updatedAt: 400, cashflows: [{ id: 'b', date: '2026-02-01', amount: 2, note: 'n' }] };
  const keep = C.mergeAccount(local, older);
  assert.strictEqual(keep.initialBalance, 1000);
  assert.strictEqual(keep.cashflows.length, 1);
  const win = C.mergeAccount(local, newer);
  assert.strictEqual(win.currency, 'CNY');
  assert.strictEqual(win.cashflows[0].id, 'b');
  assert.strictEqual(C.mergeAccount(local, null).cashflows.length, 1);
});

check('本地已有 v2 交易但没有 account：补上默认账户且交易还在', () => {
  const storage = mem();
  const tomb = { id: 'gone', deleted: true, updatedAt: 3 };
  storage.setItem(C.DATA_KEY, JSON.stringify({ schema: 2, trades: [trade({ id: 'keep', updatedAt: 2 }), tomb] }));
  const { state } = C.loadStore(storage);
  assert.strictEqual(state.trades.length, 2);
  assert.ok(state.trades.some(t => t.id === 'keep' && !t.deleted));
  assert.ok(state.trades.some(t => t.id === 'gone' && t.deleted));
  assert.strictEqual(state.account.currency, 'USD');
  assert.strictEqual(state.account.initialBalance, 0);
  assert.strictEqual(state.account.updatedAt, 0);
  const saved = JSON.parse(storage.getItem(C.DATA_KEY));
  assert.strictEqual(saved.trades.length, 2);
  assert.ok(saved.account);
});

check('旧版 trading_journal_v1 迁移不丢记录', () => {
  const storage = mem();
  storage.setItem(C.OLD_KEY, JSON.stringify([
    { id: 'old1', symbol: 'EURUSD', side: 'buy', qty: 1, entryPrice: 1.1, exitPrice: 1.2, date: '2026-01-02 00:00:00' },
    { id: 'old2', symbol: 'GBPUSD', side: 'sell', qty: 2, entryPrice: 1.3, exitPrice: 1.2, date: '2026-01-03 00:00:00' }
  ]));
  const { state, migrated } = C.loadStore(storage);
  assert.strictEqual(migrated, true);
  assert.deepStrictEqual(state.trades.map(t => t.id).sort(), ['old1', 'old2']);
  assert.strictEqual(state.account.currency, 'USD');
  assert.strictEqual(JSON.parse(storage.getItem(C.OLD_KEY)).length, 2);
});

check('summary 内容不变时不刷新 updatedAt', () => {
  const storage = mem();
  const state = { trades: [trade({ id: 'a', profit: 10, fee: 0 })], account: C.defaultAccount() };
  const s1 = C.writeAccountSummary(storage, state, 1000);
  const s2 = C.writeAccountSummary(storage, state, 2000);
  assert.strictEqual(s2.updatedAt, 1000);
  state.account = Object.assign({}, state.account, { initialBalance: 5, updatedAt: 9 });
  const s3 = C.writeAccountSummary(storage, state, 3000);
  assert.strictEqual(s3.updatedAt, 3000);
  assert.strictEqual(s3.initialBalance, 5);
  assert.strictEqual(s3.balance, 15);
  const raw = JSON.parse(storage.getItem(C.SUMMARY_KEY));
  assert.strictEqual(C.SUMMARY_KEY, 'mt5_journal_account_summary');
  assert.strictEqual(raw.currency, 'USD');
});

function fakeBackend(initial) {
  const box = { data: initial, id: 'g1' };
  return {
    box,
    pull: async () => (box.data == null ? null : { data: box.data, remoteId: box.id }),
    push: async data => { box.data = data; return box.id; }
  };
}

async function runAsync() {
  await new Promise(resolve => checkAsync(resolve));
  async function checkAsync(resolve) {
    try {
      const remote = fakeBackend([
        { id: 'remote-only', symbol: 'EURUSD', side: '多', qty: 1, entryPrice: 1, exitPrice: 1.2, date: '2026-04-01 10:00:00', updatedAt: 20, createdAt: 20 },
        { id: 'both', symbol: 'XAUUSD', side: '多', qty: 1, entryPrice: 1, exitPrice: 1, date: '2026-04-02 10:00:00', updatedAt: 5, createdAt: 5 }
      ]);
      const localTrades = [
        { id: 'local-only', symbol: 'GBPUSD', side: '空', qty: 1, entryPrice: 1, exitPrice: 1, date: '2026-04-03 10:00:00', updatedAt: 30, createdAt: 30 },
        { id: 'both', symbol: 'XAUUSD', side: '多', qty: 1, entryPrice: 1, exitPrice: 2, date: '2026-04-02 10:00:00', updatedAt: 50, createdAt: 5, profit: 10, fee: 1 },
        { id: 'tomb', deleted: true, updatedAt: 40 }
      ];
      const localAccount = {
        currency: 'USD', initialBalance: 2000, updatedAt: 80,
        cashflows: [{ id: 'cf', date: '2026-04-01', amount: 100, note: '入金' }]
      };
      let saved = null;
      const r = await S.syncOnce(remote, {
        getLocal: () => ({ trades: localTrades, account: localAccount }),
        setLocal: next => { saved = next; }
      });
      assert.ok(r.pushed);
      assert.strictEqual(remote.box.data.version, 2);
      const ids = remote.box.data.trades.map(t => String(t.id)).sort();
      assert.deepStrictEqual(ids, ['both', 'local-only', 'remote-only', 'tomb']);
      const both = remote.box.data.trades.find(t => t.id === 'both');
      assert.strictEqual(Number(both.updatedAt), 50);
      assert.strictEqual(remote.box.data.account.initialBalance, 2000);
      assert.strictEqual(remote.box.data.account.cashflows.length, 1);
      assert.ok(saved);
      assert.strictEqual(saved.trades.length, 4);
      assert.strictEqual(saved.account.cashflows[0].id, 'cf');

      const olderRemoteAccount = {
        version: 2,
        trades: remote.box.data.trades,
        account: { currency: 'USD', initialBalance: 1, updatedAt: 10, cashflows: [] }
      };
      const remote2 = fakeBackend(JSON.parse(JSON.stringify(olderRemoteAccount)));
      let saved2 = null;
      await S.syncOnce(remote2, {
        getLocal: () => ({ trades: saved.trades, account: saved.account }),
        setLocal: next => { saved2 = next; }
      });
      assert.strictEqual(saved2, null, '更旧的远端账户不应写回本地');
      assert.strictEqual(remote2.box.data.account.initialBalance, 2000);
      assert.strictEqual(remote2.box.data.account.cashflows.length, 1);

      const remoteArr = fakeBackend(JSON.parse(JSON.stringify(remote.box.data.trades)));
      assert.ok(Array.isArray(remoteArr.box.data));
      let saved3 = null;
      await S.syncOnce(remoteArr, {
        getLocal: () => ({ trades: saved.trades, account: saved.account }),
        setLocal: next => { saved3 = next; }
      });
      assert.strictEqual(remoteArr.box.data.version, 2);
      assert.strictEqual(remoteArr.box.data.trades.length, saved.trades.length);
      assert.strictEqual(remoteArr.box.data.account.cashflows[0].note, '入金');
      assert.strictEqual(remoteArr.box.data.account.initialBalance, 2000);
      assert.strictEqual(saved3, null, '本地账户未变时不必重写');

      const deviceBAccount = { currency: 'EUR', initialBalance: 9, updatedAt: 500, cashflows: [{ id: 'b', date: '2026-08-01', amount: -4, note: '出' }] };
      const deviceBTrade = { id: 'from-b', symbol: 'USDJPY', side: '多', qty: 1, entryPrice: 1, exitPrice: 1, date: '2026-08-02 00:00:00', updatedAt: 60, createdAt: 60 };
      const remoteB = fakeBackend(null);
      await S.syncOnce(remoteB, {
        getLocal: () => ({ trades: [deviceBTrade], account: deviceBAccount }),
        setLocal: () => { throw new Error('空远端不应改本地'); }
      });
      let mergedOnA = null;
      const rA = await S.syncOnce(remoteB, {
        getLocal: () => ({ trades: saved.trades, account: saved.account }),
        setLocal: next => { mergedOnA = next; }
      });
      assert.ok(rA.localChanged);
      const mergedIds = mergedOnA.trades.map(t => String(t.id)).sort();
      for (const id of ['both', 'local-only', 'remote-only', 'tomb', 'from-b']) assert.ok(mergedIds.includes(id), id);
      assert.strictEqual(mergedOnA.account.currency, 'EUR');
      assert.strictEqual(mergedOnA.account.cashflows[0].id, 'b');
      console.log('ok sync 不丢交易且账户按更新时间合并');
    } catch (e) {
      failed++;
      console.error('FAIL sync', e && e.stack || e);
    }
    resolve();
  }
}

runAsync().then(() => {
  if (failed) { console.error(failed + ' failed'); process.exit(1); }
  console.log('all passed');
});
