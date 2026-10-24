/*
 * 同步层（可插拔）：每个后端实现 { id, name, test(), pull() -> {data, remoteId} | null, push(data) -> remoteId }
 * 内置：GitHub Gist（私密）、Gitee 码云 Gist（实验性，国内直连）。以后可在 BACKENDS 中加入 WebDAV / S3 等。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.TJSync = factory(root.TJCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  const FILE = 'mt5-journal-data.json';
  const DESC = '交易复盘工具 · 同步数据（请勿手动修改）';

  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  async function http(fetchImpl, url, opts) {
    let res;
    try { res = await fetchImpl(url, Object.assign({ cache: 'no-store' }, opts)); }
    catch (e) { throw new HttpError(0, '网络连接失败（可能无法访问该服务，请检查网络或稍后重试）'); }
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j.message || j.error || ''; } catch (e) { /* ignore */ }
      const hint = res.status === 401 ? '令牌无效或已过期' : res.status === 403 ? '令牌权限不足（需要 gist 权限）或请求过于频繁' : res.status === 404 ? '找不到该 Gist（ID 错误或令牌无权访问）' : '请求失败';
      throw new HttpError(res.status, `${hint}（HTTP ${res.status}${detail ? '：' + detail : ''}）`);
    }
    return res.status === 204 ? null : res.json();
  }

  // ---------- GitHub Gist ----------
  class GistBackend {
    constructor({ token, gistId, fetch: f, api } = {}) {
      this.id = 'github'; this.name = 'GitHub Gist';
      this.token = (token || '').trim(); this.gistId = (gistId || '').trim();
      this.fetch = f || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
      this.api = api || 'https://api.github.com';
    }
    headers(json) {
      const h = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}` };
      if (json) h['Content-Type'] = 'application/json';
      return h;
    }
    async test() {
      const u = await http(this.fetch, `${this.api}/user`, { headers: this.headers() });
      return u && u.login ? `已连接 GitHub 账号：${u.login}` : '已连接';
    }
    async findGist() {
      for (let page = 1; page <= 5; page++) {
        const list = await http(this.fetch, `${this.api}/gists?per_page=100&page=${page}`, { headers: this.headers() });
        const g = (list || []).find(x => x.files && x.files[FILE]);
        if (g) return g.id;
        if (!list || list.length < 100) break;
      }
      return '';
    }
    async readFile(g) {
      const f = g.files && g.files[FILE];
      if (!f) return null;
      let text = f.content;
      if (f.truncated || text === undefined) {
        const r = await this.fetch(f.raw_url, { cache: 'no-store' });
        if (!r.ok) throw new HttpError(r.status, '读取同步文件失败');
        text = await r.text();
      }
      return text ? JSON.parse(text) : null;
    }
    async pull() {
      if (!this.gistId) this.gistId = await this.findGist();
      if (!this.gistId) return null;
      const g = await http(this.fetch, `${this.api}/gists/${this.gistId}`, { headers: this.headers() });
      return { data: await this.readFile(g), remoteId: this.gistId };
    }
    async push(data) {
      const body = JSON.stringify({ description: DESC, files: { [FILE]: { content: JSON.stringify(data) } } });
      if (this.gistId) {
        await http(this.fetch, `${this.api}/gists/${this.gistId}`, { method: 'PATCH', headers: this.headers(true), body });
      } else {
        const g = await http(this.fetch, `${this.api}/gists`, { method: 'POST', headers: this.headers(true), body: JSON.stringify({ description: DESC, public: false, files: { [FILE]: { content: JSON.stringify(data) } } }) });
        this.gistId = g.id;
      }
      return this.gistId;
    }
  }

  // ---------- Gitee 码云 Gist（实验性）----------
  class GiteeBackend extends GistBackend {
    constructor(opts = {}) {
      super(Object.assign({ api: 'https://gitee.com/api/v5' }, opts));
      this.id = 'gitee'; this.name = 'Gitee 码云';
    }
    q(extra = '') { return `access_token=${encodeURIComponent(this.token)}${extra}`; }
    async test() {
      const u = await http(this.fetch, `${this.api}/user?${this.q()}`, {});
      return u && u.login ? `已连接 Gitee 账号：${u.login}` : '已连接';
    }
    async findGist() {
      for (let page = 1; page <= 5; page++) {
        const list = await http(this.fetch, `${this.api}/gists?${this.q(`&per_page=100&page=${page}`)}`, {});
        const g = (list || []).find(x => x.files && x.files[FILE]);
        if (g) return g.id;
        if (!list || list.length < 100) break;
      }
      return '';
    }
    async pull() {
      if (!this.gistId) this.gistId = await this.findGist();
      if (!this.gistId) return null;
      const g = await http(this.fetch, `${this.api}/gists/${this.gistId}?${this.q()}`, {});
      return { data: await this.readFile(g), remoteId: this.gistId };
    }
    async push(data) {
      const files = { [FILE]: { content: JSON.stringify(data) } };
      const h = { 'Content-Type': 'application/json;charset=UTF-8' };
      if (this.gistId) {
        await http(this.fetch, `${this.api}/gists/${this.gistId}`, { method: 'PATCH', headers: h, body: JSON.stringify({ access_token: this.token, files, description: DESC }) });
      } else {
        const g = await http(this.fetch, `${this.api}/gists`, { method: 'POST', headers: h, body: JSON.stringify({ access_token: this.token, files, description: DESC, public: false }) });
        this.gistId = g.id;
      }
      return this.gistId;
    }
  }

  const BACKENDS = {
    github: { name: 'GitHub Gist', create: o => new GistBackend(o) },
    gitee: { name: 'Gitee 码云（实验性）', create: o => new GiteeBackend(o) }
  };

  /**
   * 一次完整同步：拉取 → 合并（按 id，updatedAt 新者胜）→ 有变化则写回本地 / 上传
   * getLocal(): trades[]；setLocal(trades)：保存合并结果
   */
  async function syncOnce(backend, { getLocal, setLocal, device }) {
    const pulled = await backend.pull();
    const local = getLocal();
    let remoteTrades = [];
    if (pulled && pulled.data) remoteTrades = C.parsePayload(pulled.data);
    const { merged, fromRemote } = C.mergeTrades(local, remoteTrades);
    const finalList = merged; // 墓碑体积很小，永久保留，避免长期未同步的设备把已删除记录"复活"
    const localChanged = !C.sameTrades(finalList, local);
    if (localChanged) setLocal(finalList);
    const needPush = !pulled || !pulled.data || !C.sameTrades(finalList, remoteTrades);
    let remoteId = pulled && pulled.remoteId;
    if (needPush) remoteId = await backend.push(C.buildPayload(finalList, device));
    return { remoteId, pulledCount: remoteTrades.length, fromRemote, pushed: needPush, localChanged, total: C.live(finalList).length };
  }

  return { FILE, GistBackend, GiteeBackend, BACKENDS, syncOnce, HttpError };
});
