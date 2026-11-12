export const PDF_ORIGIN = 'https://static.cninfo.com.cn/';
export const REPORT_YEARS = 10;

export function normalizeName(s = '') {
  return String(s).normalize('NFKC').toLowerCase().replace(/[\s·•._-]/g, '');
}

export function parseStockList(data) {
  if (!data || !Array.isArray(data.stockList)) throw new Error('股票列表的数据结构发生变化');
  const unique = new Map();
  for (const row of data.stockList) {
    const code = String(row.code ?? '').trim();
    const orgId = String(row.orgId ?? '').trim();
    if (!/^\d{6}$/.test(code) || !orgId) continue;
    const name = String(row.zwjc ?? row.name ?? '').trim();
    const pinyin = String(row.pinyin ?? '').trim();
    if (!unique.has(code)) unique.set(code, { code, name, orgId, pinyin });
  }
  if (!unique.size) throw new Error('股票列表为空');
  return [...unique.values()];
}

export function marketForCode(code) {
  if (/^(60|68|69)/.test(code)) return { column: 'sse', plate: code.startsWith('68') ? 'shkcp' : 'sh', prefix: 'gssh0' };
  if (/^(00|30)/.test(code)) return { column: 'szse', plate: code.startsWith('30') ? 'szcy' : 'sz', prefix: 'gssz0' };
  if (/^(4|8|92)/.test(code)) return { column: 'bj', plate: '', prefix: '' };
  return { column: 'szse', plate: '', prefix: 'gssz0' };
}

export function scoreStock(stock, query) {
  const q = normalizeName(query);
  if (!q) return 0;
  const code = stock.code;
  const name = normalizeName(stock.name);
  const pinyin = normalizeName(stock.pinyin);
  if (code === q) return 100;
  if (name === q) return 95;
  if (code.startsWith(q)) return 88;
  if (name.startsWith(q)) return 84;
  if (pinyin === q) return 78;
  if (pinyin.startsWith(q)) return 72;
  if (name.includes(q)) return 60;
  if (pinyin.includes(q)) return 55;
  return 0;
}

export function findStocks(stocks, query, limit = 10) {
  const q = normalizeName(query);
  if (!q) return [];
  return stocks.map(s => ({ s, score: scoreStock(s, q) })).filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.code.localeCompare(b.s.code))
    .slice(0, limit).map(x => x.s);
}

export function extractFiscalYear(title) {
  // 同时匹配「2025年年度报告」和「2025年度报告」，不把披露年份当财务年度。
  const m = String(title).replace(/<[^>]*>/g, '').match(/(20\d{2})\s*年\s*(?:年度报告|度报告)/u);
  return m ? Number(m[1]) : null;
}

export function isFullAnnualReport(title) {
  const t = String(title).replace(/<[^>]*>/g, '').replace(/\s+/g, '');
  return extractFiscalYear(t) !== null && !/摘要|英文版|英文报告|English|关于|取消|提示性|问询|回复|答复|补充公告|鉴证报告|审计报告|意见|业绩预告/i.test(t);
}

export function asPdfUrl(path) {
  if (typeof path !== 'string' || !/^finalpage\/[0-9-]+\/[0-9]+\.(?:pdf|PDF)$/.test(path)) return null;
  return new URL(path, PDF_ORIGIN).href;
}

export function makeDetailUrl(ann, code, orgId) {
  const day = ann.announcementTime ? new Date(Number(ann.announcementTime) + 8 * 3600000).toISOString().slice(0, 10) : '';
  if (!/^\d{6}$/.test(code) || !/^[\w-]+$/.test(orgId) || !/^\d+$/.test(String(ann.announcementId ?? ''))) return null;
  const p = new URLSearchParams({ stockCode: code, announcementId: String(ann.announcementId), orgId, announcementTime: day });
  return `https://www.cninfo.com.cn/new/disclosure/detail?${p}`;
}

function editionScore(title, time) {
  const t = String(title);
  const revised = /更新后|修订|更正后|更正版|修正版/.test(t) ? 10000000000000 : 0;
  return revised + (Number(time) || 0);
}

export function groupReports(announcements, code, orgId, nowYear = new Date().getFullYear()) {
  const minYear = nowYear - REPORT_YEARS;
  const maxYear = nowYear - 1;
  const grouped = new Map();
  for (const a of announcements || []) {
    // 北交所证券可能从 8 开头迁移至 92 开头，机构 ID 保持不变。
    if (a.secCode && a.secCode !== code && a.orgId !== orgId) continue;
    if (!isFullAnnualReport(a.announcementTitle)) continue;
    const year = extractFiscalYear(a.announcementTitle);
    const pdfUrl = asPdfUrl(a.adjunctUrl);
    if (year < minYear || year > maxYear || !pdfUrl) continue;
    const title = String(a.announcementTitle).replace(/<[^>]*>/g, '');
    const item = {
      title, year, pdfUrl,
      detailUrl: makeDetailUrl(a, code, orgId),
      announcedOn: a.announcementTime ? new Date(Number(a.announcementTime) + 8 * 3600000).toISOString().slice(0, 10) : null,
      revised: /更新后|修订|更正后|更正版|修正版/.test(title),
      order: editionScore(title, a.announcementTime)
    };
    if (!grouped.has(year)) grouped.set(year, []);
    grouped.get(year).push(item);
  }
  return Array.from({ length: REPORT_YEARS }, (_, i) => {
    const year = maxYear - i;
    const editions = (grouped.get(year) || []).sort((a, b) => b.order - a.order);
    for (const edition of editions) delete edition.order;
    return { year, available: editions.length > 0, primary: editions[0] || null, editions };
  });
}
