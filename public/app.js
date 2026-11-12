const $ = id => document.getElementById(id);
const input = $('stockQuery');
const matchBox = $('matches');
const status = $('lookupStatus');
let stocks = [];
let matches = [];
let selectedStock = null;
let activeIndex = 0;
const STORAGE_KEY = 'annual-report-finder-recents-v1';
const normalize = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s·•._-]/g, '');

function score(s, query) {
  const q = normalize(query), name = normalize(s.name), pinyin = normalize(s.pinyin);
  if (s.code === q) return 100;
  if (name === q) return 95;
  if (s.code.startsWith(q)) return 88;
  if (name.startsWith(q)) return 84;
  if (pinyin === q) return 78;
  if (pinyin.startsWith(q)) return 72;
  if (name.includes(q)) return 60;
  if (pinyin.includes(q)) return 55;
  return 0;
}
function getMatches(q) {
  if (!normalize(q)) return [];
  return stocks.map(s => ({ s, score: score(s, q) }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || a.s.code.localeCompare(b.s.code))
    .slice(0, 8).map(x => x.s);
}
function hideMatches() { matchBox.hidden = true; }
function renderMatches() {
  matches = getMatches(input.value);
  activeIndex = 0;
  matchBox.replaceChildren();
  if (!matches.length) return hideMatches();
  matches.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'match' + (i === activeIndex ? ' active' : '');
    div.setAttribute('role', 'option');
    const name = document.createElement('span'); name.className = 'match-name'; name.textContent = s.name;
    const code = document.createElement('span'); code.className = 'match-code'; code.textContent = s.code;
    div.append(name, code);
    div.addEventListener('mousedown', ev => ev.preventDefault());
    div.addEventListener('click', () => selectStock(s));
    matchBox.append(div);
  });
  matchBox.hidden = false;
}
input.addEventListener('input', renderMatches);
input.addEventListener('keydown', e => {
  if (e.key === 'Escape') return hideMatches();
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && matches.length && !matchBox.hidden) {
    e.preventDefault();
    activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
    [...matchBox.children].forEach((el, i) => el.classList.toggle('active', i === activeIndex));
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const chosen = (!matchBox.hidden && matches[activeIndex]) || getMatches(input.value)[0];
    if (chosen) selectStock(chosen);
    else status.textContent = '没有匹配的公司，请核对代码或简称。';
  }
});
input.addEventListener('blur', () => setTimeout(hideMatches, 120));

function loadRecents() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; } }
function saveRecent(s) {
  const items = [s, ...loadRecents().filter(x => x.code !== s.code)].slice(0, 5);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch {}
  renderRecents();
}
function renderRecents() {
  const items = loadRecents();
  $('recentSection').hidden = items.length === 0;
  $('recentItems').replaceChildren();
  for (const s of items) {
    const btn = document.createElement('button'); btn.className = 'recent-item';
    const n = document.createElement('strong'); n.textContent = s.name;
    const c = document.createElement('small'); c.textContent = s.code;
    btn.append(n, c); btn.addEventListener('click', () => selectStock(s)); $('recentItems').append(btn);
  }
}

function createLink(label, url) {
  const a = document.createElement('a'); a.href = url; a.textContent = label;
  a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
}
function renderReportRows(rows) {
  const list = $('reportRows'); list.replaceChildren();
  for (const r of rows) {
    const row = document.createElement('div'); row.className = 'report-row';
    const year = document.createElement('div'); year.className = 'year'; year.textContent = r.year;
    const info = document.createElement('div'); const actions = document.createElement('div'); actions.className = 'links';
    if (r.available) {
      const title = document.createElement('div'); title.className = 'report-title'; title.textContent = r.primary.title;
      const meta = document.createElement('div'); meta.className = 'report-meta';
      meta.textContent = `披露：${r.primary.announcedOn || '未知'}${r.primary.revised ? ' · 已修订' : ''}`;
      info.append(title, meta);
      actions.append(createLink('PDF 原文 ↗', r.primary.pdfUrl));
      if (r.editions.length > 1) {
        const details = document.createElement('details'); details.className = 'alternate';
        const summary = document.createElement('summary'); summary.textContent = `其他版本 (${r.editions.length - 1})`;
        details.append(summary);
        for (const e of r.editions.slice(1)) details.append(createLink(`${e.title} · ${e.announcedOn || ''} ↗`, e.pdfUrl));
        info.append(details);
      }
    } else {
      const message = document.createElement('div'); message.className = 'state'; message.textContent = '暂无年报'; info.append(message);
    }
    row.append(year, info, actions); list.append(row);
  }
}

async function selectStock(s, refresh = false) {
  if (!/^\d{6}$/.test(s.code)) return;
  selectedStock = s;
  input.value = `${s.name}  ${s.code}`;
  hideMatches();
  $('resultSection').hidden = false;
  $('companyName').textContent = s.name;
  $('companyMeta').textContent = s.code;
  $('reportsNote').className = 'reports-note';
  $('reportsNote').textContent = '正在查询…';
  $('reportRows').replaceChildren();
  saveRecent(s);
  const url = new URL(location.href); url.searchParams.set('code', s.code); history.replaceState(null, '', url.pathname + url.search);
  const thisCode = s.code;
  try {
    const resp = await fetch(`/api/reports?code=${encodeURIComponent(s.code)}${refresh ? '&refresh=1' : ''}`);
    const result = await resp.json();
    if (!resp.ok) throw Error(result.error || `HTTP ${resp.status}`);
    if (selectedStock?.code !== thisCode) return;
    $('companyName').textContent = result.stock.name !== s.code ? result.stock.name : s.name;
    $('reportsNote').className = `reports-note${result.stale ? ' warning' : ''}`;
    $('reportsNote').textContent = result.stale ? result.warning : '';
    renderReportRows(result.reports);
  } catch (e) {
    if (selectedStock?.code !== thisCode) return;
    $('reportsNote').className = 'reports-note warning';
    $('reportsNote').textContent = `查询失败：${e.message}`;
  }
}
$('refreshBtn').addEventListener('click', () => selectedStock && selectStock(selectedStock, true));

(async () => {
  renderRecents();
  try {
    const r = await fetch('/stocks.json'); const data = await r.json();
    if (!r.ok || !Array.isArray(data)) throw Error('股票索引异常');
    stocks = data;
    status.textContent = '';
  } catch (e) {
    status.textContent = `股票列表加载失败（${e.message}），请刷新页面。`;
  }
  const q = new URLSearchParams(location.search).get('code');
  if (q && /^\d{6}$/.test(q)) selectStock(stocks.find(s => s.code === q) || { code: q, name: q });
})();
