/* 截图识别：加载 Tesseract.js（多 CDN 回退，国内优先 npmmirror）、图像预处理、输出带坐标的单词 */
(function (root) {
  'use strict';
  const V = '5.1.1';
  const CDNS = [
    { name: 'npmmirror', js: `https://registry.npmmirror.com/tesseract.js/${V}/files/dist/tesseract.min.js`, worker: `https://registry.npmmirror.com/tesseract.js/${V}/files/dist/worker.min.js`, core: `https://registry.npmmirror.com/tesseract.js-core/${V}/files/` },
    { name: 'jsdelivr', js: `https://cdn.jsdelivr.net/npm/tesseract.js@${V}/dist/tesseract.min.js`, worker: `https://cdn.jsdelivr.net/npm/tesseract.js@${V}/dist/worker.min.js`, core: `https://cdn.jsdelivr.net/npm/tesseract.js-core@${V}/` },
    { name: 'fastly', js: `https://fastly.jsdelivr.net/npm/tesseract.js@${V}/dist/tesseract.min.js`, worker: `https://fastly.jsdelivr.net/npm/tesseract.js@${V}/dist/worker.min.js`, core: `https://fastly.jsdelivr.net/npm/tesseract.js-core@${V}/` },
    { name: 'unpkg', js: `https://unpkg.com/tesseract.js@${V}/dist/tesseract.min.js`, worker: `https://unpkg.com/tesseract.js@${V}/dist/worker.min.js`, core: `https://unpkg.com/tesseract.js-core@${V}/` }
  ];
  const workers = {};
  let cdn = null;

  function loadScript(src, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      const timer = setTimeout(() => { s.remove(); reject(new Error('timeout')); }, timeout);
      s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = () => { clearTimeout(timer); resolve(); };
      s.onerror = () => { clearTimeout(timer); s.remove(); reject(new Error('load error')); };
      document.head.appendChild(s);
    });
  }
  async function ensureLib(log) {
    if (root.Tesseract && cdn) return;
    for (const c of CDNS) {
      try { log && log(`加载识别引擎（${c.name}）…`); if (!root.Tesseract) await loadScript(c.js); cdn = c; return; }
      catch (e) { /* 尝试下一个 */ }
    }
    throw new Error('识别引擎加载失败，请检查网络（需要能访问 npmmirror / jsdelivr 之一）');
  }
  async function localLangPath() {
    if (location.protocol === 'file:') return null;
    try {
      const u = new URL('tessdata/', location.href).href;
      const r = await fetch(u + 'eng.traineddata.gz', { method: 'HEAD' });
      return r.ok ? u.replace(/\/$/, '') : null;
    } catch (e) { return null; }
  }
  async function getWorker(lang, log) {
    if (workers[lang]) return workers[lang];
    await ensureLib(log);
    const langPath = await localLangPath();
    const order = [cdn, ...CDNS.filter(c => c !== cdn)];
    let lastErr;
    for (const c of order) {
      try {
        log && log(`初始化识别引擎（${lang === 'eng' ? '英文' : '中文+英文'}，首次需下载语言包）…`);
        const opts = {
          workerPath: c.worker, corePath: c.core,
          logger: m => { if (log && m.status) log(statusText(m.status) + (m.progress ? ` ${Math.round(m.progress * 100)}%` : ''), m.progress); }
        };
        if (langPath) opts.langPath = langPath;
        const w = await root.Tesseract.createWorker(lang.split('+'), 1, opts);
        await w.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
        workers[lang] = w;
        return w;
      } catch (e) { lastErr = e; }
    }
    throw new Error('识别引擎初始化失败：' + (lastErr && lastErr.message || lastErr));
  }
  function statusText(s) {
    return ({ 'loading tesseract core': '加载引擎', 'initializing tesseract': '初始化', 'loading language traineddata': '下载语言包', 'loading language traineddata (from cache)': '读取语言包缓存', 'initializing api': '初始化接口', 'recognizing text': '识别中' })[s] || s;
  }

  /** 预处理：放大小图、取 RGB 最小通道作灰度（让蓝/红/浅灰文字都变深），轻度拉伸对比度 */
  async function preprocess(file) {
    const bmp = await loadImage(file);
    const w0 = bmp.width, h0 = bmp.height;
    let scale = 1;
    if (w0 < 1000) scale = Math.min(3, 1400 / w0);
    if (w0 * scale > 2600) scale = 2600 / w0;
    const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h); const d = img.data;
    // 判断是否深色背景（MT5 深色主题），是则反相
    let sum = 0, n = 0; for (let i = 0; i < d.length; i += 4 * 97) { sum += (d[i] + d[i + 1] + d[i + 2]) / 3; n++; }
    const dark = sum / n < 110;
    for (let i = 0; i < d.length; i += 4) {
      let v = dark ? 255 - Math.max(d[i], d[i + 1], d[i + 2]) : Math.min(d[i], d[i + 1], d[i + 2]);
      v = v < 40 ? 0 : v > 225 ? 255 : Math.round((v - 40) * 255 / 185);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return { canvas: cv, scale, width: w, height: h };
  }
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片无法读取（若是 HEIC，请在 iPhone 设置-相机-格式 中选「兼容性最佳」，或直接截屏）')); };
      im.src = url;
    });
  }
  function collectWords(data) {
    const words = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) words.push({ text: w.text, confidence: w.confidence, bbox: w.bbox });
    if (!words.length && data.words) data.words.forEach(w => words.push({ text: w.text, confidence: w.confidence, bbox: w.bbox }));
    return words;
  }
  /** 识别一张图片：返回 { words, text, lang } */
  async function recognize(file, { lang = 'eng', log } = {}) {
    const pre = await preprocess(file);
    const w = await getWorker(lang, log);
    const r = await w.recognize(pre.canvas, {}, { blocks: true, text: true });
    return { words: collectWords(r.data), text: r.data.text || '', lang };
  }
  root.TJOCR = { recognize, preprocess, CDNS, ensureLib };
})(typeof self !== 'undefined' ? self : this);
