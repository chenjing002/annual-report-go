import { groupReports, marketForCode } from './core.mjs';

const CNINFO = 'https://www.cninfo.com.cn';
const REPORT_TTL = 12 * 3600;
const STALE_TTL = 7 * 86400;
const MAX_PAGES = 8;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...extra
  }});
}

async function upstream(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, headers: {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Origin': CNINFO,
      'Referer': `${CNINFO}/new/commonUrl/pageOfSearch?url=disclosure/list/search`,
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      ...init.headers
    }});
    if (!response.ok) throw Object.assign(new Error(`巨潮返回 HTTP ${response.status}`), {
      code: response.status === 429 ? 'UPSTREAM_RATE_LIMIT' : response.status === 446 || response.status === 403 ? 'UPSTREAM_BLOCKED' : 'UPSTREAM_UNAVAILABLE',
      status: response.status === 429 ? 503 : 502
    });
    if (!(response.headers.get('content-type') || '').toLowerCase().includes('json'))
      throw Object.assign(new Error('巨潮返回了非 JSON 内容，可能触发访问限制'), { code: 'UPSTREAM_BLOCKED', status: 502 });
    const body = await response.text();
    if (body.length > 2_000_000) throw new Error('巨潮响应超出预期大小');
    return JSON.parse(body);
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('巨潮请求超时'), { code: 'UPSTREAM_TIMEOUT', status: 504 });
    throw error;
  } finally { clearTimeout(timer); }
}

async function queryWindow(stock, start, end, market) {
  const results = [];
  let pages = 1;
  for (let page = 1; page <= Math.min(MAX_PAGES, pages); page++) {
    const body = new URLSearchParams({
      stock: `${stock.code},${stock.orgId}`, tabName: 'fulltext', pageNum: String(page),
      pageSize: '30', column: market.column, plate: market.plate,
      category: 'category_ndbg_szsh;', seDate: `${start}~${end}`,
      searchkey: '', trade: '', isHLtitle: 'true'
    });
    const data = await upstream(`${CNINFO}/new/hisAnnouncement/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body
    });
    if (data && data.announcements == null && Number(data.totalRecordNum) === 0) data.announcements = [];
    if (!data || !Array.isArray(data.announcements)) throw Object.assign(
      new Error('巨潮公告响应结构发生变化'), { code: 'UPSTREAM_FORMAT', status: 502 });
    results.push(...data.announcements);
    pages = Math.min(MAX_PAGES, Math.max(1, Number(data.totalpages) || 1));
    if (data.hasMore === false) break;
  }
  return results;
}

async function getStock(code, env, request) {
  const asset = await env.ASSETS.fetch(new Request(new URL('/stocks.json', request.url)));
  if (!asset.ok) throw Object.assign(new Error('公司索引不可用'), { status: 503, code: 'INDEX_UNAVAILABLE' });
  const stocks = await asset.json();
  const stock = stocks.find(s => s.code === code);
  if (!stock || !/^[\w-]{3,50}$/.test(stock.orgId))
    throw Object.assign(new Error('索引中没有该公司，请核对代码'), { status: 404, code: 'STOCK_NOT_FOUND' });
  return stock;
}

async function reportData(stock) {
  const now = new Date();
  const maxYear = now.getUTCFullYear() - 1;
  const minYear = maxYear - 9;
  const market = marketForCode(stock.code);
  const windows = [
    [`${minYear + 1}-01-01`, `${minYear + 5}-12-31`],
    [`${minYear + 6}-01-01`, `${now.getUTCFullYear()}-12-31`]
  ];
  const attempts = await Promise.allSettled(windows.map(([a, b]) => queryWindow(stock, a, b, market)));
  if (attempts.some(x => x.status === 'rejected')) {
    const error = attempts.find(x => x.status === 'rejected').reason;
    throw error; // Never cache incomplete results as a complete decade.
  }
  return { stock: { code: stock.code, name: stock.name },
    reports: groupReports(attempts.flatMap(x => x.value), stock.code, stock.orgId, now.getUTCFullYear()),
    source: 'cninfo', partial: false, fetchedAt: now.toISOString() };
}

async function reportRequest(request, env, ctx, url) {
  const code = url.searchParams.get('code') || '';
  if (!/^\d{6}$/.test(code)) return json({ error: '股票代码必须为6位数字', code: 'INVALID_CODE' }, 400);
  const cache = caches.default;
  const key = new Request(new URL(`/__cache/reports/${code}`, url.origin));
  const staleKey = new Request(new URL(`/__cache/stale/${code}`, url.origin));
  const refresh = url.searchParams.get('refresh') === '1';
  if (!refresh) {
    const hit = await cache.match(key);
    if (hit) return json({ ...await hit.json(), cache: 'hit' });
  }
  try {
    const stock = await getStock(code, env, request);
    const data = await reportData(stock);
    const fresh = json(data, 200, { 'Cache-Control': `public, max-age=${REPORT_TTL}` });
    const stale = json(data, 200, { 'Cache-Control': `public, max-age=${STALE_TTL}` });
    ctx.waitUntil(Promise.all([cache.put(key, fresh), cache.put(staleKey, stale)]));
    return json({ ...data, cache: 'miss' });
  } catch (e) {
    console.warn(JSON.stringify({ event: 'cninfo_failure', code, reason: e.code || e.name || 'unknown', message: e.message }));
    const stale = await cache.match(staleKey);
    if (stale) return json({ ...await stale.json(), cache: 'stale', stale: true, warning: '巨潮暂时不可用，显示上次成功查询的结果' });
    return json({ error: e.message || '查询暂时不可用', code: e.code || 'UPSTREAM_UNAVAILABLE' }, e.status || 502,
      e.status === 404 ? {} : { 'Retry-After': e.code === 'UPSTREAM_RATE_LIMIT' ? '300' : '60' });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/reports') return env.ASSETS.fetch(request);
    if (request.method !== 'GET') return json({ error: '仅支持 GET' }, 405, { Allow: 'GET' });
    return reportRequest(request, env, ctx, url);
  }
};
