/*
 * A股每日选股 · 浏览器版选股引擎
 * 与 screener.py v2.0-tx 同一套规则，在看网页的人自己的手机/电脑上运行。
 * 数据：腾讯行情 qt.gtimg.cn、腾讯日K web.ifzq.gtimg.cn、东方财富财报 datacenter-web、涨停池 push2ex（都允许网页直接访问）。
 * 用法：const result = await AStockEngine.run({ onProgress: (text, pct) => {} });
 */
(function () {
  "use strict";
  const VERSION = "2.5-tx-web";
  const CONFIG = {
    top_n: 30, tech_candidates: 300,
    exclude_st: true, exclude_limit: true,
    min_mcap_yi: 50, min_amount_yi: 0, pe_ttm_range: null,           // 短线：不看基本面
    min_roe_annual: null, min_profit_yoy: null, min_kline_days: 120,
    weights: { fundamental: 0.0, capital: 0.45, technical: 0.55 },
    pattern_days: 5, pattern_min_mcap_yi: 50, pattern_min_amount_yi: 0,
    pullback_range: [-2.0, 0.0], pattern_max_list: 50,
    setup_lookback: 25, setup_min_amp: 0.15, setup_pull_days: [3, 20], setup_retrace: [0.3, 1.15], setup_max_list: 40,
    squeeze_min_score: 55, squeeze_max_list: 40, squeeze_fetch_max: 200, squeeze_fetch_seconds: 180,   // 粘合蓄势
    squeeze_mcap_range: [50, 300], squeeze_exclude_industries: ["银行Ⅱ", "保险Ⅱ", "证券Ⅱ", "多元金融"],
  };

  // ───────── 工具 ─────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const num = (x) => {
    if (x === null || x === undefined || x === "-" || x === "") return NaN;
    const v = Number(x);
    return Number.isFinite(v) ? v : NaN;
  };
  const isN = (v) => typeof v === "number" && Number.isFinite(v);
  const rn = (x, d = 2) => (isN(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
  const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

  function cnNow() {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    const date = `${p.year}-${p.month}-${p.day}`;
    return { date, iso: `${date}T${p.hour}:${p.minute}:${p.second}+08:00`, h: +p.hour, m: +p.minute };
  }

  async function fetchRetry(url, { tries = 4, timeout = 15000, as = "json" } = {}) {
    let last;
    for (let i = 0; i < tries; i++) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeout);
      try {
        const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        if (as === "gbk") return new TextDecoder("gbk").decode(await r.arrayBuffer());
        return as === "text" ? await r.text() : await r.json();
      } catch (e) {
        last = e;
        await sleep(800 * (i + 1));
      } finally {
        clearTimeout(t);
      }
    }
    throw new Error(`请求失败：${url.split("?")[0]}（${last && last.message}）`);
  }

  async function pool(items, workers, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }));
    return out;
  }

  // ───────── 本机缓存：K 线历史放 IndexedDB，财报放 localStorage（当天有效）─────────
  const idb = (() => {
    let dbp = null;
    const open = () => {
      if (dbp) return dbp;
      dbp = new Promise((res) => {
        try {
          if (typeof indexedDB === "undefined") return res(null);
          const rq = indexedDB.open("astock", 1);
          rq.onupgradeneeded = () => rq.result.createObjectStore("kline");
          rq.onsuccess = () => res(rq.result);
          rq.onerror = () => res(null);
        } catch (e) { res(null); }
      });
      return dbp;
    };
    const tx = async (mode, fn) => {
      const db = await open();
      if (!db) return null;
      return new Promise((res) => {
        try {
          const t = db.transaction("kline", mode);
          const r = fn(t.objectStore("kline"));
          t.oncomplete = () => res(r && "result" in r ? r.result : null);
          t.onerror = t.onabort = () => res(null);
        } catch (e) { res(null); }
      });
    };
    return {
      getMany: async (keys) => {
        const db = await open();
        if (!db) return new Map();
        return new Promise((res) => {
          const out = new Map();
          try {
            const t = db.transaction("kline", "readonly"), st = t.objectStore("kline");
            for (const k of keys) { const r = st.get(k); r.onsuccess = () => { if (r.result) out.set(k, r.result); }; }
            t.oncomplete = () => res(out);
            t.onerror = t.onabort = () => res(out);
          } catch (e) { res(out); }
        });
      },
      putMany: async (entries) => {
        if (!entries.length) return;
        await tx("readwrite", (st) => { for (const [k, v] of entries) st.put(v, k); });
      },
    };
  })();
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 存不下就不存 */ } },
  };

  // pandas rank(pct=True) 的平均名次；缺失给 50 分
  function pctRank(vals, higherBetter = true) {
    const idx = vals.map((v, i) => [v, i]).filter(([v]) => isN(v));
    idx.sort((a, b) => (higherBetter ? a[0] - b[0] : b[0] - a[0]));
    const n = idx.length, out = vals.map(() => 50);
    for (let s = 0; s < n;) {
      let e = s;
      while (e + 1 < n && idx[e + 1][0] === idx[s][0]) e++;
      const avg = (s + e) / 2 + 1;
      for (let j = s; j <= e; j++) out[idx[j][1]] = (avg / n) * 100;
      s = e + 1;
    }
    return out;
  }

  const limitPct = (code) => (/^(300|301|688|689)/.test(code) ? 20 : 10);
  const txSym = (code) => (/^(60|68)/.test(code) ? "sh" + code : /^(00|30)/.test(code) ? "sz" + code : null);

  // ───────── 数据 ─────────
  function quarterEnds(todayStr) {
    const y = +todayStr.slice(0, 4);
    const c = [];
    for (const yy of [y, y - 1, y - 2]) for (const [m, d] of [[3, 31], [6, 30], [9, 30], [12, 31]]) c.push(`${yy}-${String(m).padStart(2, "0")}-${d}`);
    return c.filter((d) => d < todayStr).sort().reverse();
  }

  async function fetchFinPeriod(ds) {
    const base = "https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=SECURITY_CODE&sortTypes=1&pageSize=500&reportName=RPT_LICO_FN_CPD" +
      "&columns=SECURITY_CODE,SECURITY_NAME_ABBR,TRADE_MARKET,PUBLISHNAME,REPORTDATE,WEIGHTAVG_ROE,YSTZ,SJLTZ,XSMLL" +
      `&filter=${encodeURIComponent(`(REPORTDATE='${ds}')`)}`;
    const first = await fetchRetry(base + "&pageNumber=1");
    const res = first.result || {};
    const pages = +res.pages || 0;
    const rows = [...(res.data || [])];
    const rest = await pool(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2), 6,
      (pn) => fetchRetry(base + "&pageNumber=" + pn).then((j) => (j.result && j.result.data) || []));
    rest.forEach((r) => rows.push(...r));
    return { rows, count: +res.count || rows.length, month: +ds.slice(5, 7) };
  }

  async function fetchFinancials(today) {
    const cached = ls.get("astock_fin");
    if (cached && cached.date === today && Array.isArray(cached.rows) && cached.rows.length > 3000) {
      return new Map(cached.rows.map((r) => [r.code, r]));
    }
    const fin = await fetchFinancialsFresh(today);
    ls.set("astock_fin", { date: today, rows: [...fin.values()] });
    return fin;
  }

  async function fetchFinancialsFresh(today) {
    const qs = quarterEnds(today);
    const periods = [await fetchFinPeriod(qs[0])];
    if (periods[0].count < 4500) periods.push(await fetchFinPeriod(qs[1]));
    const fin = new Map();
    for (const { rows, month } of periods) {
      for (const r of rows) {
        const code = String(r.SECURITY_CODE).padStart(6, "0");
        const rd = String(r.REPORTDATE).slice(0, 10);
        const old = fin.get(code);
        if (old && old.report_date >= rd) continue;
        const roe = num(r.WEIGHTAVG_ROE);
        fin.set(code, {
          code, report_date: rd, roe, roe_annual: roe * 12 / month,
          rev_yoy: num(r.YSTZ), profit_yoy: num(r.SJLTZ), gross_margin: num(r.XSMLL),
          industry: r.PUBLISHNAME || "", exchange: r.TRADE_MARKET || "", fin_name: r.SECURITY_NAME_ABBR || "",
        });
      }
    }
    return fin;
  }

  const TX = { name: 1, code: 2, price: 3, prev_close: 4, open: 5, volume: 6, outer: 7, inner: 8, pct: 32, high: 33, low: 34,
    amount_wan: 37, turnover: 38, pe_ttm: 39, float_mcap_yi: 44, mcap_yi: 45, pb: 46, vol_ratio: 49 };

  async function fetchSpot(codes, onBatch) {
    const syms = codes.map(txSym).filter(Boolean);
    const batches = [];
    for (let i = 0; i < syms.length; i += 300) batches.push(syms.slice(i, i + 300));
    let done = 0;
    const texts = await pool(batches, 4, async (b) => {
      const t = await fetchRetry("https://qt.gtimg.cn/q=" + b.join(","), { as: "gbk" });
      onBatch && onBatch(++done, batches.length);
      return t;
    });
    const rows = [];
    for (const text of texts) {
      for (const line of text.split(";")) {
        const at = line.indexOf('="');
        if (at < 0) continue;
        const f = line.slice(at + 2).replace(/"\s*$/, "").trim().split("~");
        if (f.length <= 49) continue;
        const r = {};
        for (const [k, i] of Object.entries(TX)) r[k] = f[i];
        r.name = String(r.name).replace(/\s+/g, "");
        for (const k of Object.keys(TX)) if (k !== "code" && k !== "name") r[k] = num(r[k]);
        r.code = String(r.code).padStart(6, "0");
        r.mkt = r.code.startsWith("6") ? 1 : 0;
        if (/^(688|689)/.test(r.code)) { r.volume /= 100; r.outer /= 100; r.inner /= 100; }
        r.amount = r.amount_wan * 1e4;
        r.mcap = r.mcap_yi * 1e8;
        r.main_pct = r.volume > 0 ? (r.outer - r.inner) / r.volume * 100 : NaN;
        r.main_net = (r.outer - r.inner) * 100 * r.price;
        if (!(r.price > 0)) r.price = NaN;
        rows.push(r);
      }
    }
    const seen = new Set();
    return rows.filter((r) => (seen.has(r.code) ? false : (seen.add(r.code), true)));
  }

  async function fetchKline(mkt, code, lmt = 130, tries = 5) {
    const sym = (+mkt === 1 ? "sh" : "sz") + code;
    const j = await fetchRetry(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,${lmt},qfq`, { tries, timeout: 10000 });
    const d = (j.data && j.data[sym]) || {};
    const kl = d.qfqday || d.day || [];
    if (!kl.length) return null;
    const star = /^(688|689)/.test(code) && code !== "000001";
    return kl.map((k) => {
      const v = num(k[5]) / (star ? 100 : 1);
      const close = num(k[2]);
      return { date: k[0], open: num(k[1]), close, high: num(k[3]), low: num(k[4]), volume: v, amount: close * v * 100 };
    });
  }

  async function tradingDates(n = 6) {
    try {
      const k = await fetchKline(1, "000001", n);
      if (k && k.length) return k.map((x) => x.date);
    } catch (e) { /* 兜底见下 */ }
    const t = await fetchRetry("https://qt.gtimg.cn/q=sh000001", { as: "gbk" });
    const f = t.split("~");
    const s = f[30].slice(0, 8);
    let d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T12:00:00+08:00`);
    const out = [d.toISOString().slice(0, 10)];
    while (out.length < n) {
      d = new Date(d.getTime() - 86400000);
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    }
    return out.sort();
  }

  async function fetchZtPool(day) {
    const j = await fetchRetry("https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=10000&sort=fbt:asc&date=" + day.replace(/-/g, ""), { tries: 3 });
    const m = new Map();
    for (const p of ((j.data && j.data.pool) || [])) if (p.c) m.set(String(p.c).padStart(6, "0"), { lbc: +p.lbc || 1, p: rn((+p.p || 0) / 1000), pct: rn(+p.zdp, 1) });
    return m;
  }

  function tradingFraction(h, m) {
    const t = h * 60 + m;
    const am = Math.max(0, Math.min(t, 11 * 60 + 30) - (9 * 60 + 30));
    const pm = Math.max(0, Math.min(t, 15 * 60) - 13 * 60);
    return Math.max((am + pm) / 240, 0.05);
  }

  // ───────── 粘合蓄势：均线粘合横盘 / 回踩均线 ─────────
  function baseDays(c, h, lo, tol = 0.18) {
    const px = c[c.length - 1];
    let hi = h[h.length - 1], lw = lo[lo.length - 1], d = 1;
    for (let i = c.length - 2; i > Math.max(-1, c.length - 121); i--) {
      hi = Math.max(hi, h[i]); lw = Math.min(lw, lo[i]);
      if ((hi - lw) / px > tol) break;
      d++;
    }
    return d;
  }
  function pullbackToMa(c, o, h, lo, v, pct, lim, m5, m10, m20, m5p, m20p, m60, m60p, vr) {
    const n = c.length, px = c[n - 1];
    const H = Math.max(...h.slice(-30)), L = Math.min(...lo.slice(-30));
    if (L <= 0 || H / L < 1.3) return null;
    if (m20 / m20p - 1 < 0.05) return null;
    const r = (H - px) / (H - L);
    if (!(r >= 0.25 && r <= 0.65)) return null;
    const d20 = (px / m20 - 1) * 100, d10 = (px / m10 - 1) * 100;
    if (!((d20 >= -8 && d20 <= 5) || Math.abs(d10) <= 5)) return null;
    if (vr > 1.05 || pct[n - 1] >= 0.45 * lim || pct[n - 1] < -1) return null;   // 今天还在跌的不算止跌
    let iH = n - 1;
    for (let j = n - 1; j >= n - 30; j--) if (h[j] > h[iH]) iH = j;   // 30 天内最高价所在日（取最近的一次最高）
    for (let j = n - 1; j >= n - 30; j--) if (h[j] === h[iH]) { iH = j; break; }
    if (n - 1 - iH < 3) return null;
    let ups = 0;
    for (let j = n - 1; j > 0; j--) { if (c[j] > c[j - 1]) ups++; else break; }
    const turning = (m5 > m5p && c[n - 1] >= o[n - 1]) || (px > m5 && ups >= 2);
    if (!turning) return null;
    let s = 40; const why = ["回踩均线"];
    s += (r >= 0.4 && r <= 0.6) ? 15 : 8;
    s += vr <= 0.85 ? 15 : 8;
    s += m5 > m5p ? 10 : 5;
    s += ups >= 2 ? 10 : 0;
    s += m60 > m60p ? 5 : 0;
    s += Math.abs(d20) <= 4 ? 5 : 0;
    if (ups >= 2) why.push(`连涨${ups}天`);
    if (vr <= 0.85) why.push("量能回落");
    why.push(`回撤${Math.round(r * 100)}%`);
    if (s < CONFIG.squeeze_min_score) return null;
    const [tdb, tds] = tdCounts(c);
    return { sq_score: Math.min(s, 100), sq_sig: "回踩均线", sq_why: why.slice(0, 4),
      ma_spread: rn((Math.max(m5, m10, m20) - Math.min(m5, m10, m20)) / px * 100), rng10: rn((Math.max(...h.slice(-10)) - Math.min(...lo.slice(-10))) / px * 100, 1),
      vol_ratio_5_20: rn(vr), dist_ma20: rn(d20), ma20_slope: rn((m20 / m20p - 1) * 100), ma60_up: m60 > m60p,
      base_days: n - 1 - iH, retrace: Math.round(r * 100), td_buy: tdb, td_sell: tds };
  }
  function detectSqueeze(k, code, today, frac) {
    const n = k ? k.length : 0;
    if (n < 62) return null;
    const lim = limitPct(code);
    const o = k.map((x) => x.open), c = k.map((x) => x.close), h = k.map((x) => x.high), lo = k.map((x) => x.low), v = k.map((x) => x.volume);
    if (k[n - 1].date === today && frac < 1) v[n - 1] = v[n - 1] / frac;
    const px = c[n - 1];
    if (px <= 0 || v.slice(-20).reduce((a, b) => a + b, 0) <= 0) return null;
    const pct = c.map((x, i) => (i ? (x / c[i - 1] - 1) * 100 : NaN));
    const ma = (w, off = 0) => mean(c.slice(n - w - off, n - off));
    const m5 = ma(5), m10 = ma(10), m20 = ma(20), m60 = ma(60);
    const m5p = ma(5, 3), m20p = ma(20, 10), m60p = n >= 70 ? ma(60, 10) : m60;
    const spread = (Math.max(m5, m10, m20) - Math.min(m5, m10, m20)) / px * 100;
    const rng10 = (Math.max(...h.slice(-10)) - Math.min(...lo.slice(-10))) / px * 100;
    const rng30 = (Math.max(...h.slice(-30)) - Math.min(...lo.slice(-30))) / px * 100;
    const v20 = mean(v.slice(-20)), v5 = mean(v.slice(-5));
    const vr = v20 > 0 ? v5 / v20 : 9;
    const dist20 = (px / m20 - 1) * 100;
    const max5 = Math.max(...pct.slice(-5));
    if (pct[n - 1] >= 0.45 * lim || (max5 >= 0.6 * lim && spread > 6)) return null;
    const pb = pullbackToMa(c, o, h, lo, v, pct, lim, m5, m10, m20, m5p, m20p, m60, m60p, vr);
    if (pb) return pb;
    if (spread > 6 || rng10 > 18 || Math.abs(dist20) > 5 || vr > 1.8 || pct[n - 1] <= -3) return null;   // 今天大跌的不算蓄势
    if (m20 / m20p - 1 < -0.04 || px < m60 * 0.85) return null;
    if (max5 >= 0.6 * lim) return null;
    if (px > Math.max(...h.slice(-31, -1)) * 1.03) return null;
    let s = 0; const why = [];
    s += spread <= 1.5 ? 25 : spread <= 3 ? 18 : spread <= 4.5 ? 10 : 4;
    why.push(`均线粘合${spread.toFixed(1)}%`);
    s += rng10 <= 7 ? 20 : rng10 <= 10 ? 15 : rng10 <= 14 ? 9 : 4;
    if (rng30 > 0 && rng10 / rng30 <= 0.6) { s += 5; why.push("波动收窄"); }
    s += vr <= 0.8 ? 15 : vr <= 1.0 ? 11 : vr <= 1.3 ? 6 : 2;
    if (vr <= 0.8) why.push("明显缩量");
    if (px >= m20) s += 6;
    if (px >= m10 && m5 >= m10) { s += 8; why.push("短均线开始向上排列"); }
    if (m5 > m5p) s += 6;
    if (m60 > m60p) { s += 5; why.push("60日线向上"); }
    let trig = false;
    for (let j = n - 3; j < n; j++) if (pct[j] >= 2 && v[j] >= 1.3 * v20 && c[j] > o[j]) trig = true;
    if (trig) { s += 7; why.push("温和放量"); }
    let td9 = false;
    for (let j = n - 15; j < n; j++) {
      let cnt = 0, i = j;
      while (i >= 4 && c[i] < c[i - 4]) { cnt++; i--; }
      if (cnt >= 9) td9 = true;
    }
    if (td9) { s += 5; why.push("九转买入到位"); }
    if (s < CONFIG.squeeze_min_score) return null;
    const sig = (trig || (px >= m10 && m5 >= m10 && m5 > m5p)) ? "蓄势待发" : "横盘粘合";
    const [tdb, tds] = tdCounts(c);
    return { sq_score: s, sq_sig: sig, sq_why: why.slice(0, 4), ma_spread: rn(spread), rng10: rn(rng10, 1), vol_ratio_5_20: rn(vr),
      dist_ma20: rn(dist20), ma20_slope: rn((m20 / m20p - 1) * 100), ma60_up: m60 > m60p, base_days: baseDays(c, h, lo), td_buy: tdb, td_sell: tds };
  }

  // ───────── 指标 ─────────
  function rolling(a, w) { return a.map((_, i) => (i + 1 < w ? NaN : a.slice(i + 1 - w, i + 1).reduce((s, x) => s + x, 0) / w)); }
  function ewm(a, alpha) {
    const out = new Array(a.length).fill(NaN);
    let prev = NaN;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (!isN(x)) { out[i] = prev; continue; }
      prev = isN(prev) ? alpha * x + (1 - alpha) * prev : x;
      out[i] = prev;
    }
    return out;
  }
  const at = (a, i) => a[a.length + i];

  function technicals(k, vr) {
    const c = k.map((x) => x.close);
    const ma20 = rolling(c, 20), ma60 = rolling(c, 60);
    const ema12 = ewm(c, 2 / 13), ema26 = ewm(c, 2 / 27);
    const dif = c.map((_, i) => ema12[i] - ema26[i]);
    const dea = ewm(dif, 2 / 10);
    const delta = c.map((x, i) => (i ? x - c[i - 1] : NaN));
    const gain = ewm(delta.map((x) => (isN(x) ? Math.max(x, 0) : NaN)), 1 / 14);
    const loss = ewm(delta.map((x) => (isN(x) ? Math.max(-x, 0) : NaN)), 1 / 14);
    const rsiLast = at(loss, -1) === 0 || !isN(at(loss, -1)) ? NaN : 100 - 100 / (1 + at(gain, -1) / at(loss, -1));

    const last = at(c, -1), m20 = at(ma20, -1), m60 = at(ma60, -1), m20p = at(ma20, -6);
    const d = at(dif, -1), e = at(dea, -1);
    const r = isN(rsiLast) ? rsiLast : 50;
    const highs = k.slice(-61, -1).map((x) => x.high);
    const hi60 = highs.length ? Math.max(...highs) : NaN;
    const chg20 = (last / at(c, -21) - 1) * 100;
    let cross = false;
    for (let i = 1; i <= 3; i++) if (at(dif, -i) > at(dea, -i) && at(dif, -i - 1) <= at(dea, -i - 1)) cross = true;

    let s = 0; const why = [];
    if (last > m20) s += 12;
    if (m20 > m60) s += 13;
    if (m20 > m20p) s += 10;
    if (last > m20 && m20 > m60 && m20 > m20p) why.push("均线多头");
    if (d > e) s += 12;
    if (d > 0) s += 6;
    if (cross) { s += 7; why.push("MACD金叉"); }
    if (r >= 50 && r <= 70) s += 15;
    else if ((r >= 45 && r < 50) || (r > 70 && r <= 78)) s += 8;
    else if (r > 85) s -= 5;
    if (isN(hi60) && hi60 > 0) {
      const gap = (last / hi60 - 1) * 100;
      if (gap >= 0) { s += 15; why.push("创60日新高"); }
      else if (gap >= -3) { s += 10; why.push("逼近60日新高"); }
      else if (gap >= -8) s += 5;
    }
    if (isN(vr)) {
      if (vr >= 1.2 && vr <= 3) { s += 10; why.push(`温和放量(量比${vr.toFixed(1)})`); }
      else if ((vr >= 1 && vr < 1.2) || (vr > 3 && vr <= 5)) s += 5;
    }
    if (chg20 > 40) { s -= 15; why.push("短期涨幅过大"); }

    const k5 = k.slice(-5);
    const sg = k5.map((x, i) => sign(i ? x.close - k5[i - 1].close : (c.length > 5 ? x.close - at(c, -6) : 0)));
    const amt5 = k5.reduce((a, x) => a + x.amount, 0);
    const net5 = k5.reduce((a, x, i) => a + sg[i] * x.amount, 0);
    const flow5 = amt5 > 0 ? net5 / amt5 * 100 : NaN;
    if (isN(flow5) && flow5 >= 20) why.push("近5日资金流入");
    const ind = {
      main_pct_5d: rn(flow5, 1), main_net_5d_wan: Math.round(net5 / 1e4),
      ma20: rn(m20), ma60: rn(m60), rsi: rn(r, 1), macd: d > e ? "金叉" : "死叉",
      chg20: rn(chg20, 1), dist_hi60: hi60 ? rn((last / hi60 - 1) * 100, 1) : null,
    };
    return [Math.max(0, Math.min(100, s)), ind, why];
  }

  function detectPatterns(k, code, today, frac) {
    const n = CONFIG.pattern_days;
    if (!k || k.length < n + 2) return null;
    const lim = limitPct(code) - 0.3;
    const c = k.map((x) => x.close), v = k.map((x) => x.volume);
    const pct = c.map((x, i) => (i ? (x / c[i - 1] - 1) * 100 : NaN));
    if (k[k.length - 1].date === today && frac < 1) v[v.length - 1] = v[v.length - 1] / frac;
    const zt = [];
    for (let i = k.length - n; i < k.length; i++) if (pct[i] >= lim) zt.push(i);
    if (!zt.length) return null;
    const lastZ = zt[zt.length - 1];
    let lb = 0, j = lastZ;
    while (j > 0 && pct[j] >= lim) { lb++; j--; }
    const chgN = (at(c, -1) / c[k.length - n - 1] - 1) * 100;
    const out = { zt_count: zt.length, zt_last: k[lastZ].date, zt_streak: lb, chg_n: rn(chgN, 1),
      today_zt: at(pct, -1) >= lim, strong: chgN > 0, pullback: false };
    const after = [];
    for (let i = lastZ + 1; i < k.length; i++) after.push(i);
    if (after.length) {
      const bc = c[lastZ], bv = v[lastZ];
      const rel = after.map((i) => (c[i] / bc - 1) * 100);
      const [lo, hi] = CONFIG.pullback_range;
      const shrink = bv > 0 ? Math.max(...after.map((i) => v[i])) / bv : NaN;
      const ok = Math.min(...rel) >= lo && at(rel, -1) <= hi && Math.max(...rel) <= hi + 1e-9 && shrink < 1;
      Object.assign(out, { pullback: !!ok, pullback_pct: rn(at(rel, -1), 2), pullback_min: rn(Math.min(...rel), 2),
        vol_shrink: isN(shrink) ? rn(shrink, 2) : null, days_since_zt: after.length });
    }
    return out;
  }

  function stockRecord(r, t) {
    const [st, ind, twhy] = t;
    const why = [];
    if (CONFIG.weights.fundamental > 0) {
      if (r.roe_annual >= 15) why.push(`ROE ${r.roe_annual.toFixed(0)}%`);
      if (r.profit_yoy >= 30) why.push(`净利润+${r.profit_yoy.toFixed(0)}%`);
      if (r.rev_yoy >= 20) why.push(`营收+${r.rev_yoy.toFixed(0)}%`);
    }
    if (r.main_pct > 10) why.push("今日主动买入多");
    why.push(...twhy);
    return {
      code: r.code, name: r.name, industry: r.industry || "", market: r.mkt === 1 ? "SH" : "SZ",
      price: rn(r.price), pct: rn(r.pct), score: rn(r.score, 1),
      f_score: rn(r.f_score, 1), c_score: rn(r.c_score, 1), t_score: rn(st, 1),
      mcap_yi: rn(r.mcap / 1e8, 0), amount_yi: rn(r.amount / 1e8, 1),
      pe_ttm: rn(r.pe_ttm, 1), pb: rn(r.pb), turnover: rn(r.turnover),
      roe_annual: rn(r.roe_annual, 1), rev_yoy: rn(r.rev_yoy, 1), profit_yoy: rn(r.profit_yoy, 1), gross_margin: rn(r.gross_margin, 1),
      report_date: r.report_date || null,
      main_net_wan: rn(r.main_net / 1e4, 0), main_pct: rn(r.main_pct),
      vol_ratio: rn(r.vol_ratio), ...ind, reasons: why,
    };
  }

  // 用本机缓存的历史 K 线 + 实时行情拼出完整 K 线；对不上（除权除息、缓存过期）就返回 null，改为重新下载
  const close2 = (a, b) => isN(a) && isN(b) && Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.0005);
  function barsFromCache(c, r, ltd, prevTd, sessionDone) {
    if (!c || !Array.isArray(c.bars) || c.bars.length < CONFIG.min_kline_days - 1) return null;
    const lastBar = c.bars[c.bars.length - 1];
    const bars = c.bars.map((b) => ({ date: b[0], open: b[1], close: b[2], high: b[3], low: b[4], volume: b[5], amount: b[2] * b[5] * 100 }));
    if (lastBar[0] === ltd && sessionDone && close2(lastBar[2], r.price)) return bars.slice(-130);
    if (!(lastBar[0] === prevTd && close2(lastBar[2], r.prev_close))) return null;
    if (!(r.volume > 0) || !isN(r.open) || !isN(r.high) || !isN(r.low) || !isN(r.price)) return null;
    bars.push({ date: ltd, open: r.open, close: r.price, high: r.high, low: r.low, volume: r.volume, amount: r.price * r.volume * 100 });
    return bars.slice(-130);
  }

  function tdCounts(c) {
    let buy = 0, sell = 0, i = c.length - 1;
    while (i >= 4 && c[i] < c[i - 4]) { buy++; i--; }
    i = c.length - 1;
    while (i >= 4 && c[i] > c[i - 4]) { sell++; i--; }
    return [buy, sell];
  }
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

  // 回调蓄势：先有放量大涨（第一个箭头），之后缩量回调到位、未破位（第二个箭头）
  function detectSetup(k, code, today, frac) {
    const n = k ? k.length : 0;
    if (n < 40) return null;
    const lim = limitPct(code);
    const c = k.map((x) => x.close), o = k.map((x) => x.open), h = k.map((x) => x.high), lo = k.map((x) => x.low), v = k.map((x) => x.volume);
    if (k[n - 1].date === today && frac < 1) v[n - 1] = v[n - 1] / frac;
    const pct = c.map((x, i) => (i ? (x / c[i - 1] - 1) * 100 : NaN));
    const last = n - 1;
    const loI = Math.max(1, n - CONFIG.setup_lookback - 1), hiI = n - 3;
    if (hiI <= loI) return null;
    let iH = loI;
    for (let i = loI; i <= hiI; i++) if (c[i] > c[iH]) iH = i;
    const H = Math.max(...h.slice(Math.max(0, iH - 1), iH + 2));
    const j0 = Math.max(1, iH - 12);
    let iL = j0;
    for (let i = j0; i <= iH; i++) if (lo[i] < lo[iL]) iL = i;
    const L0 = lo[iL];
    if (H <= L0 || iL < 21) return null;
    const amp = H / L0 - 1;
    if (amp < CONFIG.setup_min_amp) return null;
    const bigThr = Math.max(6, 0.5 * lim);
    const big = [];
    for (let i = iL; i <= iH; i++) {
      const avg20 = mean(v.slice(i - 20, i));
      const vr = avg20 > 0 ? v[i] / avg20 : 0;
      if ((pct[i] >= bigThr && vr >= 2) || pct[i] >= lim - 0.3) big.push([i, pct[i], vr]);
    }
    if (!big.length) return null;
    const Vs = Math.max(...v.slice(iL, iH + 1));
    const days = last - iH;
    if (days < CONFIG.setup_pull_days[0] || days > CONFIG.setup_pull_days[1]) return null;
    const C = c[last];
    const r = (H - C) / (H - L0);
    const PL = Math.min(...lo.slice(iH + 1, last + 1));
    if (r < CONFIG.setup_retrace[0] || r > CONFIG.setup_retrace[1] || PL < 0.96 * L0) return null;
    const worst = Math.min(...pct.slice(iH + 1, last + 1));
    if (worst <= -0.6 * lim) return null;
    if (C > 0.93 * H || pct[last] >= bigThr) return null;
    const Vt = v[last];
    const prev3 = mean(v.slice(last - 3, last));
    const prev5 = last - 1 >= iH + 1 ? mean(v.slice(Math.max(iH + 1, last - 5), last)) : prev3;
    const shrink = Vs > 0 ? Vt / Vs : 1;
    const ma = (w) => (last - w + 1 >= 0 ? mean(c.slice(last - w + 1, last + 1)) : NaN);
    const m5 = ma(5), m10 = ma(10), m20 = ma(20), m60 = ma(60);
    const d20 = C / m20 - 1, d60 = isN(m60) ? C / m60 - 1 : NaN;
    if (isN(m60) && C < 0.9 * m60) return null;
    const near = Math.min(Math.abs(d20), isN(d60) ? Math.abs(d60) : 9) <= 0.04;
    const mas = [m5, m10, m20, m60].filter(isN);
    const spread = (Math.max(...mas) - Math.min(...mas)) / C;
    const m60Prev = last - 64 >= 0 ? mean(c.slice(last - 64, last - 4)) : m60;
    const m60Up = isN(m60) && m60 >= m60Prev;
    if (!(r >= 0.5 || near)) return null;
    let sig = null;
    if (c[last] > o[last] && pct[last] >= 1.5 && Vt >= 1.3 * prev3 && shrink <= 0.9) sig = "企稳回升";
    else if (Math.abs(pct[last]) <= 0.4 * lim && shrink <= 0.6 && Vt <= 0.75 * prev5) sig = "缩量到位";
    if (!sig) return null;
    const [bi, bpct, bvr] = big.reduce((a, b) => (b[1] > a[1] ? b : a));
    let score = Math.min(amp / 0.3, 1) * 20 + (bvr >= 3 ? 5 : 0);
    score += (1 - Math.min(shrink, 1)) * 25;
    score += r >= 0.5 && r <= 0.9 ? 15 : 8;
    score += near ? 10 : 0;
    score += spread <= 0.06 ? 5 : 0;
    score += m60Up ? 5 : 0;
    score += sig === "企稳回升" ? 15 : 8;
    score += worst > -0.4 * lim ? 5 : 0;
    const [tdb, tds] = tdCounts(c);
    const why = [sig, `回调第${days}天`, `缩量至${Math.round(shrink * 100)}%`];
    if (near) why.push("回到均线支撑");
    if (spread <= 0.06) why.push("均线粘合");
    if (tdb >= 7) why.push(`九转买${tdb}`);
    return {
      setup: true, setup_score: rn(Math.min(score, 100), 1), setup_sig: sig, setup_why: why,
      surge_date: k[bi].date, surge_pct: rn(bpct, 1), surge_vr: rn(bvr, 1),
      surge_amp: rn(amp * 100, 1), surge_high: rn(H), surge_low: rn(L0),
      pull_days: days, retrace: Math.round(r * 100), dist_high: rn((C / H - 1) * 100, 1),
      pull_low: rn(PL), worst_day: rn(worst, 1), vol_shrink_s: rn(shrink), vol_vs_prev3: prev3 > 0 ? rn(Vt / prev3) : null,
      dist_ma20: rn(d20 * 100, 1), dist_ma60: isN(d60) ? rn(d60 * 100, 1) : null,
      ma_spread: rn(spread * 100, 1), ma60_up: !!m60Up, td_buy: tdb, td_sell: tds,
    };
  }

  // ───────── 放量大涨记录（第一个箭头的名单）：页面数据文件 + 本机保存 ─────────
  const REG_KEY = "astock_surges";
  async function loadRegistry() {
    let remote = null, local = null;
    try {
      const r = await fetch("data/surges.json?t=" + Date.now(), { cache: "no-store" });
      if (r.ok) remote = await r.json();
    } catch (e) { /* 没有就用本机的 */ }
    local = ls.get(REG_KEY);
    const items = new Map();
    for (const src of [remote, local]) for (const x of ((src && src.items) || [])) {
      if (!x.c || !x.d) continue;
      const k = x.c + "|" + x.d, old = items.get(k);
      items.set(k, old ? { ...old, ...x, hi: Math.max(old.hi || 0, x.hi || 0) } : { ...x });
    }
    return { items: [...items.values()] };
  }
  function updateRegistry(reg, spot, today, isTrading, ztPools) {
    const items = new Map(reg.items.map((x) => [x.c + "|" + x.d, { ...x }]));
    const hiToday = new Map(spot.map((r) => [r.code, r.high]));
    if (isTrading) {
      for (const x of items.values()) { const hh = hiToday.get(x.c); if (isN(hh)) x.hi = rn(Math.max(x.hi || 0, hh)); }
      for (const r of spot) {
        const lim = limitPct(r.code);
        if (r.pct >= Math.max(6, 0.5 * lim) && (r.vol_ratio >= 2 || r.pct >= lim - 0.3))
          items.set(r.code + "|" + today, { c: r.code, d: today, p: rn(r.price), hi: rn(r.high), pct: rn(r.pct, 1), vr: rn(r.vol_ratio, 1) });
      }
    }
    for (const { d, m } of ztPools) for (const [c, info] of m) {
      if (!items.has(c + "|" + d)) items.set(c + "|" + d, { c, d, p: info.p, hi: info.p, pct: info.pct, vr: null });
    }
    const cutoff = new Date(Date.parse(today + "T00:00:00Z") - 45 * 86400000).toISOString().slice(0, 10);
    const out = [...items.values()].filter((x) => x.d >= cutoff).sort((a, b) => (a.d + a.c).localeCompare(b.d + b.c));
    return { updated: today, items: out };
  }
  function setupCandidates(reg, spot, today) {
    const price = new Map(spot.map((r) => [r.code, r.price]));
    const latest = new Map();
    for (const x of reg.items) {
      const cur = latest.get(x.c);
      const hiAll = Math.max((cur && cur.hi_all) || 0, x.hi || x.p || 0);
      if (!cur || x.d > cur.d) latest.set(x.c, { ...x, hi_all: hiAll }); else cur.hi_all = hiAll;
    }
    const cutoff = new Date(Date.parse(today + "T00:00:00Z") - 36 * 86400000).toISOString().slice(0, 10);
    const out = new Set();
    for (const [c, x] of latest) {
      const C = price.get(c), hi = x.hi_all || 0, p = x.p || 0;
      if (!isN(C) || x.d < cutoff || hi <= 0 || p <= 0) continue;
      if (C <= 0.93 * hi && C >= 0.75 * p) out.add(c);
    }
    return out;
  }

  // ───────── 主流程 ─────────
  async function run({ onProgress = () => {} } = {}) {
    const t0 = Date.now();
    const now = cnNow();
    const today = now.date;
    onProgress("正在获取交易日、财报和涨停股（1/3）", 3);
    const tdP = tradingDates(CONFIG.pattern_days + 1);
    const finP = fetchFinancials(today);
    const ztP = tdP.then((td) => Promise.all(td.slice(-CONFIG.pattern_days).map((d) => fetchZtPool(d).then((m) => ({ d, m }), () => null))));
    const regP = loadRegistry();
    const tdates = await tdP;
    const ltd = tdates[tdates.length - 1];
    const prevTd = tdates[tdates.length - 2];
    const isTrading = ltd === today;
    const frac = isTrading ? tradingFraction(now.h, now.m) : 1;
    const sessionDone = !isTrading || now.h * 60 + now.m >= 15 * 60 + 5;  // 当天 K 线是否已收盘定型
    const meta = { version: VERSION, run_at: now.iso, trade_date: ltd || today, is_trading_day: isTrading, local: true };
    const fin = await finP;
    const codes = [...fin.values()].filter((f) => !String(f.exchange).includes("北")).map((f) => f.code);

    onProgress("正在获取实时行情（2/3）", 12);
    const spot = await fetchSpot(codes, (i, n) => onProgress(`正在获取实时行情（2/3）${i}/${n}`, 12 + 18 * i / n));
    meta.universe = spot.length;
    const up = spot.filter((r) => r.pct > 0).length, down = spot.filter((r) => r.pct < 0).length;
    const market = {
      up, down, flat: spot.length - up - down,
      main_net_yi: rn(spot.reduce((a, r) => a + (isN(r.main_net) ? r.main_net : 0), 0) / 1e8, 1),
      amount_yi: Math.round(spot.reduce((a, r) => a + (isN(r.amount) ? r.amount : 0), 0) / 1e8),
      flow_basis: "主动买卖（外盘-内盘）",
    };

    const df = spot.map((s) => {
      const f = fin.get(s.code) || {};
      return { ...f, ...s, name: s.name || f.fin_name, industry: f.industry || "", report_date: f.report_date };
    });
    const minM = Math.min(CONFIG.min_mcap_yi, CONFIG.pattern_min_mcap_yi) * 1e8;
    const minA = Math.min(CONFIG.min_amount_yi, CONFIG.pattern_min_amount_yi) * 1e8;
    const base = df.filter((r) => r.price > 0 && !(CONFIG.exclude_st && /ST|退/.test(r.name || "")) &&
      r.mcap >= minM && r.amount > 0 && r.amount >= minA);

    const fR = [pctRank(base.map((r) => r.roe_annual)), pctRank(base.map((r) => r.rev_yoy)), pctRank(base.map((r) => r.profit_yoy)),
      pctRank(base.map((r) => r.gross_margin)), pctRank(base.map((r) => (r.pe_ttm > 0 ? r.pe_ttm : NaN)), false)];
    const cR = [pctRank(base.map((r) => r.main_pct)), pctRank(base.map((r) => (isN(r.vol_ratio) ? Math.min(r.vol_ratio, 3) : NaN)))];
    base.forEach((r, i) => {
      r.f_score = 0.30 * fR[0][i] + 0.20 * fR[1][i] + 0.25 * fR[2][i] + 0.10 * fR[3][i] + 0.15 * fR[4][i];
      r.c_score = 0.7 * cR[0][i] + 0.3 * cR[1][i];
    });

    const pe = CONFIG.pe_ttm_range;
    const strict = base.filter((r) => r.mcap >= CONFIG.min_mcap_yi * 1e8 && r.amount >= CONFIG.min_amount_yi * 1e8 &&
      (!pe || (r.pe_ttm > pe[0] && r.pe_ttm <= pe[1])) &&
      (CONFIG.min_roe_annual == null || r.roe_annual >= CONFIG.min_roe_annual) &&
      (CONFIG.min_profit_yoy == null || (isN(r.profit_yoy) ? r.profit_yoy : -999) >= CONFIG.min_profit_yoy) &&
      (!CONFIG.exclude_limit || Math.abs(r.pct) < limitPct(r.code) - 0.3));
    meta.after_filter = strict.length;
    const wf = CONFIG.weights.fundamental;
    const pre = (r) => wf * r.f_score + (1 - wf) * r.c_score;
    const compCand = new Set(strict.slice().sort((a, b) => pre(b) - pre(a))
      .slice(0, CONFIG.tech_candidates).map((r) => r.code));

    const patBase = new Set(base.filter((r) => r.mcap >= CONFIG.pattern_min_mcap_yi * 1e8 && r.amount >= CONFIG.pattern_min_amount_yi * 1e8).map((r) => r.code));
    let zt = new Set(), poolOk = true;
    for (const x of await ztP) {
      if (!x) { poolOk = false; continue; }
      x.m.forEach((_, c) => zt.add(c));
      if (x.d === ltd) market.zt_today = x.m.size;
    }
    if (!poolOk) zt = patBase;
    const patCand = new Set([...zt].filter((c) => patBase.has(c)));
    const registry = updateRegistry(await regP, spot, today, isTrading, (await ztP).filter(Boolean));
    ls.set(REG_KEY, registry);
    const baseCodes = new Set(base.map((r) => r.code));
    const setupCand = new Set([...setupCandidates(registry, spot, today)].filter((c) => baseCodes.has(c)));
    meta.setup_cand = setupCand.size;
    meta.zt_pool = poolOk ? zt.size : null;

    const byCode = new Map(base.map((r) => [r.code, r]));
    // 粘合蓄势候选：今天没大涨大跌、量比不夸张；有缓存的全看，没缓存的每次最多新拉 N 只（轮换）
    const others = new Set([...compCand, ...patCand, ...setupCand]);
    const [sqM0, sqM1] = CONFIG.squeeze_mcap_range;
    const sqEligible = new Set(base.filter((r) => Math.abs(r.pct) < 0.45 * limitPct(r.code) && (isN(r.vol_ratio) ? r.vol_ratio : 1) <= 2.5 && r.price >= 2
      && r.mcap >= sqM0 * 1e8 && r.mcap <= sqM1 * 1e8 && !CONFIG.squeeze_exclude_industries.includes(String(r.industry || ""))).map((r) => r.code));
    const sqAll = [...sqEligible].filter((c) => !others.has(c));
    const sqCache = await idb.getMany(sqAll);
    const sqCached = sqAll.filter((c) => sqCache.get(c)), sqNew = sqAll.filter((c) => !sqCache.get(c));
    for (let i = sqNew.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [sqNew[i], sqNew[j]] = [sqNew[j], sqNew[i]]; }
    const sqOptional = new Set(sqNew.slice(0, CONFIG.squeeze_fetch_max));   // 可选：拉不到、超时都不影响其他榜单
    const squeezeCand = new Set([...sqCached, ...sqOptional]);
    meta.squeeze_cand = squeezeCand.size;
    const need = [...new Set([...others, ...sqCached])];
    const tK0 = Date.now();
    let sqSkipped = 0;
    const tech = new Map(), pats = new Map(), setups = new Map(), squeezes = new Map();
    let done = 0, fromCache = 0;
    const cache = await idb.getMany(need);
    const toStore = [];
    const fromCacheBars = (code, r) => barsFromCache(cache.get(code), r, ltd, prevTd, sessionDone);
    const job = async (code) => {
      const r = byCode.get(code);
      try {
        let k = fromCacheBars(code, r);
        if (k) fromCache++;
        else {
          if (sqOptional.has(code) && Date.now() - tK0 > CONFIG.squeeze_fetch_seconds * 1000) { sqSkipped++; return null; }
          k = await fetchKline(r.mkt, code, 130, sqOptional.has(code) ? 1 : 5);
          if (k && k.length) {
            const keep = k.filter((b) => b.date < today || (b.date === today && sessionDone));
            toStore.push([code, { saved: now.iso, bars: keep.map((b) => [b.date, b.open, b.close, b.high, b.low, b.volume]) }]);
          }
        }
        if (k && k.length >= CONFIG.min_kline_days) {
          tech.set(code, technicals(k, r.vol_ratio));
          if (patCand.has(code)) { const p = detectPatterns(k, code, today, frac); if (p) pats.set(code, p); }
          if (setupCand.has(code)) { const su = detectSetup(k, code, today, frac); if (su) setups.set(code, su); }
          const sq = detectSqueeze(k, code, today, frac); if (sq) squeezes.set(code, sq);
        }
        return null;
      } catch (e) { return code; }
      finally { onProgress(`正在计算走势（3/3）${++done}/${need.length}`, 32 + 66 * done / need.length); }
    };
    let failed = (await pool(need, 8, job)).filter(Boolean);
    if (failed.length) { await sleep(3000); done = need.length - failed.length; failed = (await pool(failed, 2, job)).filter(Boolean); }
    meta.kline_failed = failed.length;
    if (sqOptional.size) {   // 可选的粘合蓄势新候选放最后拉，有时间限制
      const optList = [...sqOptional]; done = 0;
      const optCache = await idb.getMany(optList); optList.forEach((c) => cache.set(c, optCache.get(c)));
      const optFailed = (await pool(optList, 6, async (code) => { const r = await job(code); onProgress(`正在补充粘合蓄势候选 ${done}/${optList.length}`, 98); return r; })).filter(Boolean);
      meta.squeeze_fetched = optList.length - optFailed.length;
    }
    meta.kline_cached = fromCache;
    idb.putMany(toStore);

    const w = CONFIG.weights;
    const scored = base.filter((r) => tech.has(r.code));
    scored.forEach((r) => { r.t_score = tech.get(r.code)[0]; r.score = w.fundamental * r.f_score + w.capital * r.c_score + w.technical * r.t_score; });

    const comp = scored.filter((r) => compCand.has(r.code)).sort((a, b) => b.score - a.score).slice(0, CONFIG.top_n);
    const picks = comp.map((r, i) => {
      const rec = stockRecord(r, tech.get(r.code));
      const p = pats.get(r.code);
      if (p && p.pullback) rec.reasons.unshift("涨停缩量回调");
      else if (p && p.strong) rec.reasons.unshift(`近${CONFIG.pattern_days}日涨停`);
      rec.reasons = rec.reasons.slice(0, 6);
      return { rank: i + 1, ...rec };
    });
    meta.tech_scored = scored.filter((r) => compCand.has(r.code)).length;

    const scoredMap = new Map(scored.map((r) => [r.code, r]));
    const patternList = (key, cmp) => {
      const out = [];
      for (const [code, p] of pats) {
        if (!p[key] || !scoredMap.has(code)) continue;
        const rec = stockRecord(scoredMap.get(code), tech.get(code));
        const tags = [p.zt_count > 1 ? `${p.zt_count}次涨停` : "1次涨停"];
        if (p.zt_streak >= 2) tags.push(`${p.zt_streak}连板`);
        if (p.today_zt) tags.push("今日涨停");
        if (key === "pullback") { tags.push(`回调${p.pullback_pct >= 0 ? "+" : ""}${p.pullback_pct.toFixed(1)}%`); tags.push(`缩量至${Math.round(p.vol_shrink * 100)}%`); }
        rec.reasons = [...tags, ...rec.reasons].slice(0, 6);
        for (const k of ["zt_count", "zt_last", "zt_streak", "chg_n", "today_zt", "pullback_pct", "pullback_min", "vol_shrink", "days_since_zt"]) rec[k] = p[k] ?? null;
        out.push(rec);
      }
      out.sort(cmp);
      return out.slice(0, CONFIG.pattern_max_list).map((r, i) => ({ ...r, rank: i + 1 }));
    };
    const strong = patternList("strong", (a, b) => (b.zt_count - a.zt_count) || ((b.chg_n || 0) - (a.chg_n || 0)));
    const pullback = patternList("pullback", (a, b) => (b.score || 0) - (a.score || 0));
    const setup = [];
    for (const [code, su] of setups) {
      if (!scoredMap.has(code) || !tech.has(code)) continue;
      const rec = stockRecord(scoredMap.get(code), tech.get(code));
      rec.reasons = [...su.setup_why, ...rec.reasons.filter((w) => !su.setup_why.includes(w))].slice(0, 6);
      const { setup_why, ...rest } = su;
      Object.assign(rec, rest);
      setup.push(rec);
    }
    setup.sort((a, b) => (b.setup_score - a.setup_score) || (a.dist_high - b.dist_high));
    const setupList = setup.slice(0, CONFIG.setup_max_list).map((r, i) => ({ ...r, rank: i + 1 }));
    // 粘合蓄势榜：回调蓄势里已经有的不重复
    const squeeze = [];
    for (const [code, sq] of squeezes) {
      if (!scoredMap.has(code) || !tech.has(code) || setups.has(code) || !sqEligible.has(code)) continue;
      const rec = stockRecord(scoredMap.get(code), tech.get(code));
      const tags = [sq.sq_sig, ...sq.sq_why.filter((w) => w !== sq.sq_sig)];
      rec.reasons = [...tags, ...rec.reasons.filter((w) => !tags.includes(w))].slice(0, 6);
      const { sq_why, ...rest } = sq;
      Object.assign(rec, rest);
      squeeze.push(rec);
    }
    const sqOrder = { "蓄势待发": 0, "回踩均线": 0, "横盘粘合": 1 };
    squeeze.sort((a, b) => ((sqOrder[a.sq_sig] ?? 2) - (sqOrder[b.sq_sig] ?? 2)) || (b.sq_score - a.sq_score) || ((b.score || 0) - (a.score || 0)));
    const squeezeList = squeeze.slice(0, CONFIG.squeeze_max_list).map((r, i) => ({ ...r, rank: i + 1 }));

    const indCount = new Map();
    picks.forEach((p) => p.industry && indCount.set(p.industry, (indCount.get(p.industry) || 0) + 1));
    meta.elapsed_s = Math.round((Date.now() - t0) / 100) / 10;
    meta.diag = { zt_pool_ok: poolOk, fin_coverage: rn(df.filter((r) => isN(r.roe_annual)).length / (df.length || 1), 2) };
    onProgress("完成", 100);
    return {
      ...meta, status: "ok", market, picks, strong, pullback, setup: setupList, squeeze: squeezeList,
      top_industries: [...indCount].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count })),
      config: CONFIG,
    };
  }

  window.AStockEngine = { run, VERSION, _t: { fetchKline, fetchSpot, technicals, detectPatterns, detectSetup, detectSqueeze, barsFromCache, tradingDates } };
})();
