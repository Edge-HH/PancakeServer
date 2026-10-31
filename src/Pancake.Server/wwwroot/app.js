'use strict';
/* Pancake 集控网页控制台：无框架、无构建步骤，基于 hash 路由。 */

// ============================================================ 工具
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = s => new Raw(s);
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const show = v => v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(show).join('') : esc(v);
/** 模板字符串默认转义插值；嵌套的 html`` 结果原样拼接。 */
function html(strings, ...vals) { let o = strings[0]; vals.forEach((v, i) => { o += show(v) + strings[i + 1]; }); return raw(o); }
const icon = (name, cls = '') => raw(`<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`);
const logo = (cls = 'brand-mark') => raw(`<svg class="${cls}" viewBox="0 0 40 40" aria-hidden="true"><use href="#logo"/></svg>`);
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const pad = n => String(n).padStart(2, '0');

const store = {
  get(k, d) { try { const v = localStorage.getItem('pancake.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pancake.' + k, JSON.stringify(v)); } catch { } },
  del(k) { try { localStorage.removeItem('pancake.' + k); } catch { } }
};

// ---------- 时间
function parseTime(s) {
  if (!s) return null;
  if (typeof s === 'string' && !/[zZ]$|[+-]\d\d:\d\d$/.test(s)) s += 'Z';
  const d = new Date(s); return isNaN(d) ? null : d;
}
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const todayStr = () => ymd(new Date());
const shiftDay = (s, n) => { const [y, m, d] = s.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };
function fullTime(s) { const d = parseTime(s); return d ? `${ymd(d)} ${hm(d)}` : '—'; }
function relTime(s) {
  const d = parseTime(s); if (!d) return '从未';
  const sec = (Date.now() - d) / 1000;
  if (sec < 45) return '刚刚';
  if (sec < 3600) return Math.round(sec / 60) + ' 分钟前';
  if (ymd(d) === todayStr()) return '今天 ' + hm(d);
  if (ymd(d) === shiftDay(todayStr(), -1)) return '昨天 ' + hm(d);
  if (sec < 7 * 86400) return Math.floor(sec / 86400) + ' 天前';
  return ymd(d);
}
const WEEK = '日一二三四五六';
function dateLabel(s, long = false) {
  if (!s) return '未设置日期';
  const t = todayStr();
  const [y, m, d] = s.split('-').map(Number);
  const w = '周' + WEEK[new Date(y, m - 1, d).getDay()];
  const rel = s === t ? '今天' : s === shiftDay(t, -1) ? '昨天' : s === shiftDay(t, 1) ? '明天' : '';
  const base = `${y === new Date().getFullYear() ? '' : y + '年'}${m}月${d}日`;
  return long ? `${base} ${w}${rel ? `（${rel}）` : ''}` : rel ? `${rel} ${m}月${d}日` : `${base} ${w}`;
}
const roleLabel = r => r === 'Administrator' ? '管理员' : r === 'Teacher' ? '老师' : r;
function avatar(name, cls = '') {
  let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return html`<span class="avatar ${cls}" style="background:hsl(${h} 45% 47%)">${String(name || '?').trim().charAt(0).toUpperCase()}</span>`;
}
async function copyText(text, label = '已复制') {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
  }
  toast(label);
}

// ============================================================ 接口
/** body 是服务端返回的 JSON（例如 423 附带的编辑占用），没有时为 null。 */
class ApiError extends Error { constructor(status, message, body = null) { super(message); this.status = status; this.body = body; } }
const STATUS_TEXT = { 400: '请求无效', 401: '需要登录', 403: '没有权限执行此操作', 404: '内容不存在或已删除', 409: '数据冲突，请刷新后重试', 423: '这个项目正在别处编辑', 429: '操作过于频繁，请稍后再试', 500: '服务器内部错误' };
const state = { token: store.get('token', ''), me: null };

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && state.token) headers.authorization = 'Bearer ' + state.token;
  let r;
  try { r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new ApiError(0, '无法连接服务器，请检查网络'); }
  if (r.status === 401 && auth && state.token && !path.startsWith('/api/auth/login')) {
    clearSession(); navigate('login?expired=1'); throw new ApiError(401, '登录已过期，请重新登录');
  }
  if (!r.ok) {
    let msg = '', body = null;
    try { const t = await r.text(); try { body = JSON.parse(t); msg = typeof body === 'string' ? body : (body.detail || body.error || ''); } catch { msg = t.length < 200 ? t : ''; } } catch { }
    throw new ApiError(r.status, msg || STATUS_TEXT[r.status] || `请求失败（${r.status}）`, body);
  }
  if (r.status === 204) return null;
  return (r.headers.get('content-type') || '').includes('json') ? r.json() : r.text();
}

async function download(path) {
  const r = await fetch(path, { headers: state.token ? { authorization: 'Bearer ' + state.token } : {} });
  if (!r.ok) throw new ApiError(r.status, STATUS_TEXT[r.status] || '下载失败');
  const cd = r.headers.get('content-disposition') || '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
  const name = m ? decodeURIComponent(m[1]) : 'download';
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function clearSession() { state.token = ''; state.me = null; state.classes = null; state.groups = null; myAssignments = null; store.del('token'); }
/** 可管理的班级与班级分组（侧栏班级切换器用），新建、改名、调整分组后置空重新拉取。 */
async function classList() {
  if (!state.classes) [state.classes, state.groups] = await Promise.all([api('/api/classes').catch(() => []), api('/api/class-groups').catch(() => [])]);
  return state.classes;
}
/** 按分组顺序整理班级：[{ group, classes }]，group 为空的一节是未分组的班级。keepEmpty 时保留没有班级的分组。 */
function groupClasses(classes, keepEmpty = false) {
  const groups = state.groups || [];
  const sections = groups.map(g => ({ group: g, classes: classes.filter(c => c.groupId === g.id) })).filter(s => keepEmpty || s.classes.length);
  const rest = classes.filter(c => !c.groupId || !groups.some(g => g.id === c.groupId));
  if (rest.length) sections.push({ group: null, classes: rest });
  return sections;
}
/** 当前班级：上次打开的，否则最近有更新的。 */
function lastClassId() {
  const list = state.classes || [], last = store.get('lastClass');
  if (list.some(c => c.id === last)) return last;
  return [...list].sort((a, b) => (parseTime(b.lastUpdatedAt) || 0) - (parseTime(a.lastUpdatedAt) || 0))[0]?.id || null;
}
function toClass(classId, rest) {
  const id = classId || lastClassId();
  if (!id) return navigate('classes');
  history.replaceState(null, '', `#/classes/${id}/${rest}`); currentHash = location.hash; route();
}
const isAdmin = () => state.me?.role === 'Administrator';
async function ensureMe() {
  if (!state.token) return false;
  if (state.me) return true;
  try { state.me = await api('/api/auth/me'); return true; } catch { clearSession(); return false; }
}

/** 断线自动重连的 WebSocket；返回关闭函数。 */
function liveSocket(path, onEvent, onStatus = () => { }) {
  let ws, closed = false, delay = 1000, timer;
  const open = () => {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + path);
    ws.onopen = () => { delay = 1000; onStatus(true); };
    ws.onmessage = e => { try { onEvent(JSON.parse(e.data)); } catch { } };
    ws.onclose = () => { onStatus(false); if (!closed) timer = setTimeout(open, delay = Math.min(delay * 2, 30000)); };
  };
  open();
  return () => { closed = true; clearTimeout(timer); ws && ws.close(); };
}

// ============================================================ 界面组件
/** 提示条；opts.action 给出按钮文字（如“撤销”），点击后调用 opts.onAction 并关闭。 */
function toast(message, type = 'ok', opts = {}) {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = show(html`${icon(type === 'error' ? 'alert' : 'check')}<span class="grow">${message}</span>${opts.action ? html`<button type="button" class="toast-act">${opts.action}</button>` : ''}`);
  $('#toasts').appendChild(el);
  const hide = () => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); };
  if (opts.action) $('.toast-act', el).onclick = () => { el.remove(); Promise.resolve(opts.onAction?.()).catch(fail); };
  setTimeout(hide, opts.action ? 7000 : type === 'error' ? 4500 : 2600);
}

/** 下拉菜单：items = [{ label, icon, run, danger, checked }]，null 为分隔线。点外面或按 Esc 关闭。 */
function openMenu(anchor, items) {
  const el = popover(anchor, items.map((it, i) => it ? html`<button type="button" role="menuitem" class="${it.danger ? 'danger' : ''}" data-i="${i}">${it.checked != null ? icon('check', 'sm' + (it.checked ? '' : ' off')) : it.icon ? icon(it.icon, 'sm') : ''}<span>${it.label}</span></button>` : html`<hr>`));
  el.setAttribute('role', 'menu');
  el.onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; closeMenu(); Promise.resolve(items[+b.dataset.i].run()).catch(fail); };
  return el;
}
/** 贴着 anchor 弹出的浮层（菜单、项目选择器共用），同一时间只有一个。 */
function popover(anchor, content, cls = '', align = 'right') {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu ' + cls;
  el.innerHTML = show(content);
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.top = Math.max(8, Math.min(innerHeight - el.offsetHeight - 8, r.bottom + 6)) + 'px';
  el.style.left = Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, align === 'left' ? r.left : r.right - el.offsetWidth)) + 'px';
  setTimeout(() => {
    const away = e => { if (!el.contains(e.target)) closeMenu(); };
    const esc = e => { if (e.key === 'Escape') closeMenu(); };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc);
    el._off = () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  });
  return el;
}
function closeMenu() { const m = $('.menu'); if (m) { m._off?.(); m.remove(); } }

// ---------- 离开保护：有未保存修改的页面注册 guard，返回提示文字表示需要确认。
let leaveGuard = null;
const setLeaveGuard = fn => { leaveGuard = fn; };
window.addEventListener('beforeunload', e => { if (leaveGuard?.()) { e.preventDefault(); e.returnValue = ''; } });
/** 页面内切换（pushState）时同步记下当前地址，离开保护据此判断是否真的换了页面。 */
let currentHash = null;
function setHash(path, replace = false) { history[replace ? 'replaceState' : 'pushState'](null, '', '#/' + path); currentHash = location.hash; }
const fail = err => toast(err?.message || String(err), 'error');

/**
 * 表单对话框。onSubmit 抛出的错误显示在对话框里，返回值作为 Promise 结果。
 * 返回 false 时保持打开。
 */
function modal({ title, body, submit = '确定', cancel = '取消', danger = false, wide = false, onSubmit, onMount }) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal' + (wide ? ' wide' : '');
    dlg.innerHTML = show(html`<form novalidate>
      <div class="modal-head"><h3>${title}</h3><span class="spacer"></span><button type="button" class="btn ghost sm icon-only" data-close aria-label="关闭">${icon('x')}</button></div>
      <div class="modal-body">${body}<div class="form-error" role="alert"></div></div>
      <div class="modal-foot">${cancel ? html`<button type="button" class="btn" data-close>${cancel}</button>` : ''}${submit ? html`<button type="submit" class="btn ${danger ? 'danger solid' : 'primary'}">${submit}</button>` : ''}</div>
    </form>`);
    document.body.appendChild(dlg);
    const form = $('form', dlg), err = $('.form-error', dlg);
    let result;
    const close = () => dlg.close();
    $$('[data-close]', dlg).forEach(b => b.onclick = close);
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    form.onsubmit = async e => {
      e.preventDefault(); err.textContent = '';
      const btn = $('button[type=submit]', dlg); if (btn) btn.disabled = true;
      try {
        const r = onSubmit ? await onSubmit(form, dlg) : true;
        if (r !== false) { result = r === undefined ? true : r; close(); }
      } catch (ex) { err.textContent = ex.message; }
      finally { if (btn) btn.disabled = false; }
    };
    dlg.showModal();
    onMount?.(form, dlg, close);
    const first = $('input:not([type=checkbox]):not([readonly]),select,textarea', form); if (first) first.focus();
  });
}
const confirmDialog = ({ title, message, confirm = '确定', danger = true }) =>
  modal({ title, body: html`<p class="muted">${message}</p>`, submit: confirm, danger });

// ---------- 全局点击委托：data-act="名称"
let viewActions = {};
const globalActions = {
  'logout': async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch { } clearSession(); navigate(''); toast('已退出登录'); },
  'change-password': () => changePassword(),
  'toggle-nav': () => $('.shell')?.classList.toggle('nav-open'),
  'copy': el => copyText(el.dataset.text, el.dataset.label || '已复制'),
  'print': () => print()
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) { if (e.target.closest('.shell.nav-open') && !e.target.closest('.sidebar')) $('.shell').classList.remove('nav-open'); return; }
  const fn = viewActions[el.dataset.act] || globalActions[el.dataset.act];
  if (fn) { e.preventDefault(); Promise.resolve(fn(el, e)).catch(fail); }
});

// ============================================================ 路由
let disposers = [];
const onDispose = fn => disposers.push(fn);
const navigate = path => { const h = '#/' + path; if (location.hash === h) route(); else location.hash = h; };
const routes = [
  [/^$/, viewLanding, { public: true }],
  [/^login$/, viewLogin, { public: true }],
  [/^c\/([^/]+)(?:\/([\w-]+))?$/, viewPublic, { public: true }],
  [/^classes$/, viewClasses],
  [/^classes\/([\w-]+)(?:\/(\w+))?(?:\/([\w-]+))?$/, viewClass],
  [/^exam$/, viewExam],
  [/^exam\/([\w-]+)$/, viewExamPlan],
  [/^homework(?:\/([\w-]+))?(?:\/([\w-]+))?$/, (c, p) => toClass(c, p ? 'homework/' + p : 'homework')]
];
let routeToken = 0;
async function route() {
  if (leaveGuard && currentHash != null && location.hash !== currentHash) {
    const msg = leaveGuard(), target = location.hash;
    if (msg) {
      history.replaceState(null, '', currentHash);
      if (!await confirmDialog({ title: '放弃未保存的修改', message: msg, confirm: '放弃并离开' })) return;
      history.replaceState(null, '', target);
    }
  }
  leaveGuard = null; currentHash = location.hash;
  const token = ++routeToken;
  document.body.classList.add('routing');
  disposers.forEach(fn => { try { fn(); } catch { } }); disposers = []; viewActions = {};
  $('.drawer')?.remove(); $('.scrim')?.remove(); closeMenu();
  const [path, qs] = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('?');
  const query = new URLSearchParams(qs || '');
  for (const [re, fn, opt = {}] of routes) {
    const m = path.match(re); if (!m) continue;
    if (!opt.public && !await ensureMe()) return navigate('login?next=' + encodeURIComponent(path));
    if (!opt.public) await classList();
    if (token !== routeToken) return;
    try { await fn(...m.slice(1), query); } catch (err) { if (err.status !== 401) renderError(err); }
    finally { if (token === routeToken) document.body.classList.remove('routing'); }
    return;
  }
  navigate(state.token ? 'classes' : '');
}
window.addEventListener('hashchange', route);
window.addEventListener('scroll', () => $('.topbar')?.classList.toggle('scrolled', scrollY > 4), { passive: true });

function renderError(err) {
  const target = $('#page') || $('#app');
  target.innerHTML = show(html`<div class="empty">${icon('alert')}<b>出错了</b><span>${err.message}</span><button class="btn" style="margin-top:10px" onclick="location.reload()">${icon('refresh')}重新加载</button></div>`);
}

// ============================================================ 应用框架
function shell({ nav, title, crumbs, actions = '', classId = null }) {
  const me = state.me, classes = state.classes || [];
  const cid = classId || lastClassId();
  const sections = groupClasses(classes), option = c => html`<option value="${c.id}" ${c.id === cid ? 'selected' : ''}>${c.name}</option>`;
  $('#app').innerHTML = show(html`<div class="shell">
    <aside class="sidebar">
      <a class="brand" href="#/classes">${logo()}<b>Pancake 作业</b></a>
      <nav class="nav">
        ${cid ? html`<label class="class-switch" title="切换班级">${icon('class', 'sm')}<select id="class-switch" aria-label="当前班级">${sections.length === 1 && !sections[0].group
            ? sections[0].classes.map(option)
            : sections.map(s => html`<optgroup label="${s.group ? s.group.name : '未分组'}">${s.classes.map(option)}</optgroup>`)}</select></label>
          <a href="#/classes/${cid}/homework" class="${nav === 'homework' ? 'active' : ''}">${icon('book')}<span>作业</span></a>` : ''}
        <a href="#/classes" class="${nav === 'classes' ? 'active' : ''}">${icon('class')}<span>${isAdmin() ? '全部班级' : '我的班级'}</span></a>
        <a href="#/exam" class="${nav === 'exam' ? 'active' : ''}">${icon('calendar')}<span>考试</span></a>
      </nav>
      <div class="sidebar-foot">
        <div class="user-card">${avatar(me.displayName)}<div class="grow"><b>${me.displayName}</b><span>${roleLabel(me.role)}，${me.userName}</span></div></div>
        <div class="row">
          <button class="btn ghost sm grow" data-act="change-password">${icon('key')}<span>修改密码</span></button>
          <button class="btn ghost sm grow" data-act="logout">${icon('logout')}<span>退出</span></button>
        </div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="btn ghost icon-only menu-toggle" data-act="toggle-nav" aria-label="菜单">${icon('menu')}</button>
        <div class="grow">${crumbs ? html`<div class="crumbs">${crumbs}</div>` : ''}<h1>${title}</h1></div>
        <div class="row wrap">${actions}</div>
      </header>
      <main class="page" id="page"></main>
    </div>
  </div>`);
  const sw = $('#class-switch');
  if (sw) sw.onchange = () => navigate(`classes/${sw.value}/homework`);
  return $('#page');
}
const setPage = (el, content) => { el.innerHTML = show(content); };
const loading = () => html`<div class="loading" role="status">正在加载…</div>`;
let myAssignments = null;
async function assignments() { if (!myAssignments) myAssignments = await api('/api/me/assignments').catch(() => []); return myAssignments; }
/** 网页编辑作业时允许改动的科目（小写）；null 表示不限。 */
async function editableSubjects(classId) {
  if (isAdmin()) return null;
  const a = (await assignments()).find(x => x.classId === classId);
  if (!a || a.duty === 'HeadTeacher' || !a.subjects.length) return null;
  const set = new Set(a.subjects.map(x => x.trim().toLowerCase()));
  set.names = a.subjects;
  return set;
}
const consoleAsset = classId => sha => `/api/classes/${classId}/assets/${sha}?access_token=${encodeURIComponent(state.token)}`;

const empty = (ic, title, text, action = '') => html`<div class="empty">${icon(ic)}<b>${title}</b><span>${text}</span>${action ? html`<div style="margin-top:12px">${action}</div>` : ''}</div>`;

// ============================================================ 作业内容解析
const PLACEHOLDER = '在这里输入作业内容';
const pick = (o, k) => o == null ? undefined : o[k] ?? o[k[0].toLowerCase() + k.slice(1)];
function safeColor(hex) {
  if (typeof hex !== 'string') return null;
  const m = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  return '#' + (m[1].length === 8 ? m[1].slice(2) : m[1]);
}
/**
 * 桌面端的项目 JSON 为 PascalCase；保留原始序号，网页编辑时据此告诉服务端改的是哪一项。
 * runs 是服务端按科目、条目解析好的富文本片段（旧服务端没有时按纯文本处理）。
 */
function parseProject(payloadJson, runs) {
  let doc = {}; try { doc = JSON.parse(payloadJson || '{}'); } catch { }
  return (pick(doc, 'Subjects') || []).map((s, si) => ({
    index: si,
    name: (pick(s, 'Name') || '').trim() || '未命名科目',
    color: safeColor(pick(s, 'AccentHex')),
    explicit: !!pick(s, 'IsAccentExplicit'),
    ink: (pick(s, 'InkStrokes') || []).length > 0,
    rect: { x: +pick(s, 'X') || 0, y: +pick(s, 'Y') || 0, w: +pick(s, 'Width') || 0, h: +pick(s, 'Height') || 0 },
    entries: (pick(s, 'Entries') || []).map((e, ei) => {
      let text = String(pick(e, 'Content') || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
      if (text.trim() === PLACEHOLDER) text = '';
      const rich = runs?.[si]?.[ei] ? rtFromApi(runs[si][ei]) : text ? [rtRun(text)] : [];
      return { index: ei, text, runs: rich, hand: !!pick(e, 'HasHandwriting'), atts: (pick(e, 'Attachments') || []).map((a, ai) => ({ index: ai, name: pick(a, 'Name') || '附件', kind: pick(a, 'Kind') || '文件', path: pick(a, 'Path') || '' })) };
    })
  }));
}
/** 项目自己保存的配色（主题与色系）；旧项目没有保存时为 null。 */
function projectScheme(payloadJson) {
  let doc = {}; try { doc = JSON.parse(payloadJson || '{}') || {}; } catch { }
  return { theme: ['Dark', 'Light', 'Default'].includes(doc.Theme) ? doc.Theme : null, palette: ['Vivid', 'Macaron'].includes(doc.Palette) ? doc.Palette : null };
}
/** 展示用：只保留有内容的作业条目，科目颜色按项目色系显示（与大屏一致）。 */
function subjectsOf(payloadJson, runs) {
  const macaron = projectScheme(payloadJson).palette === 'Macaron';
  return parseProject(payloadJson, runs).map(s => ({ ...s, color: s.color && Board.accent(s.color, s.explicit, macaron), entries: s.entries.filter(e => e.text || e.hand || e.atts.length) }));
}
const ASSET_RE = /^asset:([0-9a-f]{64})(\.[a-z0-9]{1,10})?$/i;
const IMAGE_EXT = /^\.(png|jpe?g|gif|webp|bmp)$/i;
function assetImage(a, assetUrl) {
  const m = ASSET_RE.exec(a.path || '');
  return m && assetUrl && (IMAGE_EXT.test(m[2] || '') || /图/.test(a.kind)) ? assetUrl(m[1].toLowerCase()) : null;
}
function attachmentView(a, assetUrl) {
  const src = assetImage(a, assetUrl);
  if (src) return html`<a class="att-img" href="${src}" target="_blank" rel="noopener" title="${a.name}"><img src="${src}" alt="${a.name}" loading="lazy"></a>`;
  return html`<span class="attachment" title="${a.kind}">${icon(/图|image/i.test(a.kind) ? 'image' : 'clip', 'sm')}${a.name}</span>`;
}
function homeworkText(project, subjects) {
  const lines = [`${project.name}${project.date ? '（' + dateLabel(project.date, true) + '）' : ''}`, ''];
  subjects.filter(s => s.entries.length).forEach(s => {
    lines.push(`【${s.name}】`);
    s.entries.forEach((e, i) => lines.push(`${s.entries.length > 1 ? (i + 1) + '. ' : ''}${e.text || '（手写内容）'}`));
    lines.push('');
  });
  return lines.join('\n').trim();
}
function renderSubjects(subjects, assetUrl) {
  if (!subjects.length) return empty('book', '这个项目还没有科目', '在班级大屏或网页上添加科目和作业后，会自动同步。');
  const filled = subjects.filter(s => s.entries.length), blank = subjects.filter(s => !s.entries.length);
  if (!filled.length) return empty('book', '暂无作业内容', '所有科目都还是空的。');
  return html`<div class="subjects">${filled.map(s => html`
    <section class="subject" style="${s.color ? '--subject:' + s.color : ''}">
      <div class="subject-head"><span class="swatch"></span><h3>${s.name}</h3><span class="count">${s.entries.length} 项</span></div>
      <ol class="entries">${s.entries.map((e, i) => html`
        <li class="entry"><span class="num">${i + 1}</span><div>
          ${e.text ? html`<div class="text rich-view">${raw(rtHtml(e.runs.length ? e.runs : [rtRun(e.text)]))}</div>` : html`<div class="text empty-text">${e.atts.length ? '图片作业' : '手写作业，请在班级大屏查看'}</div>`}
          ${e.atts.length || (e.hand && e.text) ? html`<div class="attachments">
            ${e.hand && e.text ? html`<span class="attachment">${icon('pen', 'sm')}含手写</span>` : ''}
            ${e.atts.map(a => attachmentView(a, assetUrl))}
          </div>` : ''}
        </div></li>`)}
      </ol>
    </section>`)}</div>
    ${blank.length ? html`<p class="faint" style="padding:0 22px 20px;font-size:12.5px">未布置：${blank.map(s => s.name).join('、')}</p>` : ''}`;
}

// ============================================================ 富文本（与大屏磁贴的格式一致）
/**
 * 作业富文本以片段数组表示：{ text, bold, italic, underline, fontFamily, fontSize, color, highlight }。
 * 服务端负责与大屏保存的 RTF 互转；这里只在 contenteditable 与片段之间转换。
 * 片段的格式记在 span 的 data-* 上，样式只是它的显示，避免浏览器计算样式带来的误差。
 */
const RT_KEYS = ['bold', 'italic', 'underline', 'fontFamily', 'fontSize', 'color', 'highlight'];
const rtRun = (text, f = {}) => ({ text, bold: !!f.bold, italic: !!f.italic, underline: !!f.underline, fontFamily: f.fontFamily || null, fontSize: f.fontSize || null, color: f.color || null, highlight: f.highlight || null });
const rtSame = (a, b) => RT_KEYS.every(k => typeof a[k] === 'boolean' || typeof b[k] === 'boolean' ? !!a[k] === !!b[k] : (a[k] || null) === (b[k] || null));
function rtNormalize(runs) {
  const out = [];
  for (const r of runs || []) {
    if (!r || !r.text) continue;
    const run = rtRun(r.text, r);
    if (out.length && rtSame(out[out.length - 1], run)) out[out.length - 1].text += run.text; else out.push(run);
  }
  return out;
}
const rtPlain = runs => (runs || []).map(r => r.text).join('');
/** 服务端返回的片段（camelCase）转成本地格式。 */
const rtFromApi = runs => rtNormalize((runs || []).map(r => rtRun(pick(r, 'Text') || '', { bold: pick(r, 'Bold'), italic: pick(r, 'Italic'), underline: pick(r, 'Underline'), fontFamily: pick(r, 'FontFamily'), fontSize: pick(r, 'FontSize'), color: pick(r, 'Color'), highlight: pick(r, 'Highlight') })));
function rtStyle(r) {
  const s = [];
  if (r.bold) s.push('font-weight:700');
  if (r.italic) s.push('font-style:italic');
  if (r.underline) s.push('text-decoration:underline');
  if (r.fontFamily) s.push(`font-family:${JSON.stringify(r.fontFamily).replace(/"/g, "'")},sans-serif`);
  if (r.fontSize) s.push(`font-size:${Math.max(8, Math.min(96, r.fontSize * .8)).toFixed(1)}px`);
  if (r.color) s.push(`color:${r.color}`);
  if (r.highlight) s.push(`background:${r.highlight};color:${r.color || '#111'}`);
  return s.join(';');
}
/** 片段转 HTML：只读显示与编辑器共用。 */
function rtHtml(runs, editable = false) {
  const list = rtNormalize(runs);
  let out = list.map(r => {
    const attrs = RT_KEYS.filter(k => r[k]).map(k => ` data-${k.toLowerCase()}="${esc(r[k] === true ? '1' : r[k])}"`).join('');
    const body = esc(r.text).replace(/\n/g, '<br>');
    return `<span${attrs} style="${esc(rtStyle(r))}">${body}</span>`;
  }).join('');
  // 末尾换行需要多一个 <br> 才能在可编辑区域显示出空行。
  if (editable && rtPlain(list).endsWith('\n')) out += '<br data-tail="1">';
  return out;
}
/** 从 DOM 读出片段：格式取自最近的带 data-* 的 span，<br> 和块级元素换行。 */
function rtExtract(root) {
  const runs = [];
  const fmtOf = el => {
    const f = {};
    for (let n = el; n && n !== root && n.nodeType === 1; n = n.parentNode)
      for (const k of RT_KEYS) {
        const v = n.dataset?.[k.toLowerCase()];
        if (v != null && f[k] === undefined) f[k] = k === 'fontSize' ? +v : ['bold', 'italic', 'underline'].includes(k) ? true : v;
      }
    return f;
  };
  const push = (text, el) => { if (text) runs.push(rtRun(text, fmtOf(el))); };
  const walk = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) push(child.nodeValue.replace(/​/g, ''), child.parentNode);
      else if (child.nodeType === 1) {
        if (child.tagName === 'BR') { if (!child.dataset.tail) push('\n', child.parentNode); continue; }
        const block = /^(DIV|P)$/.test(child.tagName);
        if (block && rtPlain(runs).length && !rtPlain(runs).endsWith('\n')) push('\n', child.parentNode);
        walk(child);
      }
    }
  };
  walk(root);
  return rtNormalize(runs);
}
/** 选区在纯文本中的位置：截取到该点的内容按同样规则读出长度。 */
function rtOffset(root, node, offset) {
  const range = document.createRange();
  range.setStart(root, 0); range.setEnd(node, offset);
  const box = document.createElement('div'); box.appendChild(range.cloneContents());
  return rtPlain(rtExtract(box)).length;
}
function rtSelection(root) {
  const sel = getSelection();
  if (!sel.rangeCount || !root.contains(sel.anchorNode)) return null;
  const r = sel.getRangeAt(0);
  return { start: rtOffset(root, r.startContainer, r.startOffset), end: rtOffset(root, r.endContainer, r.endOffset) };
}
function rtSetSelection(root, start, end) {
  const find = target => {
    let left = target;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let last = null;
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.nodeType === 3) { if (left <= n.nodeValue.length) return [n, left]; left -= n.nodeValue.length; last = n; }
      else if (n.tagName === 'BR' && !n.dataset.tail) {
        if (left === 0) return [n.parentNode, [...n.parentNode.childNodes].indexOf(n)];
        left -= 1;
        if (left === 0) return [n.parentNode, [...n.parentNode.childNodes].indexOf(n) + 1];
      }
    }
    return last ? [last, last.nodeValue.length] : [root, root.childNodes.length];
  };
  const [sn, so] = find(start), [en, eo] = find(end);
  const range = document.createRange(); range.setStart(sn, so); range.setEnd(en, eo);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
}
/** 把 [start, end) 的片段改成 patch(run) 返回的格式。 */
function rtApply(runs, start, end, patch) {
  const out = []; let pos = 0;
  for (const r of rtNormalize(runs)) {
    const a = pos, b = pos + r.text.length; pos = b;
    if (b <= start || a >= end) { out.push(r); continue; }
    const s = Math.max(start, a) - a, e = Math.min(end, b) - a;
    if (s > 0) out.push(rtRun(r.text.slice(0, s), r));
    out.push(rtRun(r.text.slice(s, e), { ...r, ...patch(r) }));
    if (e < r.text.length) out.push(rtRun(r.text.slice(e), r));
  }
  return rtNormalize(out);
}
const rtSlice = (runs, start, end) => { let pos = 0; return rtNormalize(runs).filter(r => { const a = pos; pos += r.text.length; return pos > start && a < end; }); };

/**
 * 富文本工具栏：字体、字号、粗体、斜体、下划线、文字颜色与高光。色卡按项目色系显示，与大屏一致，
 * 点选后写入看到的那个颜色。作用范围见 bindRichEditors。
 */
function richToolbar(fonts, defaults, macaron = false) {
  const fontOptions = [...new Set([defaults.fontFamily, ...fonts].filter(Boolean))];
  const sw = Board.swatches(macaron);
  return html`<div class="rt-toolbar" role="toolbar" aria-label="文字格式">
    <select class="input sm" data-rt="font" title="字体">${fontOptions.map(f => html`<option value="${f}">${f}</option>`)}</select>
    <input class="input sm rt-size" type="number" min="8" max="144" step="1" value="${defaults.fontSize}" data-rt="size" title="字号">
    <button type="button" class="btn ghost sm icon-only rt-b" data-rt="bold" title="加粗"><b>B</b></button>
    <button type="button" class="btn ghost sm icon-only" data-rt="italic" title="斜体"><i style="font-family:serif">I</i></button>
    <button type="button" class="btn ghost sm icon-only" data-rt="underline" title="下划线"><u>U</u></button>
    <span class="rt-sep"></span>
    <span class="rt-swatches" title="文字颜色"><button type="button" class="rt-swatch rt-default" data-rt="color" data-v="" title="默认文字颜色">A</button>${sw.text.map(c => html`<button type="button" class="rt-swatch" data-rt="color" data-v="${c}" style="background:${c}" title="文字颜色 ${c}"></button>`)}</span>
    <span class="rt-sep"></span>
    <span class="rt-swatches" title="高光"><button type="button" class="rt-swatch rt-clear" data-rt="highlight" data-v="" title="去掉高光"></button>${sw.highlight.map(c => html`<button type="button" class="rt-swatch rt-hl" data-rt="highlight" data-v="${c}" style="background:${c}" title="高光 ${c}"></button>`)}</span>
  </div>`;
}
/**
 * 把工具栏和若干 .rich 编辑框接起来；getRuns/setRuns 读写编辑框对应的数据。
 * 作用范围依次是：选中的文字；光标所在的整条作业；光标在空作业里时先记下格式，作用于接下来输入的文字；
 * 没有点进任何作业时，fallback() 给出的编辑框（画布上是选中磁贴的全部作业）。都没有时提示 hint()。
 * 全部用委托监听挂在 container 上（工具栏和编辑框随时会重绘），再次绑定或 unbindRichEditors 时撤掉旧的监听。
 */
function bindRichEditors(container, { getRuns, setRuns, defaults, fallback = () => [], hint = () => '先点一下要设置格式的作业' }) {
  unbindRichEditors(container);
  const controller = new AbortController(), signal = controller.signal;
  container._rtAbort = controller;
  let active = null, saved = null, pending = null;
  const bar = () => $('.rt-toolbar', container);
  const focused = () => !!active && container.contains(active) && active.isContentEditable;
  const pendingRuns = () => pending?.el === active ? [rtRun('', pending.patch)] : [];
  /** 本次格式作用的编辑框与范围；光标在空作业里时返回 null（记为待用格式）。 */
  const targets = () => {
    if (focused()) {
      if (saved && saved.end > saved.start) return [{ el: active, start: saved.start, end: saved.end }];
      const len = rtPlain(getRuns(active)).length;
      return len ? [{ el: active, start: 0, end: len, whole: true }] : null;
    }
    return fallback().map(el => ({ el, start: 0, end: rtPlain(getRuns(el)).length, whole: true })).filter(t => t.end > 0);
  };
  const selected = scope => scope === null ? pendingRuns() : scope.flatMap(t => rtSlice(getRuns(t.el), t.start, t.end));
  const refreshBar = () => {
    const b = bar(); if (!b) return;
    const scope = targets();
    // 光标没有选中文字时，按光标前一个字的格式显示（与大屏一致）。
    const sel = scope !== null && focused() && saved && saved.end === saved.start
      ? rtSlice(getRuns(active), Math.max(0, saved.start - 1), saved.start) : selected(scope);
    const first = sel[0] || {};
    $('[data-rt=font]', b).value = first.fontFamily || defaults.fontFamily;
    $('[data-rt=size]', b).value = first.fontSize || defaults.fontSize;
    for (const k of ['bold', 'italic', 'underline']) $(`[data-rt=${k}]`, b).classList.toggle('on', sel.length > 0 && sel.every(r => r[k]));
  };
  const apply = patch => {
    const scope = targets();
    if (scope === null) {
      const before = pending?.el === active ? pending.patch : {};
      pending = { el: active, patch: { ...before, ...patch(rtRun('', before)) } };
      active.focus(); refreshBar();
      return;
    }
    if (!scope.length) return toast(hint(), 'error');
    for (const t of scope) {
      const runs = rtApply(getRuns(t.el), t.start, t.end, patch);
      setRuns(t.el, runs);
      t.el.innerHTML = rtHtml(runs, true);
    }
    if (focused()) {
      const t = scope[0];
      active.focus();
      if (t.whole) rtSetSelection(active, saved?.start ?? t.end, saved?.start ?? t.end); else rtSetSelection(active, t.start, t.end);
    }
    refreshBar();
  };
  const toggle = k => {
    const sel = selected(targets());
    const on = !(sel.length && sel.every(x => x[k]));
    apply(() => ({ [k]: on }));
  };
  /** 读回编辑框内容；空作业里第一次输入时套用待用格式。 */
  const commit = el => {
    let runs = rtExtract(el);
    const len = rtPlain(runs).length;
    if (pending?.el === el && len) {
      const patch = pending.patch;
      pending = null;
      runs = rtApply(runs, 0, len, () => patch);
      el.innerHTML = rtHtml(runs, true);
      rtSetSelection(el, len, len);
    }
    setRuns(el, runs);
    // 删光内容后浏览器会留下空的格式元素，清掉以免下一次输入继承旧格式。
    if (!el.textContent) el.innerHTML = '';
  };
  document.addEventListener('selectionchange', () => {
    const el = getSelection().anchorNode?.parentElement?.closest?.('.rich') || document.activeElement?.closest?.('.rich');
    if (!el || !container.contains(el) || el.contentEditable !== 'true') return;
    if (el !== active) pending = null;
    active = el; saved = rtSelection(el) || saved; refreshBar();
  }, { signal });
  // 点到作业以外的输入框（例如科目名称）后，格式回到作用于整个磁贴；工具栏里的字体、字号框除外。
  container.addEventListener('focusin', e => {
    if (e.target.closest('.rich, .rt-toolbar')) return;
    active = saved = pending = null; refreshBar();
  }, { signal });
  container.addEventListener('input', e => {
    const el = e.target.closest?.('.rich'); if (!el) return;
    // 输入法组字时不能改动编辑框，组字结束后再套用待用格式。
    if (e.isComposing) { setRuns(el, rtExtract(el)); return; }
    commit(el);
  }, { signal });
  container.addEventListener('compositionend', e => { const el = e.target.closest?.('.rich'); if (el) commit(el); }, { signal });
  container.addEventListener('paste', e => {
    const el = e.target.closest?.('.rich'); if (!el) return;
    e.preventDefault();
    document.execCommand('insertText', false, (e.clipboardData?.getData('text/plain') || '').replace(/\r\n?/g, '\n'));
  }, { signal });
  container.addEventListener('keydown', e => {
    const el = e.target.closest?.('.rich'); if (!el) return;
    const fmt = (e.ctrlKey || e.metaKey) && !e.altKey && { b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()];
    if (fmt) { e.preventDefault(); active = el; saved = rtSelection(el) || saved; toggle(fmt); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    document.execCommand('insertLineBreak');
  }, { signal });
  // 按下工具栏按钮时保留编辑框的选区。
  container.addEventListener('mousedown', e => { if (e.target.closest('.rt-toolbar button')) e.preventDefault(); }, { signal });
  container.addEventListener('click', e => {
    const b = e.target.closest('.rt-toolbar button[data-rt]'); if (!b) return;
    const k = b.dataset.rt;
    if (k === 'bold' || k === 'italic' || k === 'underline') toggle(k);
    else if (k === 'color') apply(() => ({ color: b.dataset.v || null }));
    else if (k === 'highlight') apply(() => ({ highlight: b.dataset.v || null }));
  }, { signal });
  container.addEventListener('change', e => {
    if (!e.target.closest('.rt-toolbar')) return;
    const k = e.target.dataset.rt;
    if (k === 'font') apply(() => ({ fontFamily: e.target.value === defaults.fontFamily ? null : e.target.value }));
    if (k === 'size') { const v = Math.max(8, Math.min(144, Math.round(+e.target.value || defaults.fontSize))); apply(() => ({ fontSize: v === defaults.fontSize ? null : v })); }
  }, { signal });
  // 编辑框重绘后（例如换了选中的磁贴）由调用方刷新工具栏状态。
  container._rtRefresh = refreshBar;
  onDispose(() => controller.abort());
}
function unbindRichEditors(container) { container._rtAbort?.abort(); container._rtAbort = null; container._rtRefresh = null; }
/** 班级正文默认字体、字号与可选字体：取自班级设置与大屏上报的字体。 */
async function richDefaults(classId) {
  const [layout, fonts] = await Promise.all([
    api(`/api/classes/${classId}/layout`).catch(() => null),
    api(`/api/classes/${classId}/fonts`).catch(() => [])]);
  let doc = {}; try { doc = JSON.parse(layout?.payloadJson || '{}'); } catch { }
  return { fontFamily: doc.TileBodyFontFamily || 'HarmonyOS Sans SC', fontSize: Math.round(+doc.TileBodyFontSize || 20), fonts: fonts || [] };
}

// ============================================================ 作业浏览器（公开页，只读）
/**
 * @param src.list()            -> Promise<Project[]>
 * @param src.detail(id)        -> Promise<ProjectDetail>
 * @param src.link(id)          -> hash 路径
 * @param src.ws                实时通知路径
 */
function mountBrowser(root, src, selectedId) {
  let projects = [], current = null, filter = '';
  const byId = id => projects.find(p => p.id === id);

  root.innerHTML = show(html`<div class="browser">
    <aside class="card browser-side">
      <div class="filters">
        <label class="input-icon">${icon('search', 'sm')}<input class="input" id="pf" placeholder="搜索项目或日期" autocomplete="off"></label>
        <span class="conn" id="live" hidden>${icon('alert', 'sm')}连接中断，作业可能不是最新的</span>
      </div>
      <div class="project-list" id="pl">${loading()}</div>
    </aside>
    <section class="card" id="doc">${loading()}</section>
  </div>`);

  // 连接正常时不打扰，断线才提示。
  const setLive = on => { const b = $('#live', root); if (b) b.hidden = on; };

  function renderList() {
    const q = filter.trim().toLowerCase();
    const items = projects.filter(p => !p.deleted && (!q || p.name.toLowerCase().includes(q) || (p.date || '').includes(q) || dateLabel(p.date).includes(q)));
    const box = $('#pl', root);
    if (!items.length) { box.innerHTML = show(empty('book', projects.length ? '没有匹配的项目' : '暂无项目', projects.length ? '换个关键词试试。' : '设备同步后项目会出现在这里。')); return; }
    box.innerHTML = show(projectGroups(items, p => html`<a class="project-item ${current?.id === p.id ? 'active' : ''}" href="#/${src.link(p.id)}">
        <span class="name">${p.name}</span><span class="meta">${relTime(p.updatedAt)}更新</span></a>`));
  }

  async function renderDoc(id) {
    const doc = $('#doc', root);
    const p = byId(id);
    if (!p) { doc.innerHTML = show(empty('book', '选择一个项目', '从左侧列表选择要查看的作业项目。')); return; }
    current = p; renderList();
    let detail;
    try { detail = await src.detail(id); } catch (err) { doc.innerHTML = show(empty('alert', '加载失败', err.message)); return; }
    if (current?.id !== id) return;
    const subjects = subjectsOf(detail.payloadJson, detail.runs);
    const total = subjects.reduce((n, s) => n + s.entries.length, 0);
    const text = homeworkText({ name: detail.name, date: detail.date }, subjects);
    doc.innerHTML = show(html`
      <div class="doc-head">
        <div class="grow">
          <h2>${detail.name}</h2>
          <div class="meta">
            <span>${dateLabel(detail.date, true)}</span>
            <span>${total} 项作业</span>
            <span title="${fullTime(detail.updatedAt)}">${relTime(detail.updatedAt)}更新</span>
          </div>
        </div>
        <div class="row wrap no-print">
          <button class="btn sm" data-act="copy" data-text="${text}" data-label="作业文本已复制">复制文本</button>
          <button class="btn sm" data-act="print">打印</button>
        </div>
      </div>
      ${renderSubjects(subjects, src.asset)}`);
  }

  async function load(keepSelection = true) {
    projects = await src.list();
    renderList();
    let id = keepSelection && current ? current.id : selectedId;
    if (!byId(id) || byId(id).deleted) {
      id = defaultProject(projects)?.id;
      if (id && !selectedId) setHash(src.link(id), true);
    }
    await renderDoc(id);
  }

  // 切换项目只刷新右侧内容，不重建整个页面和实时连接。
  $('#pl', root).addEventListener('click', e => {
    const a = e.target.closest('a.project-item'); if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    setHash(a.getAttribute('href').slice(2));
    renderDoc(a.getAttribute('href').split('/').pop());
    if (innerWidth <= 860) $('#doc', root).scrollIntoView({ behavior: 'smooth' });
  });
  $('#pf', root).addEventListener('input', e => { filter = e.target.value; renderList(); });

  let refreshTimer;
  onDispose(liveSocket(src.ws, ev => {
    src.onEvent?.(ev);
    if (ev.type && !['updated', 'deleted'].includes(ev.type)) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => load().catch(() => { }), 400);
  }, setLive));
  onDispose(() => clearTimeout(refreshTimer));

  return load(false);
}

/** 按日期分组（新的在前）列出项目，item(p) 画每一项。 */
function projectGroups(items, item) {
  const groups = new Map();
  [...items].sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.name.localeCompare(b.name, 'zh')).forEach(p => {
    const k = p.date || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p);
  });
  return [...groups].map(([date, ps]) => html`<div class="date-group">${icon('calendar', 'sm')}${dateLabel(date)}</div>${ps.map(item)}`);
}
/** 默认打开今天的项目；没有就打开最近一个过去的日期，再没有就打开最近更新的。 */
function defaultProject(projects) {
  const live = projects.filter(p => !p.deleted), t = todayStr();
  return live.find(p => p.date === t)
    || [...live].filter(p => p.date && p.date < t).sort((a, b) => b.date.localeCompare(a.date))[0]
    || [...live].sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt))[0];
}

// ---------- 历史版本抽屉
async function openHistory(classId, project, onRestored, assetUrl) {
  $('.drawer')?.remove(); $('.scrim')?.remove();
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  const drawer = document.createElement('aside'); drawer.className = 'drawer';
  document.body.append(scrim, drawer);
  const esc = e => { if (e.key === 'Escape' && !$('dialog[open]')) close(); };
  const close = () => { drawer.remove(); scrim.remove(); document.removeEventListener('keydown', esc); };
  document.addEventListener('keydown', esc);
  scrim.onclick = close;
  drawer.innerHTML = show(html`<div class="drawer-head">${icon('history')}<h3 class="grow">“${project.name}”的历史版本</h3><button class="btn ghost sm icon-only" id="hx">${icon('x')}</button></div><div class="drawer-body">${loading()}</div>`);
  $('#hx', drawer).onclick = close;
  let items;
  try { items = await api(`/api/classes/${classId}/projects/${project.id}/history`); }
  catch (err) { $('.drawer-body', drawer).innerHTML = show(empty('alert', '加载失败', err.message)); return; }
  const body = $('.drawer-body', drawer);
  if (!items.length) { body.innerHTML = show(empty('history', '还没有历史版本', '以后每次保存都会留一份，最多保留 30 份。')); return; }
  body.innerHTML = show(html`${items.map((h, i) => html`
    <div class="revision" data-rev="${h.revision}">
      <div class="row"><b>修订 ${h.revision}</b>${i === 0 ? html`<span class="badge ok">当前</span>` : ''}${h.deleted ? html`<span class="badge danger">删除</span>` : ''}<span class="spacer"></span><span class="faint" style="font-size:12px" title="${fullTime(h.createdAt)}">${relTime(h.createdAt)}</span></div>
      <div class="faint" style="font-size:12.5px">${h.author || '未知来源'}${h.name !== project.name ? `，当时叫“${h.name}”` : ''}</div>
    </div>`)}
    <div id="hp"></div>`);
  $$('.revision', body).forEach(el => el.onclick = async () => {
    $$('.revision', body).forEach(x => x.classList.toggle('active', x === el));
    const rev = Number(el.dataset.rev), isCurrent = rev === items[0].revision;
    const hp = $('#hp', body); hp.innerHTML = show(html`<div style="padding:16px 20px">${loading()}</div>`);
    try {
      const d = await api(`/api/classes/${classId}/projects/${project.id}/history/${rev}`);
      hp.innerHTML = show(html`<div style="padding:16px 20px 6px" class="row"><b class="grow">修订 ${rev} 预览</b>${isCurrent ? '' : html`<button class="btn sm primary" id="hr">${icon('restore')}恢复到此版本</button>`}</div>${renderSubjects(subjectsOf(d.payloadJson), assetUrl)}`);
      hp.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const btn = $('#hr', hp);
      if (btn) btn.onclick = async () => {
        if (!await confirmDialog({ title: '恢复历史版本', message: `将项目内容恢复为修订 ${rev}，并生成新的修订号。设备下次同步时会拉取该版本；设备上尚未上传的修改会提示冲突。`, confirm: '恢复', danger: false })) return;
        try {
          await api(`/api/classes/${classId}/projects/${project.id}/restore`, { method: 'POST', body: { revision: rev } });
          toast('已恢复到修订 ' + rev); close(); onRestored?.();
        } catch (err) { fail(err); }
      };
    } catch (err) { hp.innerHTML = show(empty('alert', '加载失败', err.message)); }
  });
}

// ============================================================ 公开页面
function recentCodes() { return store.get('recentCodes', []); }
function rememberCode(code, name) { store.set('recentCodes', [{ code, name }, ...recentCodes().filter(x => x.code !== code)].slice(0, 5)); }

async function viewLanding() {
  const recent = recentCodes();
  $('#app').innerHTML = show(html`<div class="landing">
    <div class="landing-top"><span></span>${state.token ? html`<a class="btn" href="#/classes">管理作业</a>` : html`<a class="btn ghost" href="#/login">老师登录</a>`}</div>
    <div class="landing-hero"><div class="hero-card">
      ${logo()}<h1>查看班级作业</h1>
      <p>输入老师给的班级短码</p>
      <form class="code-form" id="cf">
        <input class="input" id="code" placeholder="班级短码" maxlength="16" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="班级短码">
        <button class="btn primary lg" type="submit">查看</button>
      </form>
      <div class="form-error" id="ce" style="margin-top:10px"></div>
      ${recent.length ? html`<div class="recent-codes"><span class="muted">最近看过</span>${recent.map(r => html`<a href="#/c/${r.code}">${r.name || r.code}</a>`)}</div>` : ''}
    </div></div>
  </div>`);
  $('#cf').onsubmit = e => {
    e.preventDefault();
    const code = $('#code').value.trim().toLowerCase();
    if (!code) { $('#ce').textContent = '请输入班级短码'; return; }
    navigate('c/' + encodeURIComponent(code));
  };
  $('#code').focus();
}

async function viewLogin(query) {
  if (await ensureMe()) return navigate(query.get('next') || 'classes');
  $('#app').innerHTML = show(html`<div class="landing">
    <div class="landing-top"><a class="btn ghost" href="#/">${icon('left')}返回</a><span></span></div>
    <div class="landing-hero"><form class="card auth-card stack" id="lf" novalidate>
      <div>${logo()}<h2>老师登录</h2><p class="muted">用学校分配的账号登录</p></div>
      ${query.get('expired') ? html`<div class="banner warn" style="margin:0">${icon('alert')}<span>登录已过期，请重新登录。</span></div>` : ''}
      <label class="field"><span>账号</span><input class="input" name="user" autocomplete="username" required></label>
      <label class="field"><span>密码</span><input class="input" name="pass" type="password" autocomplete="current-password" required></label>
      <div class="form-error" id="le"></div><button class="btn primary lg" type="submit">登录</button>
    </form></div><div class="landing-foot">忘记密码请联系管理员重置</div>
  </div>`);
  const f = $('#lf'); f.user.focus();
  f.onsubmit = async e => {
    e.preventDefault(); $('#le').textContent = '';
    const btn = $('button[type=submit]', f); btn.disabled = true; btn.textContent = '正在登录…';
    try {
      const r = await api('/api/auth/login', { method: 'POST', auth: false, body: { userName: f.user.value.trim(), password: f.pass.value } });
      state.token = r.accessToken; store.set('token', r.accessToken); state.me = null; state.classes = null;
      await ensureMe();
      const next = query.get('next'), cls = next || isAdmin() ? [] : await classList();
      navigate(next || (cls.length === 1 ? `classes/${cls[0].id}/homework` : 'classes'));
    } catch (err) {
      $('#le').textContent = err.status === 401 ? '账号或密码不正确，或账号已停用' : err.message;
      btn.disabled = false; btn.textContent = '登录';
    }
  };
}

async function changePassword() {
  const changed = await modal({
    title: '修改密码', submit: '更新密码',
    body: html`<label class="field"><span>当前密码</span><input class="input" type="password" name="cur" autocomplete="current-password"></label>
      <label class="field"><span>新密码</span><input class="input" type="password" name="next" autocomplete="new-password"><small>至少 8 位，不要与账号相同。</small></label>
      <label class="field"><span>确认新密码</span><input class="input" type="password" name="again" autocomplete="new-password"></label>`,
    onSubmit: async f => {
      if (f.next.value !== f.again.value) throw new Error('两次输入的新密码不一致');
      await api('/api/auth/password', { method: 'POST', body: { currentPassword: f.cur.value, newPassword: f.next.value } });
      return true;
    }
  });
  if (changed) { state.me = null; await ensureMe(); toast('密码已更新，其他设备上的登录已失效'); }
}

async function viewPublic(code, projectId) {
  code = code.toLowerCase();
  const base = `/api/public/classes/${encodeURIComponent(code)}`;
  let first;
  try { first = await api(base + '/projects', { auth: false }); }
  catch (err) {
    $('#app').innerHTML = show(html`<div class="landing"><div class="landing-top"><a class="btn ghost" href="#/">${icon('left')}返回</a><span></span></div>
      <div class="landing-hero">${empty('alert', err.status === 404 ? '找不到这个班级' : '加载失败', err.status === 404 ? `短码“${code}”不存在或已被重置，请向老师确认。` : err.message, html`<a class="btn primary" href="#/">重新输入</a>`)}</div></div>`);
    if (err.status === 404) store.set('recentCodes', recentCodes().filter(r => r.code !== code));
    return;
  }
  rememberCode(code, first.classroom);
  document.title = first.classroom + ' · Pancake 作业';
  onDispose(() => { document.title = 'Pancake 作业'; });
  const shareUrl = `${location.origin}${location.pathname}#/c/${code}`;
  $('#app').innerHTML = show(html`
    <header class="viewer-top">
      <a class="brand" href="#/">${logo()}</a>
      <div class="grow"><div class="class-name">${first.classroom}</div><div class="faint" style="font-size:12px">班级作业 · 只读</div></div>
      <button class="btn sm" data-act="copy" data-text="${shareUrl}" data-label="分享链接已复制">${icon('share')}<span>分享</span></button>
    </header><main class="viewer-body"><div id="vb"></div></main>`);
  let cached = first.projects;
  await mountBrowser($('#vb'), {
    asset: sha => `${base}/assets/${sha}`,
    list: async () => { if (cached) { const c = cached; cached = null; return c; } return (await api(base + '/projects', { auth: false })).projects; },
    detail: id => api(`${base}/projects/${id}`, { auth: false }),
    link: id => `c/${code}/${id}`,
    ws: `/ws/public/${encodeURIComponent(code)}`
  }, projectId);
}

// ============================================================ 班级
async function pairingDialog(classId, className, preset) {
  const r = preset || await api(`/api/classes/${classId}/pairing-code`, { method: 'POST' });
  const expires = Date.now() + r.expiresInSeconds * 1000;
  const code = r.code || r.pairingCode;
  let timer;
  await modal({
    title: '配对班级设备', submit: '', cancel: '完成',
    body: html`<p class="muted">在班级大屏的 Pancake 中打开 <b>设置 → 集控</b>，填写以下信息：</p>
      <dl class="kv"><dt>服务器地址</dt><dd class="row"><span class="mono">${location.origin}</span><button type="button" class="btn ghost sm icon-only" data-act="copy" data-text="${location.origin}">${icon('copy', 'sm')}</button></dd><dt>班级</dt><dd>${className}</dd></dl>
      <div class="pair-code">${code.slice(0, 4)} ${code.slice(4)}</div>
      <div class="row"><span class="muted grow" id="pc-left"></span><button type="button" class="btn sm" data-act="copy" data-text="${code}" data-label="配对码已复制">${icon('copy')}复制配对码</button></div>
      <small class="faint">配对码只能使用一次。过期后可以重新生成。</small>`,
    onMount: (form, dlg) => {
      const tick = () => {
        const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
        const el = $('#pc-left', dlg); if (!el) return;
        el.textContent = left ? `${Math.floor(left / 60)}:${pad(left % 60)} 后过期` : '已过期，请重新生成';
        if (!left) { $('.pair-code', dlg).style.opacity = '.35'; clearInterval(timer); }
      };
      tick(); timer = setInterval(tick, 1000);
    }
  });
  clearInterval(timer);
}

async function createClassFlow() {
  const created = await modal({
    title: '新建班级', submit: '创建',
    body: html`<label class="field"><span>班级名称</span><input class="input" name="name" placeholder="例如：高一（3）班" maxlength="60" required></label>
      <small class="faint">创建后会生成公开短码和一次性设备配对码。</small>`,
    onSubmit: f => { const name = f.elements.name.value.trim(); if (!name) throw new Error('请输入班级名称'); return api('/api/admin/classes', { method: 'POST', body: { name } }); }
  });
  if (!created) return null;
  toast('班级已创建');
  await pairingDialog(created.id, created.name, { code: created.pairingCode, expiresInSeconds: created.expiresInSeconds });
  return created;
}

/** 输入一个名称（分组名等），取消时返回 undefined。 */
const promptName = (title, value = '', placeholder = '') => modal({
  title, submit: '保存',
  body: html`<label class="field"><span>名称</span><input class="input" name="name" value="${value}" placeholder="${placeholder}" maxlength="40" required></label>`,
  onSubmit: f => { const v = f.elements.name.value.trim(); if (!v) throw new Error('请输入名称'); return v; }
});

async function viewClasses(query) {
  const admin = isAdmin();
  const page = shell({ nav: 'classes', title: admin ? '全部班级' : '我的班级', actions: admin ? html`<button class="btn" data-act="new-group">新建分组</button><button class="btn primary" data-act="new-class">${icon('plus')}新建班级</button>` : '' });
  let classes = [], groups = [];
  const reload = async () => {
    [classes, groups] = await Promise.all([api('/api/classes'), api('/api/class-groups').catch(() => [])]);
    state.classes = classes; state.groups = groups;
    render();
  };
  viewActions['new-class'] = async () => { const c = await createClassFlow(); if (c) { state.classes = null; navigate('classes/' + c.id + '/homework'); } };
  viewActions['new-group'] = async () => {
    const name = await promptName('新建分组', '', '例如：高一年级');
    if (!name) return;
    await api('/api/admin/class-groups', { method: 'POST', body: { name } });
    toast(`已新建分组“${name}”`); await reload();
  };
  const moveGroup = async (i, step) => {
    const ids = groups.map(g => g.id); [ids[i], ids[i + step]] = [ids[i + step], ids[i]];
    await api('/api/admin/class-groups/order', { method: 'PUT', body: { ids } }); await reload();
  };
  viewActions['group-menu'] = el => {
    const i = groups.findIndex(g => g.id === el.dataset.id), g = groups[i]; if (!g) return;
    openMenu(el, [
      { label: '重命名', icon: 'edit', run: async () => { const name = await promptName('重命名分组', g.name); if (!name || name === g.name) return; await api(`/api/admin/class-groups/${g.id}`, { method: 'PATCH', body: { name } }); await reload(); } },
      ...(i > 0 ? [{ label: '往前移', icon: 'left', run: () => moveGroup(i, -1) }] : []),
      ...(i < groups.length - 1 ? [{ label: '往后移', icon: 'right', run: () => moveGroup(i, 1) }] : []),
      null,
      { label: '删除分组', icon: 'trash', danger: true, run: async () => {
        if (!await confirmDialog({ title: '删除分组', message: `删除“${g.name}”后，里面的班级变为未分组，班级和作业都不受影响。`, confirm: '删除分组' })) return;
        await api(`/api/admin/class-groups/${g.id}`, { method: 'DELETE' }); toast('分组已删除'); await reload();
      } }
    ]);
  };
  viewActions['class-menu'] = el => {
    const cls = classes.find(x => x.id === el.dataset.id); if (!cls) return;
    const assign = async groupId => { await api(`/api/admin/classes/${cls.id}/group`, { method: 'PUT', body: { groupId } }); await reload(); };
    openMenu(el, groups.length
      ? [...groups.map(g => ({ label: `移到“${g.name}”`, checked: cls.groupId === g.id, run: () => assign(g.id) })), null, { label: '不分组', checked: !cls.groupId, run: () => assign(null) }]
      : [{ label: '新建分组…', icon: 'plus', run: viewActions['new-group'] }]);
  };

  const card = c => html`<a class="class-card" href="#/classes/${c.id}/homework">
      <div class="row"><h3 class="grow">${c.name}</h3>${admin ? html`<button type="button" class="btn ghost sm icon-only" data-act="class-menu" data-id="${c.id}" title="调整分组">${icon('more')}</button>` : ''}</div>
      <div class="class-meta"><span>${c.projectCount} 个项目</span>${c.online ? html`<span class="online">${c.online > 1 ? `${c.online} 块大屏在线` : '大屏在线'}</span>` : html`<span>${c.deviceCount ? '大屏离线' : '还没配对大屏'}</span>`}</div>
      <div class="foot"><span class="code">${c.publicCode}</span><span class="spacer"></span><span>${c.lastUpdatedAt ? relTime(c.lastUpdatedAt) + '更新' : '还没有作业'}</span></div>
    </a>`;
  function render() {
    if (!classes.length) {
      setPage(page, html`<div class="card">${empty('class', admin ? '还没有班级' : '还没有分配班级', admin ? '每个班级对应一块班级大屏，建好后用配对码连接大屏。' : '请联系管理员把你分配到班级。', admin ? html`<button class="btn primary" data-act="new-class">${icon('plus')}新建班级</button>` : '')}</div>`);
      return;
    }
    if (!$('#cg', page)) {
      setPage(page, html`<div class="toolbar"><label class="input-icon">${icon('search', 'sm')}<input class="input" id="cs" placeholder="搜索班级或分组"></label><span class="faint" id="cn"></span></div><div id="cg"></div>`);
      $('#cs').oninput = render;
    }
    $('#cn').textContent = `${classes.length} 个班级`;
    const q = $('#cs').value.trim().toLowerCase();
    const match = c => !q || c.name.toLowerCase().includes(q) || c.publicCode.includes(q) || (c.groupName || '').toLowerCase().includes(q);
    const sections = groupClasses(classes, admin && !q).map(s => ({ ...s, classes: s.classes.filter(match) })).filter(s => s.classes.length || (admin && !q));
    const titled = sections.some(s => s.group);
    $('#cg').innerHTML = show(sections.length ? sections.map(s => html`<section class="class-section">
      ${titled ? html`<div class="class-section-head"><h2>${s.group ? s.group.name : '未分组'}</h2><span class="faint">${s.classes.length} 个班</span>
        ${admin && s.group ? html`<button type="button" class="btn ghost sm icon-only" data-act="group-menu" data-id="${s.group.id}" title="分组操作">${icon('more')}</button>` : ''}</div>` : ''}
      ${s.classes.length ? html`<div class="class-grid">${s.classes.map(card)}</div>` : html`<p class="faint small">这个分组还没有班级，在班级卡片右上角的菜单里移进来。</p>`}
    </section>`) : html`<p class="faint">没有匹配的班级。</p>`);
  }
  setPage(page, loading());
  await reload();
  if (query.get('new') && admin) viewActions['new-class']();
}

// ============================================================ 考试模式
const examMinutes = time => {
  const [h, m] = String(time || '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? Math.max(0, Math.min(1440, h * 60 + m)) : 0;
};
const examTime = minutes => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const examDates = dates => !dates || !dates.length ? '未设置日期'
  : dates.length === 1 ? dateLabel(dates[0], true) : `${dateLabel(dates[0])} ~ ${dateLabel(dates[dates.length - 1])} · ${dates.length} 天`;

async function viewExam() {
  const page = shell({ nav: 'exam', title: '考试模式', actions: html`<button class="btn primary" data-act="exam-new">${icon('plus')}新建考试计划</button>` });
  let plans = [], rooms = [];
  const reload = async () => {
    [plans, rooms] = await Promise.all([api('/api/admin/exam-plans'), api('/api/admin/exam-rooms').catch(() => [])]);
    render();
  };
  viewActions['exam-new'] = () => navigate('exam/new');
  viewActions['exam-edit'] = el => navigate('exam/' + el.dataset.id);
  viewActions['exam-rooms-save'] = async el => {
    el.disabled = true;
    try {
      const items = $$('[data-exam-room]', page).map(input => ({ classId: input.dataset.examRoom, room: input.value.trim() }));
      rooms = await api('/api/admin/exam-rooms', { method: 'PUT', body: { items } });
      toast('考场名已保存');
      render();
    } catch (err) { fail(err); }
    finally { el.disabled = false; }
  };
  viewActions['exam-toggle'] = async el => {
    const plan = plans.find(x => x.id === el.dataset.id); if (!plan) return;
    el.disabled = true;
    try {
      await api(`/api/admin/exam-plans/${plan.id}/enabled`, { method: 'PATCH', body: { enabled: !plan.enabled, expectedRevision: plan.revision } });
      toast(plan.enabled ? '已停用考试计划' : '已启用考试计划');
    } catch (err) { fail(err); }
    await reload();
  };
  viewActions['exam-delete'] = async el => {
    const plan = plans.find(x => x.id === el.dataset.id); if (!plan) return;
    if (!await confirmDialog({ title: '删除考试计划', message: `确定删除“${plan.name}”？大屏会立即退出该计划。`, confirm: '删除' })) return;
    try { await api(`/api/admin/exam-plans/${plan.id}`, { method: 'DELETE' }); toast('考试计划已删除'); } catch (err) { fail(err); }
    await reload();
  };
  function render() {
    const plansHtml = plans.length
      ? html`<div class="exam-list">${plans.map(plan => html`<div class="card exam-card"><div class="card-body">
          <div class="row"><b class="grow">${plan.name}</b><span class="badge ${plan.enabled ? 'ok' : ''}">${plan.enabled ? '启用中' : '未启用'}</span></div>
          <div class="exam-meta"><span>${icon('calendar', 'sm')}${examDates(plan.dates)}</span><span>${plan.segmentCount} 个时间段</span><span>${plan.classIds.length} 个班级</span></div>
          <div class="faint small">${plan.classNames.length ? plan.classNames.join('、') : '未设置班级'}</div>
          <div class="row wrap">
            <button class="btn sm" data-act="exam-edit" data-id="${plan.id}">${icon('edit')}编辑</button>
            <button class="btn sm" data-act="exam-toggle" data-id="${plan.id}">${plan.enabled ? '停用' : '启用'}</button>
            <span class="grow"></span>
            <button class="btn sm danger" data-act="exam-delete" data-id="${plan.id}">${icon('trash')}删除</button>
          </div>
        </div></div>`)}</div>`
      : html`<div class="card">${empty('calendar', '还没有考试计划', '保存并启用后，考试到点大屏会自动全屏显示科目和时间；支持一天多场与场间休息。', html`<button class="btn primary" data-act="exam-new">${icon('plus')}新建考试计划</button>`)}</div>`;
    setPage(page, html`${plansHtml}
      <div class="card exam-rooms"><div class="card-head"><h3>考场名</h3><span class="faint small">显示在考试画面右上角；每个班级一个</span></div><div class="card-body">
        ${rooms.length ? html`<div class="exam-room-grid">${rooms.map(room => html`<label class="exam-room-item"><span>${room.groupName ? room.groupName + ' · ' : ''}${room.className}</span><input class="input sm" data-exam-room="${room.classId}" maxlength="40" placeholder="例如 第 12 考场" value="${room.room}"></label>`)}</div>` : html`<p class="faint">没有可管理的班级。</p>`}
        <div class="row" style="margin-top:12px"><button class="btn primary" data-act="exam-rooms-save">保存考场名</button></div>
      </div></div>`);
  }
  setPage(page, loading());
  await reload();
}

async function viewExamPlan(id) {
  const creating = id === 'new';
  const detail = creating ? null : await api('/api/admin/exam-plans/' + id);
  const classes = state.classes || [];
  const sections = groupClasses(classes);
  const draft = {
    name: detail ? detail.name : '',
    enabled: detail ? detail.enabled : true,
    enterMinutesBefore: detail ? detail.schedule.enterMinutesBefore : 5,
    showSeconds: detail ? detail.schedule.showSeconds !== false : true,
    classIds: new Set(detail ? detail.classIds : []),
    days: detail
      ? detail.schedule.days.map(day => ({
          date: day.date,
          segments: day.segments.map(seg => ({
            kind: seg.kind, subject: seg.subject || '', label: seg.label || '',
            start: examTime(seg.startMinute), end: examTime(seg.endMinute)
          }))
        }))
      : [{ date: todayStr(), segments: [{ kind: 'exam', subject: '', label: '', start: '09:00', end: '10:30' }] }]
  };
  const revision = detail ? detail.revision : 0;
  let dirty = false;
  const mark = () => { dirty = true; };
  setLeaveGuard(() => dirty ? '考试计划还没有保存，离开会丢失修改。' : '');
  const page = shell({
    nav: 'exam', title: creating ? '新建考试计划' : '编辑考试计划',
    actions: html`<button class="btn" data-act="exam-back">返回</button><button class="btn primary" data-act="exam-save">保存</button>`
  });

  viewActions['exam-back'] = async () => {
    if (dirty && !await confirmDialog({ title: '放弃未保存的修改', message: '考试计划还没有保存，离开会丢失修改。', confirm: '放弃并返回' })) return;
    dirty = false; navigate('exam');
  };
  viewActions['exam-add-day'] = () => {
    const last = draft.days[draft.days.length - 1];
    draft.days.push({
      date: last ? shiftDay(last.date, 1) : todayStr(),
      segments: [{ kind: 'exam', subject: '', label: '', start: '09:00', end: '10:30' }]
    });
    mark(); render();
  };
  viewActions['exam-remove-day'] = el => { draft.days.splice(+el.dataset.day, 1); mark(); render(); };
  viewActions['exam-add-seg'] = el => {
    const day = draft.days[+el.dataset.day]; if (!day) return;
    const lastEnd = day.segments.reduce((value, seg) => Math.max(value, examMinutes(seg.end)), 0);
    const start = lastEnd || 9 * 60, end = Math.min(1440, start + (el.dataset.kind === 'break' ? 15 : 90));
    day.segments.push({ kind: el.dataset.kind, subject: '', label: '', start: examTime(start), end: examTime(end) });
    day.segments.sort((a, b) => examMinutes(a.start) - examMinutes(b.start));
    mark(); render();
  };
  viewActions['exam-remove-seg'] = el => { draft.days[+el.dataset.day].segments.splice(+el.dataset.seg, 1); mark(); render(); };
  viewActions['exam-fill-breaks'] = el => {
    const day = draft.days[+el.dataset.day]; if (!day) return;
    const exams = day.segments.filter(seg => seg.kind === 'exam').sort((a, b) => examMinutes(a.start) - examMinutes(b.start));
    const breaks = [];
    for (let index = 1; index < exams.length; index++) {
      if (examMinutes(exams[index - 1].end) < examMinutes(exams[index].start))
        breaks.push({ kind: 'break', subject: '', label: '休息时间', start: exams[index - 1].end, end: exams[index].start });
    }
    day.segments = day.segments.filter(seg => seg.kind !== 'break').concat(breaks).sort((a, b) => examMinutes(a.start) - examMinutes(b.start));
    mark(); render();
  };
  viewActions['exam-save'] = async el => {
    el.disabled = true;
    try {
      const body = {
        name: draft.name.trim(),
        enabled: draft.enabled,
        classIds: [...draft.classIds],
        expectedRevision: revision,
        schedule: {
          enterMinutesBefore: draft.enterMinutesBefore,
          showSeconds: draft.showSeconds,
          days: draft.days.map(day => ({
            date: day.date,
            segments: day.segments.map(seg => ({
              kind: seg.kind,
              subject: seg.kind === 'exam' ? seg.subject.trim() : '',
              startMinute: examMinutes(seg.start),
              endMinute: examMinutes(seg.end),
              label: seg.kind === 'break' ? (seg.label.trim() || '休息时间') : null
            }))
          }))
        }
      };
      if (!body.name) throw new Error('请填写计划名称。');
      if (!body.classIds.length) throw new Error('请选择考试班级。');
      if (creating) await api('/api/admin/exam-plans', { method: 'POST', body });
      else await api('/api/admin/exam-plans/' + id, { method: 'PUT', body });
      dirty = false; toast('考试计划已保存'); navigate('exam');
    } catch (err) { fail(err); }
    finally { el.disabled = false; }
  };

  function bind() {
    const name = $('#exam-name', page); if (name) name.oninput = () => { draft.name = name.value; mark(); };
    const enter = $('#exam-enter', page);
    if (enter) enter.oninput = () => { draft.enterMinutesBefore = Math.max(0, Math.min(120, Math.round(+enter.value || 0))); mark(); };
    const seconds = $('#exam-seconds', page);
    if (seconds) seconds.onchange = () => { draft.showSeconds = seconds.checked; mark(); };
    const enabled = $('#exam-enabled', page); if (enabled) enabled.onchange = () => { draft.enabled = enabled.checked; mark(); };
    $$('[data-exam-date]', page).forEach(input => input.onchange = () => {
      const day = draft.days[+input.dataset.examDate]; if (day) { day.date = input.value; mark(); }
    });
    $$('[data-exam-group]', page).forEach(box => box.onchange = () => {
      const section = sections.find(item => (item.group ? item.group.id : '') === box.dataset.examGroup);
      (section ? section.classes : []).forEach(c => box.checked ? draft.classIds.add(c.id) : draft.classIds.delete(c.id));
      mark(); render();
    });
    $$('[data-exam-class]', page).forEach(box => box.onchange = () => {
      if (box.checked) draft.classIds.add(box.dataset.examClass); else draft.classIds.delete(box.dataset.examClass);
      mark(); render();
    });
    $$('[data-exam-kind]', page).forEach(select => select.onchange = () => {
      const [dayIndex, segIndex] = select.dataset.examKind.split(':').map(Number);
      const seg = draft.days[dayIndex]?.segments[segIndex];
      if (seg) { seg.kind = select.value; mark(); render(); }
    });
    $$('[data-exam-text]', page).forEach(input => input.oninput = () => {
      const [dayIndex, segIndex] = input.dataset.examText.split(':').map(Number);
      const seg = draft.days[dayIndex]?.segments[segIndex]; if (!seg) return;
      if (seg.kind === 'exam') seg.subject = input.value; else seg.label = input.value;
      mark();
    });
    $$('[data-exam-start]', page).forEach(input => input.onchange = () => {
      const [dayIndex, segIndex] = input.dataset.examStart.split(':').map(Number);
      const seg = draft.days[dayIndex]?.segments[segIndex]; if (seg) { seg.start = input.value; mark(); }
    });
    $$('[data-exam-end]', page).forEach(input => input.onchange = () => {
      const [dayIndex, segIndex] = input.dataset.examEnd.split(':').map(Number);
      const seg = draft.days[dayIndex]?.segments[segIndex]; if (seg) { seg.end = input.value; mark(); }
    });
  }

  function render() {
    page.innerHTML = show(html`<div class="exam-editor">
      <div class="card"><div class="card-head"><h3>基本信息</h3></div><div class="card-body grid-2">
        <label class="field"><span>计划名称</span><input class="input" id="exam-name" maxlength="60" placeholder="例如 期中考试" value="${draft.name}"></label>
        <label class="field"><span>开考前提前进入（分钟）</span><input class="input" id="exam-enter" type="number" min="0" max="120" value="${draft.enterMinutesBefore}"></label>
        <label class="row" style="grid-column:1/-1"><input type="checkbox" id="exam-seconds" ${draft.showSeconds ? 'checked' : ''}><span>大时钟与倒计时显示到秒</span></label>
        <label class="row" style="grid-column:1/-1"><input type="checkbox" id="exam-enabled" ${draft.enabled ? 'checked' : ''}><span>保存后启用（启用后按时间表自动全屏显示）</span></label>
      </div></div>
      <div class="card"><div class="card-head"><h3>参考班级</h3><span class="faint small">将影响 ${draft.classIds.size} 个班级</span></div><div class="card-body">
        ${sections.length ? html`<div class="exam-classes">${sections.map(section => {
          const groupId = section.group ? section.group.id : '';
          const all = section.classes.length > 0 && section.classes.every(c => draft.classIds.has(c.id));
          return html`<div class="exam-class-group">
            <label class="row"><input type="checkbox" data-exam-group="${groupId}" ${all ? 'checked' : ''}><b>${section.group ? section.group.name : '未分组'}</b><span class="faint small">${section.classes.length} 个班</span></label>
            <div class="exam-class-items">${section.classes.map(c => html`<label class="exam-class-item"><input type="checkbox" data-exam-class="${c.id}" ${draft.classIds.has(c.id) ? 'checked' : ''}><span>${c.name}</span></label>`)}</div>
          </div>`;
        })}</div>` : html`<p class="faint">没有可管理的班级。</p>`}
      </div></div>
      <div class="card"><div class="card-head"><h3>考试时间表</h3><span class="faint small">一天可以安排多场考试，场次之间可添加休息</span></div><div class="card-body">
        ${draft.days.length ? draft.days.map((day, dayIndex) => html`<div class="exam-day">
          <div class="row wrap">
            <label class="field" style="width:180px"><span>考试日期</span><input class="input" type="date" data-exam-date="${dayIndex}" value="${day.date}"></label>
            <span class="grow"></span>
            <button class="btn sm danger" data-act="exam-remove-day" data-day="${dayIndex}">${icon('trash')}删除当天</button>
          </div>
          ${day.segments.length ? html`<div class="exam-segments">${day.segments.map((seg, segIndex) => html`<div class="exam-seg">
            <select class="input sm" data-exam-kind="${dayIndex}:${segIndex}"><option value="exam" ${seg.kind === 'exam' ? 'selected' : ''}>考试</option><option value="break" ${seg.kind === 'break' ? 'selected' : ''}>休息</option></select>
            <input class="input sm" data-exam-text="${dayIndex}:${segIndex}" maxlength="30" placeholder="${seg.kind === 'exam' ? '科目，如 语文' : '休息文案，如 课间休息'}" value="${seg.kind === 'exam' ? seg.subject : seg.label}">
            <input class="input sm" type="time" data-exam-start="${dayIndex}:${segIndex}" value="${seg.start}">
            <input class="input sm" type="time" data-exam-end="${dayIndex}:${segIndex}" value="${seg.end}">
            <button class="btn sm ghost icon-only" data-act="exam-remove-seg" data-day="${dayIndex}" data-seg="${segIndex}" title="删除时间段">${icon('x')}</button>
          </div>`)}</div>` : html`<p class="faint small">还没有时间段，先添加一场考试。</p>`}
          <div class="row wrap" style="margin-top:10px">
            <button class="btn sm" data-act="exam-add-seg" data-day="${dayIndex}" data-kind="exam">${icon('plus')}添加场次</button>
            <button class="btn sm" data-act="exam-add-seg" data-day="${dayIndex}" data-kind="break">${icon('plus')}添加休息</button>
            <button class="btn sm" data-act="exam-fill-breaks" data-day="${dayIndex}">自动填充休息</button>
          </div>
        </div>`) : html`<p class="faint">还没有考试日，点击下方按钮添加。</p>`}
        <div class="row" style="margin-top:12px"><button class="btn" data-act="exam-add-day">${icon('plus')}添加考试日</button></div>
      </div></div>
    </div>`);
    bind();
  }

  render();
}

async function viewClass(classId, section = 'homework', sub, query) {
  if (sub instanceof URLSearchParams) { query = sub; sub = undefined; }
  if (section instanceof URLSearchParams) { query = section; section = 'homework'; }
  let c;
  try { c = await api(`/api/classes/${classId}`); }
  catch (err) {
    if (err.status !== 404 && err.status !== 403) throw err;
    store.del('lastClass'); state.classes = null;
    const page = shell({ nav: 'classes', title: '班级不存在' });
    return setPage(page, html`<div class="card">${empty('alert', '班级不存在', '该班级可能已被删除，或你没有访问权限。', html`<a class="btn" href="#/classes">返回班级列表</a>`)}</div>`);
  }
  store.set('lastClass', c.id);
  const publicUrl = `${location.origin}${location.pathname}#/c/${c.publicCode}`;
  const page = shell({
    classId: c.id, nav: 'homework', title: '作业', crumbs: html`<span>${c.groupName ? `${c.groupName}　` : ''}${c.name}</span>`,
    actions: html`<span class="code-chip" title="学生输入这个短码查看作业">学生短码 <b>${c.publicCode}</b><button class="btn ghost sm icon-only" data-act="copy" data-text="${publicUrl}" data-label="学生查看链接已复制" title="复制学生查看链接">${icon('link', 'sm')}</button></span>
      <button class="btn sm" data-act="pair">配对大屏</button><span class="online-text">${c.online ? (c.online > 1 ? `${c.online} 块大屏在线` : '大屏在线') : '大屏离线'}</span>`
  });
  page.classList.add('wide');
  setPage(page, html`<div id="tab">${loading()}</div>`);
  viewActions.pair = () => pairingDialog(c.id, c.name);
  await classHomework($('#tab'), c, sub, query);
}


const BOARD_W = 1600, BOARD_H = 900;
const TILE_MIN = { w: 280, h: 96 }, TILE_MAX = { w: 900, h: 680 };
// ============================================================ 作业工作台：大屏画布 + 检查器 / 列表
/**
 * 画布按大屏上报的真实尺寸画出整屏：时钟区、作业区和分隔条都在，磁贴按作业区坐标摆放，可以移动、八方向缩放和自动排列；
 * 拖动分隔条、切换布局模式直接改班级布局。点选磁贴后在右侧检查器里改科目名、颜色、作业文字和图片。
 * 内容、位置与项目配色共用一份草稿，一次保存；列表视图是同一份草稿的卡片式编辑，适合连续录入和窄屏。
 * 有未保存的修改时占用项目：大屏在编辑时网页只读，可以请求大屏保存并退出编辑。
 */
const NEW_TILE = { w: 430, h: 320 };
const TILE_COLORS = ['#818CF8', '#4ADE80', '#60A5FA', '#FBBF24', '#F472B6', '#2DD4BF', '#F87171'];
const sameRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const LAYOUT_MODES = [['Split', '分屏'], ['Board', '仅作业'], ['Clock', '仅时钟'], ['Free', '自由布局']];
const THEMES = [['Dark', '深色'], ['Light', '浅色'], ['Default', '跟随系统']];
const PALETTES = [['Vivid', '鲜艳'], ['Macaron', '马卡龙']];
/** 占用每 15 秒续期一次；5 分钟没有操作就放开，让大屏可以编辑。请求大屏结束编辑后最多等 15 秒。 */
const LOCK_BEAT = 15000, LOCK_IDLE = 5 * 60000, END_WAIT = 15000;
/** 本页面的占用标识：同一位老师开两个窗口也互相占用。局域网 http 下没有 randomUUID，直接用随机字节。 */
const CLIENT_ID = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
const parseDoc = json => { try { const d = JSON.parse(json || '{}'); return d && typeof d === 'object' ? d : {}; } catch { return {}; } };

async function classHomework(box, c, projectId, query) {
  const classId = c.id, assetUrl = consoleAsset(classId);
  const [layout, allowed, defaults, initial, deviceList, lockList] = await Promise.all([
    api(`/api/classes/${classId}/layout`).catch(() => null), editableSubjects(classId), richDefaults(classId), api(`/api/classes/${classId}/projects`),
    api(`/api/classes/${classId}/devices`).catch(() => []),
    // 旧服务端没有占用接口：照常编辑，冲突仍由修订号把关。
    api(`/api/classes/${classId}/edit-locks`).catch(err => err.status === 404 || err.status === 405 ? null : [])]);
  let layoutSnap = layout || { revision: 0, policy: 'Shared', payloadJson: '{}' }, boardDoc = parseDoc(layoutSnap.payloadJson);
  let devices = deviceList || [];
  const locks = new Map((lockList || []).map(l => [l.projectId, l]));
  const lockUnsupported = lockList === null;
  let editorGridSize = store.get('hwGridSize', Math.max(16, Math.min(160, +boardDoc.GridSize || 48)));
  let editorSnap = store.get('hwGridSnap', boardDoc.GridSnappingEnabled !== false);
  const gridSize = () => editorGridSize;
  const snap = v => editorSnap ? Math.round(v / gridSize()) * gridSize() : Math.round(v);
  const can = name => !allowed || allowed.has(name.trim().toLowerCase());
  // 布局与项目配色作用于整块大屏，受科目限制的老师只能查看。
  const canBoard = !allowed;

  let projects = initial, showDeleted = false, detail = null, draft = null, base = '', selS = null;
  let savedAt = 0, uploading = 0, saving = false, liveOn = true, openToken = 0;
  let view = store.get('hwView') || (innerWidth <= 860 ? 'list' : 'canvas');
  let screenId = store.get('hwScreen.' + classId, null), splitPreview = null, splitDrag = null, drag = null;
  let lockHeld = false, lockForced = false, lockBusy = null, lockRetryAt = 0, lastActive = Date.now(), endWait = null, endTimer = 0;
  const byId = id => projects.find(p => p.id === id);
  const live = () => draft ? draft.subjects.filter(s => !s.removed) : [];
  const macaron = () => draft?.palette === 'Macaron';
  const displayColor = s => Board.accent(s.color, s.explicit || s.color !== s.origColor, macaron());
  const editorStyle = `--rt-font:${JSON.stringify(defaults.fontFamily).replace(/"/g, "'")};--rt-size:${(defaults.fontSize * .8).toFixed(1)}px`;

  box.innerHTML = show(html`<div class="hw" id="hw">
    <div class="hw-bar" id="hw-bar"></div>
    <div id="hw-lock" hidden></div>
    <div id="hw-body"></div>
    <div class="save-bar hw-save" id="hw-save" hidden></div>
    <div class="print-only" id="hw-print"></div>
  </div>`);
  const root = $('#hw', box), bar = $('#hw-bar', root), body = $('#hw-body', root), lockSlot = $('#hw-lock', root);

  // ---------- 大屏的屏幕与分区
  /** 画布依据的大屏：手动选的、在线且正显示本项目的、在线的、最近上报的，依次挑选。 */
  function screenDevice() {
    const list = devices.filter(d => d.screen && !d.revoked);
    return list.find(d => d.id === screenId) || list.find(d => d.online && d.activeProjectId === detail?.id) || list.find(d => d.online)
      || [...list].sort((a, b) => (parseTime(b.screenAt) || 0) - (parseTime(a.screenAt) || 0))[0] || null;
  }
  const area = r => r && r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  /**
   * 整屏与分区。大屏上报的分区与班级布局一致（或本班不同步布局）时用真实分区；拖动分隔条、刚改完布局而大屏还没回报时，
   * 按大屏的整屏尺寸和新比例估算；没有任何上报时按 1600×900 估算。
   */
  function geometry() {
    const dev = screenDevice(), s = dev?.screen, mode = boardDoc.LayoutMode || 'Split';
    const W = s ? s.width : BOARD_W, H = s ? s.height : BOARD_H;
    const same = s && s.layoutMode === mode && (mode !== 'Split' || Math.abs(s.splitRatio - Board.SPLIT(boardDoc)) < .005);
    if (s && splitPreview == null && (same || layoutSnap.policy === 'Off'))
      return { W, H, mode: s.layoutMode, compact: !!s.compact, clock: area(s.clock), board: area(s.board), device: dev, live: true };
    const doc = splitPreview == null ? boardDoc : { ...boardDoc, SplitRatio: splitPreview };
    return { W, H, ...Board.regions(doc, W, H), device: dev, live: false };
  }
  /** 磁贴能摆放的范围是作业区；无限作业板只限制不能拖出左上角。vw 是作业区可见宽度，用来给新磁贴找空位。 */
  function bounds() {
    const b = geometry().board || { w: BOARD_W, h: BOARD_H };
    return boardDoc.InfiniteBoard ? { w: Infinity, h: Infinity, vw: b.w } : { w: b.w, h: b.h, vw: b.w };
  }

  // ---------- 草稿
  function buildDraft(d) {
    const scheme = projectScheme(d.payloadJson);
    const subjects = parseProject(d.payloadJson, d.runs).map(s => {
      const rect = { x: s.rect.x, y: s.rect.y, w: s.rect.w, h: s.rect.h };
      return {
        index: s.index, name: s.name, color: (s.color || '#818CF8').toUpperCase(), origColor: (s.color || '').toUpperCase(),
        explicit: s.explicit, locked: !can(s.name), removed: false, rect, origRect: { ...rect },
        entries: s.entries.map(e => ({ index: e.index, runs: e.runs, hand: e.hand, atts: e.atts.map(a => ({ index: a.index, name: a.name, path: a.path, kind: a.kind })) }))
      };
    });
    // 项目里没有保存配色（很旧的数据）时沿用班级设置里的旧值，改了才写进项目。
    const theme = scheme.theme || (THEMES.some(([k]) => k === boardDoc.Theme) ? boardDoc.Theme : 'Dark');
    const palette = scheme.palette || (PALETTES.some(([k]) => k === boardDoc.Palette) ? boardDoc.Palette : 'Vivid');
    const out = { name: d.name, date: d.date || '', subjects, theme, palette, origTheme: theme, origPalette: palette };
    // 没有摆放过的科目先放到空位上，不算改动。
    for (const s of subjects) if (s.rect.w <= 0 || s.rect.h <= 0) { s.rect = freeSpot(subjects.filter(x => x !== s && x.rect.w > 0)); s.origRect = { ...s.rect }; }
    return out;
  }
  const snapshotOf = () => draft && {
    n: draft.name.trim(), d: draft.date, t: draft.theme, p: draft.palette,
    s: live().map(s => ({ i: s.index, n: s.name, c: s.color, r: s.rect, e: s.entries.map(e => ({ i: e.index, r: rtNormalize(e.runs), a: e.atts.map(a => a.index ?? a.path) })) }))
  };
  const snapshot = () => JSON.stringify(snapshotOf());
  const dirty = () => !!draft && snapshot() !== base;
  setLeaveGuard(() => dirty() ? '作业有未保存的修改，离开后会丢失。' : '');

  function freeSpot(others = live()) {
    const g = gridSize(), { w, h } = NEW_TILE, width = Math.max(bounds().vw, w + g);
    for (let y = g; y < 4000; y += g)
      for (let x = g; x + w <= width; x += g)
        if (!others.some(o => x < o.rect.x + o.rect.w && o.rect.x < x + w && y < o.rect.y + o.rect.h && o.rect.y < y + h)) return { x, y, w, h };
    return { x: g, y: g, w, h };
  }
  const serialize = s => ({
    index: s.index, name: s.name.trim(),
    accentHex: s.color !== s.origColor && !(s.index != null && !s.origColor && s.color === '#818CF8') ? s.color : null,
    entries: s.entries.filter(en => en.index != null || rtPlain(en.runs).trim() || en.atts.length).map(en => ({
      index: en.index, content: rtPlain(en.runs), runs: en.runs, attachments: en.atts.map(a => a.index != null ? { index: a.index } : { asset: a.path, name: a.name })
    })),
    rect: !s.locked && (s.index == null || !sameRect(s.rect, s.origRect)) ? { x: s.rect.x, y: s.rect.y, width: s.rect.w, height: s.rect.h } : null
  });
  /** 草稿转成展示用的科目（复制文本、打印）。 */
  const viewSubjects = () => live().map(s => ({
    name: s.name || '新科目', color: displayColor(s),
    entries: s.entries.map(e => ({ text: rtPlain(e.runs), runs: e.runs, hand: e.hand, atts: e.atts })).filter(e => e.text.trim() || e.hand || e.atts.length)
  }));

  // ---------- 编辑占用
  const mine = l => !!l && l.holder === 'user' && l.clientId === CLIENT_ID;
  /** 占着当前项目的另一方（大屏或别的网页）；没有时网页可以编辑。 */
  const blocker = () => { const l = detail && locks.get(detail.id); return l && !mine(l) ? l : null; };
  const readOnly = () => !!blocker();
  const ro = s => s.locked || readOnly();
  const lockText = l => !l ? '' : l.holder === 'device' ? `大屏“${l.name}”正在编辑这个项目`
    : l.userId === state.me?.id ? '你在另一个窗口里编辑这个项目' : `${l.name}正在网页上编辑这个项目`;
  const lockLost = ok => { if (!ok) { renderAll(); toast(`${lockText(blocker())}，这次修改先不能保存`, 'error'); } };
  /** 占用或续期当前项目，被别人占着时返回 false。连不上服务器时照常编辑，稍后再试。 */
  function acquire(force = false) {
    if (!detail || lockUnsupported) return Promise.resolve(true);
    if (lockBusy && !force) return lockBusy;
    const id = detail.id;
    return lockBusy = api(`/api/classes/${classId}/projects/${id}/edit-lock`, { method: 'PUT', body: { clientId: CLIENT_ID, force } })
      .then(l => { locks.set(id, l); if (detail?.id === id) { lockHeld = true; if (force) lockForced = true; } return true; })
      .catch(err => {
        if (err.status === 423 && err.body?.holder) { locks.set(id, err.body); if (detail?.id === id) lockHeld = false; return false; }
        lockRetryAt = Date.now() + 10000;
        return true;
      })
      .finally(() => { lockBusy = null; });
  }
  function release(id = detail?.id, keepalive = false) {
    if (!lockHeld || !id) return;
    lockHeld = lockForced = false;
    if (mine(locks.get(id))) locks.delete(id);
    const url = `/api/classes/${classId}/projects/${id}/edit-lock?clientId=${CLIENT_ID}`;
    if (keepalive) fetch(url, { method: 'DELETE', keepalive: true, headers: { authorization: 'Bearer ' + state.token } }).catch(() => { });
    else api(url, { method: 'DELETE' }).catch(() => { });
  }
  /** 占用跟着草稿走：有未保存的修改就占用，保存或撤销后释放；强制接管后一直占着，直到保存、撤销或离开。 */
  function syncLock() {
    if (!detail || !draft || lockUnsupported) return;
    if (dirty() && !lockHeld && !readOnly() && !lockBusy && Date.now() >= lockRetryAt) acquire().then(lockLost);
    else if (!dirty() && !saving && lockHeld && !lockForced) release();
  }
  function renderLock() {
    const l = blocker();
    lockSlot.hidden = !l;
    if (!l) { lockSlot.innerHTML = ''; return; }
    const board = l.holder === 'device', late = !!endWait && (!endWait.delivered || Date.now() - endWait.at >= END_WAIT);
    const note = !board ? '对方保存或离开后就能编辑。'
      : !endWait ? '网页暂时只能查看。可以让大屏先保存修改并退出编辑模式。'
        : late ? '大屏没有响应，可能正开着对话框。可以再等等，或者强制编辑。' : '已通知大屏保存，正在等它退出编辑……';
    const action = !board ? '' : late ? html`<button type="button" class="btn sm" data-hw="force">强制编辑</button>`
      : endWait ? '' : html`<button type="button" class="btn sm primary" data-hw="end-edit">结束并保存大屏修改</button>`;
    lockSlot.innerHTML = show(html`<div class="lock-banner" role="status">${icon('lock')}<div class="grow"><b>${board ? '本地修改中' : '正在别处编辑'}</b><span>${lockText(l)}。${note}</span></div>${action}</div>`);
  }
  /** “结束并保存大屏修改”：大屏保存、上传并退出编辑后释放占用，网页收到通知后就能编辑。 */
  async function endBoardEdit() {
    if (!detail || blocker()?.holder !== 'device') return;
    const r = await api(`/api/classes/${classId}/projects/${detail.id}/edit-lock/end`, { method: 'POST' });
    if (r.free) { locks.delete(detail.id); renderAll(); return; }
    endWait = { at: Date.now(), delivered: r.delivered };
    clearTimeout(endTimer);
    endTimer = setTimeout(renderLock, END_WAIT + 50);
    renderLock();
  }
  async function forceEdit() {
    if (!await confirmDialog({ title: '强制编辑', message: '大屏会被要求保存并退出编辑。它还没上传的修改不会丢：等你保存后，大屏会把两边的修改合并，合并不了就另存一份副本。', confirm: '强制编辑', danger: false })) return;
    if (!await acquire(true)) return renderAll();
    endWait = null; clearTimeout(endTimer);
    await open(detail.id, true);
    toast('已接管，可以修改了');
  }
  const beat = setInterval(() => {
    if (!lockHeld || !detail) return;
    // 长时间没有操作就放开占用，让大屏可以编辑；回来接着改时会重新占用。
    if (Date.now() - lastActive > LOCK_IDLE) return release();
    acquire().then(lockLost);
  }, LOCK_BEAT);
  const onHide = () => release(detail?.id, true);
  addEventListener('pagehide', onHide);
  onDispose(() => { clearInterval(beat); clearTimeout(endTimer); removeEventListener('pagehide', onHide); release(); });
  for (const type of ['pointerdown', 'keydown', 'input']) root.addEventListener(type, () => { lastActive = Date.now(); }, true);

  // ---------- 项目切换
  /** 按日期从旧到新排，用来前后翻。 */
  const ordered = () => projects.filter(p => showDeleted || !p.deleted || p.id === detail?.id)
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.name.localeCompare(b.name, 'zh'));
  async function refreshProjects() { projects = await api(`/api/classes/${classId}/projects`); renderBar(); }
  /** keepSel：重新载入同一项目时保留选中的磁贴。换到别的项目时放开当前项目的占用。 */
  async function open(id, keepSel = false) {
    if (detail && detail.id !== id) { release(detail.id); endWait = null; clearTimeout(endTimer); }
    const token = ++openToken, selPos = keepSel ? live().indexOf(selS) : -1;
    if (!byId(id)) { detail = draft = selS = null; base = ''; renderAll(); return; }
    let d;
    try { d = await api(`/api/classes/${classId}/projects/${id}`); }
    catch (err) { if (token === openToken) body.innerHTML = show(html`<div class="card">${empty('alert', '加载失败', err.message)}</div>`); return; }
    if (token !== openToken) return;
    detail = d; draft = d.deleted ? null : buildDraft(d); base = snapshot();
    selS = selPos >= 0 ? live()[selPos] || null : null;
    renderAll();
  }
  async function switchTo(id) {
    if (!id || id === detail?.id) return;
    if (dirty() && !await confirmDialog({ title: '放弃未保存的修改', message: '当前项目的修改还没有保存，确定切换吗？', confirm: '放弃并切换' })) return;
    setHash(`classes/${classId}/homework/${id}`);
    await open(id);
  }
  /** 新建后直接进入编辑：选中第一个磁贴并把光标放进第一条作业。 */
  async function afterCreate(created) {
    await refreshProjects();
    setHash(`classes/${classId}/homework/${created.id}`);
    await open(created.id);
    const first = live().find(s => !s.locked);
    if (view === 'canvas' && first) select(first, true);
    else $('#hw-body .rich[contenteditable=true]')?.focus();
  }
  async function newProject() {
    if (dirty() && !await confirmDialog({ title: '放弃未保存的修改', message: '当前项目的修改还没有保存，确定新建吗？', confirm: '放弃并新建' })) return;
    const t = todayStr(), [, m, d] = t.split('-').map(Number);
    const created = await api(`/api/classes/${classId}/projects`, { method: 'POST', body: { name: `${m}月${d}日`, date: t, templateProjectId: null, useLatestTemplate: true } });
    toast('已新建项目，沿用最近的科目布局');
    await afterCreate(created);
  }
  async function newFromTemplate() {
    const t = todayStr(), [, m, d] = t.split('-').map(Number);
    const liveP = projects.filter(p => !p.deleted).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const created = await modal({
      title: '选择模板新建', submit: '新建',
      body: html`<label class="field"><span>项目名称</span><input class="input" name="name" value="${m}月${d}日" maxlength="80"></label>
        <label class="field"><span>作业日期</span><input class="input" type="date" name="date" value="${t}"></label>
        <label class="field"><span>科目布局</span><select class="input" name="tpl">
          <option value="latest">沿用最近的项目</option>${liveP.slice(0, 30).map(p => html`<option value="${p.id}">沿用“${p.name}”</option>`)}<option value="none">空白项目</option></select>
          <small>沿用时保留科目、颜色、磁贴位置和配色，只清空作业内容和笔迹。</small></label>`,
      onSubmit: f => {
        const name = f.elements.name.value.trim(); if (!name) throw new Error('请输入项目名称');
        const tpl = f.tpl.value;
        return api(`/api/classes/${classId}/projects`, { method: 'POST', body: { name, date: f.date.value || null, templateProjectId: /^[0-9a-f-]{36}$/.test(tpl) ? tpl : null, useLatestTemplate: tpl === 'latest' } });
      }
    });
    if (!created) return;
    toast('已新建项目');
    await afterCreate(created);
  }
  async function deleteProject() {
    const p = detail; if (!p) return;
    await api(`/api/classes/${classId}/projects/${p.id}`, { method: 'DELETE' });
    draft = null; base = '';
    toast(`已删除“${p.name}”`, 'ok', {
      action: '撤销', onAction: async () => {
        await api(`/api/classes/${classId}/projects/${p.id}/restore`, { method: 'POST', body: {} });
        toast('项目已恢复'); await refreshProjects();
        if (!dirty()) { setHash(`classes/${classId}/homework/${p.id}`); await open(p.id); }
      }
    });
    await refreshProjects();
    const next = defaultProject(projects);
    setHash(`classes/${classId}/homework${next ? '/' + next.id : ''}`, true);
    await open(next?.id);
  }
  async function restoreProject() {
    await api(`/api/classes/${classId}/projects/${detail.id}/restore`, { method: 'POST', body: {} });
    toast('项目已恢复'); await refreshProjects(); await open(detail.id);
  }

  // ---------- 保存
  /** 记下光标所在的输入框，保存后重绘时放回原处。 */
  function captureFocus() {
    const a = document.activeElement; if (!a || !root.contains(a)) return null;
    const si = a.closest('[data-si]'), pos = si ? live().indexOf(draft.subjects[+si.dataset.si]) : -1;
    if (a.classList.contains('rich')) return { pos, ei: +a.closest('[data-ei]').dataset.ei, sel: rtSelection(a) };
    if (a.dataset.hwF) return { hw: a.dataset.hwF, start: a.selectionStart };
    if (a.dataset.f === 'name') return { pos, name: true, start: a.selectionStart };
    return null;
  }
  function restoreFocus(f) {
    if (!f) return;
    if (f.hw) { const el = $(`[data-hw-f="${f.hw}"]`, root); el?.focus(); try { el?.setSelectionRange(f.start, f.start); } catch { } return; }
    const s = live()[f.pos]; if (!s) return;
    const card = $(`[data-si="${draft.subjects.indexOf(s)}"]`, root); if (!card) return;
    if (f.name) { const el = $('[data-f=name]', card); el?.focus(); try { el?.setSelectionRange(f.start, f.start); } catch { } return; }
    const el = $(`[data-ei="${f.ei}"] .rich`, card); if (!el) return;
    el.focus(); if (f.sel) rtSetSelection(el, f.sel.start, f.sel.end);
  }
  /** 采用服务端返回的项目：草稿重新按新的序号建立，keepMeta 为还没保存的名称与日期。 */
  function adopt(d, keepMeta) {
    const selPos = live().indexOf(selS);
    detail = d; draft = buildDraft(d); base = snapshot();
    if (keepMeta) { draft.name = keepMeta.name; draft.date = keepMeta.date; }
    selS = selPos >= 0 ? live()[selPos] || null : null;
  }
  async function save() {
    if (!draft || saving || !dirty()) return;
    if (readOnly()) return toast(`${lockText(blocker())}，等对方结束后再保存`, 'error');
    if (uploading) return toast('图片还在上传，请稍候', 'error');
    const name = draft.name.trim();
    if (!name) { $('[data-hw-f=name]', root)?.focus(); return toast('项目名称不能为空', 'error'); }
    const blank = live().find(s => !s.name.trim());
    if (blank) { if (view === 'canvas') select(blank); $(`[data-si="${draft.subjects.indexOf(blank)}"] [data-f=name]`, root)?.focus(); return toast('科目名称不能为空', 'error'); }
    if (!lockHeld && !await acquire()) { renderAll(); return toast(`${lockText(blocker())}，等对方结束后再保存`, 'error'); }
    const before = JSON.parse(base), now = snapshotOf();
    const contentChanged = JSON.stringify(now.s) !== JSON.stringify(before.s) || now.t !== before.t || now.p !== before.p;
    const meta = { name, date: draft.date || '' }, metaChanged = meta.name !== detail.name || meta.date !== (detail.date || '');
    const focus = captureFocus();
    saving = true; refreshBar();
    try {
      if (contentChanged) {
        // 配色只在改过时发送：受科目限制的老师保存作业时不会碰到配色权限。
        const scheme = { ...(draft.theme !== draft.origTheme ? { theme: draft.theme } : {}), ...(draft.palette !== draft.origPalette ? { palette: draft.palette } : {}) };
        const d = await api(`/api/classes/${classId}/projects/${detail.id}/content`, { method: 'PUT', body: { expectedRevision: detail.revision, subjects: live().map(serialize), ...scheme } });
        adopt(d, metaChanged ? meta : null);
      }
      if (metaChanged) {
        const m = await api(`/api/classes/${classId}/projects/${detail.id}`, { method: 'PATCH', body: meta.date ? { name: meta.name, date: meta.date } : { name: meta.name, clearDate: true } });
        adopt({ ...m, runs: detail.runs });
      }
      savedAt = Date.now(); lockForced = false;
      const i = projects.findIndex(p => p.id === detail.id);
      if (i >= 0) projects[i] = { ...projects[i], name: detail.name, date: detail.date, revision: detail.revision, updatedAt: detail.updatedAt, updatedBy: detail.updatedBy };
      renderAll(); restoreFocus(focus);
      toast('已保存，大屏马上更新');
    } catch (err) {
      if (err.status === 423) { if (err.body?.lock) locks.set(detail.id, err.body.lock); lockHeld = false; renderAll(); toast(err.message, 'error'); }
      else if (err.status === 409) {
        if (await confirmDialog({ title: '作业刚被修改', message: '班级大屏或其他老师刚改过这个项目。要载入最新内容吗？当前没保存的修改会丢失，可以先复制下来。', confirm: '载入最新内容', danger: false })) { base = snapshot(); await open(detail.id, true); }
      } else fail(err);
    } finally { saving = false; refreshBar(); }
  }
  function discard() {
    const selPos = live().indexOf(selS);
    draft = buildDraft(detail); base = snapshot(); lockForced = false;
    selS = selPos >= 0 ? live()[selPos] || null : null;
    renderAll();
  }

  // ---------- 班级布局（分屏）与大屏上报
  /** 改班级布局（布局模式、分屏比例）：按键合并，大屏收到后立即应用，并回报新的分区尺寸。 */
  async function commitLayout(set) {
    try {
      layoutSnap = await api(`/api/classes/${classId}/layout`, { method: 'PATCH', body: { baseRevision: layoutSnap.revision, set } });
      boardDoc = parseDoc(layoutSnap.payloadJson);
      if (!devices.some(d => d.online && !d.revoked)) toast('布局已保存，大屏连上后应用');
    } catch (err) {
      if (err.status === 409 && err.body?.server) {
        layoutSnap = err.body.server; boardDoc = parseDoc(layoutSnap.payloadJson);
        toast('大屏刚改过布局，已载入最新的，请再调整一次', 'error');
      } else fail(err);
    } finally { splitPreview = null; renderCanvas(); renderStageFoot(); }
  }
  let layoutTimer;
  function scheduleLayout() {
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(async () => {
      try { layoutSnap = await api(`/api/classes/${classId}/layout`); boardDoc = parseDoc(layoutSnap.payloadJson); } catch { return; }
      if (!splitDrag && !drag) { renderCanvas(); renderStageFoot(); }
    }, 300);
  }
  onDispose(() => clearTimeout(layoutTimer));
  /** 顶栏的大屏在线状态：随屏幕上报与定时刷新更新。 */
  function renderOnline() {
    const el = $('.online-text'); if (!el) return;
    const n = devices.filter(d => d.online && !d.revoked).length;
    el.textContent = n ? (n > 1 ? `${n} 块大屏在线` : '大屏在线') : '大屏离线';
  }
  const refreshDevices = () => api(`/api/classes/${classId}/devices`).then(list => {
    devices = list; renderOnline();
    if (!splitDrag && !drag) { renderCanvas(); renderStageFoot(); }
  }).catch(() => { });
  // 大屏断开不会有通知：每分钟刷新一次在线状态。
  const devicePoll = setInterval(refreshDevices, 60000);
  onDispose(() => clearInterval(devicePoll));
  function onScreen(ev) {
    const d = devices.find(x => x.id === ev.deviceId);
    if (!d) return refreshDevices();
    Object.assign(d, { screen: ev.screen, screenAt: new Date().toISOString(), online: true, activeProjectId: ev.screen?.activeProjectId ?? d.activeProjectId });
    renderOnline();
    if (screenDevice()?.id === d.id && !splitDrag && !drag) { renderCanvas(); renderStageFoot(); }
  }

  // ---------- 渲染
  function renderAll() { renderBar(); renderBody(); refreshBar(); }
  const schemeChip = () => html`<span class="scheme-chip ${draft?.theme === 'Light' ? 'light' : ''}" aria-hidden="true">${Board.swatches(macaron()).tile.slice(0, 3).map(col => html`<i style="background:${col}"></i>`)}</span>`;
  function renderBar() {
    const list = ordered(), i = list.findIndex(p => p.id === detail?.id), editable = !!draft && !readOnly();
    const deletedCount = projects.filter(p => p.deleted).length;
    bar.innerHTML = show(html`
      <div class="hw-nav">
        <button class="btn ghost sm icon-only" data-hw="prev" ${i > 0 ? '' : 'disabled'} title="上一个项目">${icon('left')}</button>
        <button class="btn sm hw-picker" data-hw="pick" title="选择项目"><span>${detail ? dateLabel(draft ? draft.date || null : detail.date) : '选择项目'}</span>${icon('right', 'sm hw-caret')}</button>
        <button class="btn ghost sm icon-only" data-hw="next" ${i >= 0 && i < list.length - 1 ? '' : 'disabled'} title="下一个项目">${icon('right')}</button>
      </div>
      ${draft ? html`<input class="input hw-name" data-hw-f="name" value="${draft.name}" maxlength="80" aria-label="项目名称" placeholder="项目名称" ${editable ? '' : 'disabled'}>
        <input class="input hw-date" type="date" data-hw-f="date" value="${draft.date}" aria-label="作业日期" title="作业日期" ${editable ? '' : 'disabled'}>`
        : detail ? html`<b class="hw-title">${detail.name}</b>` : ''}
      <span class="conn" id="hw-live" ${liveOn ? 'hidden' : ''}>${icon('alert', 'sm')}连接中断，正在重连</span>
      <span class="spacer"></span>
      ${draft ? html`<div class="segmented" role="tablist" aria-label="视图">${[['canvas', '画布'], ['list', '列表']].map(([k, l]) => html`<button type="button" data-hw="view" data-v="${k}" class="${view === k ? 'active' : ''}">${l}</button>`)}</div>
        <button class="btn sm" data-ed="add-subject" ${editable ? '' : 'disabled'}>${icon('plus')}科目</button>
        <button class="btn sm" data-hw="scheme" ${editable && canBoard ? '' : 'disabled'} title="${canBoard ? '这个项目的主题与色系' : '配色作用于整块大屏，只有班主任和管理员可以修改'}">${schemeChip()}配色</button>
        <button class="btn sm" data-hw="display" title="让班级大屏切换到这个项目">在大屏显示</button>` : ''}
      <button class="btn sm primary" data-hw="new">新建项目</button>
      <button class="btn sm icon-only" data-hw="more" title="更多操作${deletedCount ? `（${deletedCount} 个已删除）` : ''}">${icon('more')}</button>`);
  }
  const renderLive = () => { const el = $('#hw-live', bar); if (el) el.hidden = liveOn; };
  async function displayOnBoard() {
    if (!detail || !draft) return;
    if (dirty()) return toast('先保存当前修改，再在大屏显示', 'error');
    const result = await api(`/api/classes/${classId}/projects/${detail.id}/display`, { method: 'POST' });
    toast(result.delivered ? `大屏正在切换到“${detail.name}”` : '现在没有在线的大屏，大屏连上后再点一次', result.delivered ? 'ok' : 'error');
  }
  function renderBody() {
    unbindRichEditors(body);
    renderLock();
    if (!detail) {
      body.innerHTML = show(html`<div class="card">${empty('book', projects.some(p => !p.deleted) ? '选择一个项目' : '这个班还没有作业项目', '新建一个项目就能直接在磁贴上布置作业，班级大屏同步的项目也会出现在这里。', html`<button class="btn primary" data-hw="new">新建项目</button>`)}</div>`);
      return;
    }
    if (!draft) {
      body.innerHTML = show(html`<div class="banner warn">${icon('trash')}<div class="grow"><b>这个项目已删除</b><div class="muted small">恢复后才能编辑，大屏同步后也会恢复。</div></div><button class="btn sm primary" data-hw="restore">恢复</button></div>
        <div class="card">${renderSubjects(subjectsOf(detail.payloadJson, detail.runs), assetUrl)}</div>`);
      return;
    }
    if (view === 'canvas') {
      body.innerHTML = show(html`<div class="hw-canvas">
        <div class="hw-stage-wrap"><div class="hw-stage" id="hw-stage"></div>
          <div class="hw-stage-foot">
            <div class="hw-layout" id="hw-layout"></div>
            <div class="hw-layout-tools">
              <button type="button" class="btn sm" data-hw="arrange" ${readOnly() ? 'disabled' : ''}>自动排列</button>
              <label class="check"><input type="checkbox" data-grid-snap ${editorSnap ? 'checked' : ''}>吸附网格</label>
              <label class="row">网格 <input class="input sm" type="number" data-grid-size min="16" max="160" step="8" value="${editorGridSize}" aria-label="网格大小"> px</label>
              <span class="spacer"></span>
              <button type="button" class="btn ghost sm" data-hw="keys">操作说明</button>
            </div>
          </div></div>
        <aside class="hw-insp" id="hw-insp"></aside></div>`);
      bindStage($('#hw-stage', body));
      renderCanvas(); renderStageFoot(); renderInspector();
      bindRichEditors($('#hw-insp', body), richOpts);
      $('#hw-insp', body)._rtRefresh?.();
    } else {
      body.innerHTML = show(html`<div class="card hw-list" id="hw-list">${readOnly() ? '' : html`<div class="rt-dock">${richToolbar(defaults.fonts, defaults, macaron())}</div>`}<div class="editor" id="hw-cards" style="${editorStyle}"></div></div>`);
      renderCards();
      bindRichEditors($('#hw-list', body), richOpts);
    }
  }
  const richOpts = {
    getRuns: el => entryAt(el).runs, setRuns: (el, runs) => { entryAt(el).runs = runs; schedule(); }, defaults,
    // 没有点进具体作业时，格式作用于选中磁贴的全部作业。
    fallback: () => view === 'canvas' && selS && !ro(selS) ? $$('#hw-insp .rich[contenteditable=true]', body) : [],
    hint: () => view !== 'canvas' ? '先点一下要设置格式的作业' : !selS ? '先选中一个磁贴' : ro(selS) ? '这个科目由其他老师负责，不能修改' : '这个磁贴还没有文字，先输入作业再设置格式'
  };
  const subjectAt = el => draft.subjects[+el.closest('[data-si]').dataset.si];
  const entryAt = el => subjectAt(el).entries[+el.closest('[data-ei]').dataset.ei];

  function subjectCard(s) {
    const si = draft.subjects.indexOf(s), off = ro(s), color = displayColor(s), idx = Board.presetIndex(s.color);
    return html`<section class="edit-subject ${off ? 'locked' : ''}" style="--subject:${color}" data-si="${si}">
      <div class="edit-subject-head">
        <input class="input" value="${s.name}" data-f="name" maxlength="40" ${off ? 'disabled' : ''} placeholder="科目名称" aria-label="科目名称">
        ${s.locked ? html`<span class="badge" title="由其他老师负责">${icon('lock', 'sm')}只读</span>` : off ? '' : html`<button type="button" class="btn ghost sm icon-only danger" data-ed="del-subject" title="删除科目">${icon('trash')}</button>`}
      </div>
      <div class="accent-pick" role="group" aria-label="科目颜色">
        ${Board.swatches(macaron()).tile.map((col, i) => html`<button type="button" class="accent-swatch ${idx === i ? 'on' : ''}" data-accent="${col}" style="--c:${col}" title="${col}" aria-pressed="${idx === i}" ${off ? 'disabled' : ''}></button>`)}
        <label class="accent-custom ${idx < 0 ? 'on' : ''}" title="自定义颜色"><input type="color" value="${color.slice(0, 7).toLowerCase()}" data-f="color" ${off ? 'disabled' : ''} aria-label="自定义颜色"><span>自定义</span></label>
      </div>
      <div class="edit-entries">
        ${s.entries.map((e, ei) => html`<div class="edit-entry" data-ei="${ei}">
          <span class="num">${ei + 1}</span>
          <div class="grow" style="display:grid;gap:6px">
            <div class="input rich" contenteditable="${off ? 'false' : 'true'}" role="textbox" aria-multiline="true" data-placeholder="作业内容" ${off ? 'aria-disabled="true"' : ''}>${raw(rtHtml(e.runs, true))}</div>
            ${e.hand ? html`<small class="faint">${icon('pen', 'sm')}含手写笔迹，网页上看不到；改文字不影响笔迹。</small>` : ''}
            ${e.atts.length ? html`<div class="attachments">${e.atts.map((a, ai) => {
              const img = assetImage(a, assetUrl);
              return html`<span class="attachment ${img ? 'with-thumb' : ''}">${img ? html`<img src="${img}" alt="">` : icon('clip', 'sm')}<span>${a.name}</span>${off ? '' : html`<button type="button" class="att-x" data-ed="del-att" data-ai="${ai}" title="移除">${icon('x', 'sm')}</button>`}</span>`;
            })}</div>` : ''}
          </div>
          ${off ? '' : html`<div class="edit-entry-actions">
            <button type="button" class="btn ghost sm icon-only" data-ed="add-image" title="添加图片">${icon('image')}</button>
            <button type="button" class="btn ghost sm icon-only danger" data-ed="del-entry" title="删除这一条">${icon('x')}</button></div>`}
        </div>`)}
        ${off ? (s.entries.length ? '' : html`<p class="faint small">还没有作业</p>`) : html`<button type="button" class="btn ghost sm" data-ed="add-entry">${icon('plus')}添加一条</button>`}
      </div>
    </section>`;
  }
  /** 改了科目颜色：只更新色块的选中状态和色条，不重绘检查器（原生取色器可能还开着）。 */
  function markAccent(card, s) {
    const idx = Board.presetIndex(s.color);
    card.style.setProperty('--subject', displayColor(s));
    $$('.accent-swatch', card).forEach((b, i) => { b.classList.toggle('on', i === idx); b.setAttribute('aria-pressed', i === idx); });
    $('.accent-custom', card)?.classList.toggle('on', idx < 0);
  }
  function renderCards() {
    const el = $('#hw-cards', body); if (!el) return;
    el.innerHTML = show(html`${live().map(subjectCard)}${readOnly() ? '' : html`<button type="button" class="btn add-subject" data-ed="add-subject">${icon('plus')}添加科目</button>`}`);
  }
  function renderInspector() {
    const el = $('#hw-insp', body); if (!el) return;
    if (!selS) {
      const subs = live();
      el.innerHTML = show(html`<div class="hw-insp-empty">
        <b>选一个磁贴来编辑</b>
        ${subs.length ? html`<div class="hw-chips">${subs.map((s, i) => html`<button type="button" class="chip" data-pick="${i}" style="--subject:${displayColor(s)}"><i></i>${s.name || '新科目'}${s.locked ? icon('lock', 'sm') : ''}</button>`)}</div>` : html`<span class="muted">这个项目还没有科目。</span>`}
        ${readOnly() ? '' : html`<button type="button" class="btn sm" data-ed="add-subject">${icon('plus')}添加科目</button>`}
        ${allowed ? html`<span class="muted small">你负责：${allowed.names.join('、')}</span>` : ''}
      </div>`);
      return;
    }
    el.innerHTML = show(html`${ro(selS) ? '' : html`<div class="rt-dock">${richToolbar(defaults.fonts, defaults, macaron())}</div>`}
      <div class="hw-insp-body" style="${editorStyle}">${subjectCard(selS)}</div>`);
    el._rtRefresh?.();
  }
  /** 结构改动（增删条目、图片）或换了色系后重绘编辑区。 */
  const renderEditors = () => view === 'canvas' ? renderInspector() : renderCards();

  const tileOf = s => ({
    name: s.name || '新科目', accent: s.color, explicit: s.explicit || s.color !== s.origColor, x: s.rect.x, y: s.rect.y, w: s.rect.w, h: s.rect.h,
    locked: ro(s), cls: [s === selS ? 'sel' : '', s.locked ? 'locked' : '', s.index == null || !sameRect(s.rect, s.origRect) ? 'moved' : ''].join(' '),
    entries: s.entries.map(e => ({ runs: e.runs, images: e.atts.map(a => assetImage(a, assetUrl)).filter(Boolean) }))
  });
  function renderCanvas() {
    const stage = $('#hw-stage', body); if (!stage || !draft) return;
    const g = geometry();
    // 编辑器可临时调整网格大小和吸附，只改本地显示，不动班级布局；主题与色系用项目自己的。
    const viewDoc = { ...boardDoc, LayoutMode: g.mode, Theme: draft.theme, Palette: draft.palette, GridSize: editorGridSize, GridSnappingEnabled: editorSnap };
    const t = Board.theme(viewDoc);
    stage.classList.toggle('pk-interactive', !readOnly());
    Board.mount(stage, Board.screen(viewDoc, t, g.W, g.H, {
      tiles: live().map(tileOf), interactive: !readOnly(), editing: true, assetUrl, regions: g,
      splitHandle: canBoard && layoutSnap.policy !== 'Off' && g.mode === 'Split', labels: splitPreview != null,
      placeholder: `<div class="pk-center" style="color:${t.text};opacity:.5;font-size:28px">点上方的“科目”添加第一个磁贴</div>`
    }), viewDoc);
  }
  /** 画布下方的布局栏：布局模式、各区域尺寸，以及尺寸来自哪块大屏。 */
  function renderStageFoot() {
    const el = $('#hw-layout', body); if (!el || !draft) return;
    const g = geometry(), off = layoutSnap.policy === 'Off', editable = canBoard && !off;
    const mode = off && g.live ? g.mode : boardDoc.LayoutMode || 'Split';
    const dims = r => r ? `${Math.round(r.w)} × ${Math.round(r.h)}` : '—';
    const ratio = Math.round((splitPreview ?? (g.live ? g.device.screen.splitRatio : Board.SPLIT(boardDoc))) * 100);
    const readout = g.mode === 'Split' ? html`<span>时钟区 <b>${ratio}%</b>，${dims(g.clock)}</span><span>作业区 ${dims(g.board)}</span>`
      : g.mode === 'Clock' ? html`<span>仅时钟：大屏不显示作业，切到列表可以继续编辑</span>`
        : html`<span>作业区 ${dims(g.board)}</span>`;
    const name = g.device ? `“${g.device.deviceName}”` : '';
    const source = off ? '本班没有同步布局，这里显示大屏自己的分区，调整不会下发'
      : !canBoard ? '布局作用于整块大屏，只有班主任和管理员可以调整'
        : g.live ? (g.device.online ? `大屏${name}的实时尺寸` : `大屏${name}最近上报的尺寸（大屏离线）`)
          : g.device ? `大屏${name}还没应用新布局，先按它的屏幕估算` : '大屏还没上报屏幕尺寸，先按 1600 × 900 估算';
    const reporting = devices.filter(d => d.screen && !d.revoked);
    el.innerHTML = show(html`
      <div class="segmented sm" role="radiogroup" aria-label="布局模式">${LAYOUT_MODES.map(([k, l]) => html`<button type="button" role="radio" aria-checked="${mode === k}" data-layout-mode="${k}" class="${mode === k ? 'active' : ''}" ${editable ? '' : 'disabled'}>${l}</button>`)}</div>
      <div class="hw-readout">${readout}</div>
      ${reporting.length > 1 ? html`<select class="input sm hw-screen" data-screen aria-label="按哪块大屏的屏幕显示">${reporting.map(d => html`<option value="${d.id}" ${d.id === g.device?.id ? 'selected' : ''}>${d.deviceName}${d.online ? '' : '（离线）'}</option>`)}</select>` : ''}
      <span class="hw-source ${g.live ? '' : 'estimate'}">${source}</span>`);
  }
  let canvasQueued = false;
  const scheduleCanvas = () => { if (canvasQueued) return; canvasQueued = true; requestAnimationFrame(() => { canvasQueued = false; renderCanvas(); }); };
  function schedule() { refreshBar(); scheduleCanvas(); }
  function refreshBar() {
    const el = $('#hw-save', root), on = dirty();
    el.hidden = !on && !saving;
    syncLock();
    if (el.hidden) return;
    const blocked = readOnly();
    el.innerHTML = show(html`${icon('edit', 'sm')}<span class="grow">${saving ? '正在保存…' : blocked ? '有未保存的修改，等对方结束编辑后才能保存' : '有未保存的修改'}</span>
      <button type="button" class="btn sm ghost" data-hw="discard" ${saving ? 'disabled' : ''}>撤销修改</button>
      <button type="button" class="btn sm primary" data-hw="save" ${saving || blocked ? 'disabled' : ''} title="Ctrl + S">保存</button>`);
  }
  function select(s, focusEntry = false) {
    selS = s;
    const stage = $('#hw-stage', body), subs = live();
    if (stage) $$('.pk-tile', stage).forEach((el, i) => el.classList.toggle('sel', subs[i] === s));
    renderInspector();
    if (focusEntry && s && !ro(s)) {
      const el = $('#hw-insp .rich[contenteditable=true]', body);
      if (el) { el.focus(); const n = rtPlain(rtExtract(el)).length; rtSetSelection(el, n, n); }
    }
  }
  function addSubject() {
    if (!draft || readOnly()) return;
    const used = new Set(live().map(s => s.color));
    const rect = freeSpot();
    const s = { index: null, name: '', color: TILE_COLORS.find(x => !used.has(x)) || TILE_COLORS[0], origColor: '', explicit: false, locked: false, removed: false, rect, origRect: null, entries: [{ index: null, runs: [], atts: [] }] };
    draft.subjects.push(s);
    if (view === 'canvas') { selS = s; renderCanvas(); renderInspector(); $('#hw-insp [data-f=name]', body)?.focus(); }
    else { renderCards(); $(`[data-si="${draft.subjects.indexOf(s)}"] [data-f=name]`, body)?.focus(); }
    refreshBar();
  }
  function removeSubject(s) {
    s.removed = true;
    if (selS === s) selS = null;
    if (view === 'canvas') { renderCanvas(); renderInspector(); } else renderCards();
    refreshBar();
    toast(`已移除“${s.name || '新科目'}”，保存后生效`, 'ok', { action: '撤销', onAction: () => { s.removed = false; if (view === 'canvas') { selS = s; renderCanvas(); renderInspector(); } else renderCards(); refreshBar(); } });
  }
  function autoArrange() {
    if (readOnly()) return;
    const placed = live().filter(s => s.locked), g = gridSize(), width = bounds().vw;
    for (const s of live().filter(s => !s.locked)) {
      let found = false;
      for (let y = g; y < 4000 && !found; y += g)
        for (let x = g; x + s.rect.w <= Math.max(width, s.rect.w + g); x += g)
          if (!placed.some(o => x < o.rect.x + o.rect.w && o.rect.x < x + s.rect.w && y < o.rect.y + o.rect.h && o.rect.y < y + s.rect.h)) {
            s.rect.x = x; s.rect.y = y; found = true; break;
          }
      placed.push(s);
    }
    selS = null; renderCanvas(); renderInspector(); refreshBar();
  }

  // ---------- 画布拖动：磁贴、八方向缩放与分隔条
  function bindStage(stage) {
    const scenePoint = e => { const r = $('.pk-scene', stage).getBoundingClientRect(), k = stage._pkScale || 1; return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }; };
    // 磁贴坐标相对作业区，作业区在整屏里的位置来自分区。
    const boardPoint = e => { const p = scenePoint(e), b = geometry().board || { x: 0, y: 0 }; return { x: p.x - b.x, y: p.y - b.y }; };
    stage.addEventListener('pointerdown', e => {
      if (e.target.closest('[data-split]')) {
        splitDrag = { from: Board.SPLIT(boardDoc) }; splitPreview = splitDrag.from;
        stage.setPointerCapture(e.pointerId); e.preventDefault();
        return;
      }
      const tileEl = e.target.closest('[data-tile]');
      if (!tileEl) { if (selS) select(null); return; }
      const i = +tileEl.dataset.tile, s = live()[i];
      if (s !== selS) select(s);
      if (ro(s)) return;
      const grip = e.target.closest('[data-grip]')?.dataset.grip || '';
      drag = { i, s, grip, p: boardPoint(e), r: { ...s.rect }, moved: false };
      stage.setPointerCapture(e.pointerId); e.preventDefault();
    });
    stage.addEventListener('pointermove', e => {
      if (splitDrag) {
        const next = Math.round(Math.min(.9, Math.max(.1, scenePoint(e).x / geometry().W)) * 100) / 100;
        if (next !== splitPreview) { splitPreview = next; scheduleCanvas(); renderStageFoot(); }
        return;
      }
      if (!drag) return;
      const p = boardPoint(e), dx = p.x - drag.p.x, dy = p.y - drag.p.y, r = drag.s.rect, o = drag.r, g = drag.grip, { w: bw, h: bh } = bounds();
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true;
      if (!g) {
        r.x = Math.max(0, Math.min(bw - o.w, snap(o.x + dx)));
        r.y = Math.max(0, Math.min(bh - o.h, snap(o.y + dy)));
      } else {
        let left = o.x, top = o.y, right = o.x + o.w, bottom = o.y + o.h;
        if (g.includes('e')) right = Math.max(left + TILE_MIN.w, Math.min(Math.min(bw, left + TILE_MAX.w), snap(right + dx)));
        if (g.includes('s')) bottom = Math.max(top + TILE_MIN.h, Math.min(Math.min(bh, top + TILE_MAX.h), snap(bottom + dy)));
        if (g.includes('w')) left = Math.min(right - TILE_MIN.w, Math.max(Math.max(0, right - TILE_MAX.w), snap(left + dx)));
        if (g.includes('n')) top = Math.min(bottom - TILE_MIN.h, Math.max(Math.max(0, bottom - TILE_MAX.h), snap(top + dy)));
        r.x = left; r.y = top; r.w = right - left; r.h = bottom - top;
      }
      const el = stage.querySelector(`[data-tile="${drag.i}"]`);
      if (el) { Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' }); el.classList.add('moved'); }
    });
    const end = () => {
      if (splitDrag) {
        const { from } = splitDrag, to = splitPreview; splitDrag = null;
        if (to != null && Math.abs(to - from) >= .005) commitLayout({ SplitRatio: to });
        else { splitPreview = null; renderCanvas(); renderStageFoot(); }
        return;
      }
      if (!drag) return;
      const moved = drag.moved; drag = null; if (moved) schedule();
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('dblclick', e => { const t = e.target.closest('[data-tile]'); if (t) select(live()[+t.dataset.tile], true); });
  }

  // ---------- 浮层：配色、操作说明、项目选择、更多操作
  function openScheme(anchor) {
    if (!draft || !anchor) return;
    const el = popover(anchor, html`<div class="scheme">
      <div class="scheme-row"><span>主题</span><div class="segmented sm">${THEMES.map(([k, l]) => html`<button type="button" data-theme="${k}" class="${draft.theme === k ? 'active' : ''}">${l}</button>`)}</div></div>
      <div class="scheme-row"><span>色系</span><div class="segmented sm">${PALETTES.map(([k, l]) => html`<button type="button" data-palette="${k}" class="${draft.palette === k ? 'active' : ''}">${l}</button>`)}</div></div>
      <div class="scheme-swatches" aria-hidden="true">${Board.swatches(macaron()).tile.map(col => html`<i style="background:${col}"></i>`)}</div>
      <p class="faint small">配色跟着这个项目保存，大屏切到这个项目时换上。已设置的文字颜色不受影响。</p>
    </div>`, 'scheme-pop', 'right');
    el.onclick = e => {
      const b = e.target.closest('[data-theme],[data-palette]'); if (!b) return;
      if (b.dataset.theme) draft.theme = b.dataset.theme; else draft.palette = b.dataset.palette;
      // 色卡要换成新色系：画布、检查器（或列表的工具栏）都重绘。
      renderBar();
      if (view === 'canvas') renderInspector(); else renderBody();
      schedule();
      openScheme($('[data-hw=scheme]', bar));
    };
  }
  function openKeys(anchor) {
    popover(anchor, html`<dl class="keys">
      <dt>拖动磁贴</dt><dd>移动位置</dd>
      <dt>拖动边角</dt><dd>调整大小</dd>
      <dt>双击磁贴</dt><dd>直接输入作业</dd>
      <dt>方向键</dt><dd>微调位置，按住 Shift 移动一格</dd>
      <dt>Delete</dt><dd>删除选中的磁贴</dd>
      <dt>拖动分隔条</dt><dd>调整时钟区和作业区的宽度</dd>
      <dt>Ctrl + S</dt><dd>保存</dd>
    </dl>`, 'keys-pop', 'right');
  }
  function openPicker(anchor) {
    const el = popover(anchor, html`<label class="input-icon">${icon('search', 'sm')}<input class="input" placeholder="搜索项目或日期" autocomplete="off"></label><div class="hw-picker-list"></div>`, 'hw-pick', 'left');
    const listEl = $('.hw-picker-list', el), q = $('input', el);
    const draw = () => {
      const v = q.value.trim().toLowerCase();
      const items = projects.filter(p => (showDeleted || !p.deleted) && (!v || p.name.toLowerCase().includes(v) || (p.date || '').includes(v) || dateLabel(p.date).includes(v)));
      listEl.innerHTML = show(items.length ? projectGroups(items, p => html`<button type="button" class="project-item ${p.id === detail?.id ? 'active' : ''} ${p.deleted ? 'deleted' : ''}" data-id="${p.id}">
          <span class="name">${p.name}${p.deleted ? html`<span class="tag danger">已删除</span>` : ''}${locks.get(p.id)?.holder === 'device' ? html`<span class="tag">大屏编辑中</span>` : ''}</span><span class="meta">${relTime(p.updatedAt)}更新${p.updatedBy ? `，${p.updatedBy}` : ''}</span></button>`)
        : html`<p class="faint" style="padding:12px">没有匹配的项目</p>`);
    };
    draw(); q.oninput = draw; q.focus();
    listEl.onclick = e => { const b = e.target.closest('[data-id]'); if (!b) return; closeMenu(); switchTo(b.dataset.id).catch(fail); };
  }
  function moreItems() {
    const peers = (state.classes || []).filter(x => c.groupId && x.groupId === c.groupId && x.id !== classId);
    const current = detail ? [
      { label: '复制作业文本', icon: 'copy', run: () => copyText(homeworkText({ name: draft?.name || detail.name, date: draft ? draft.date || null : detail.date }, draft ? viewSubjects() : subjectsOf(detail.payloadJson, detail.runs)), '作业文本已复制') },
      ...(draft && peers.length ? [{ label: `复制到${c.groupName}的其他班级…`, icon: 'share', run: copyToGroup }] : []),
      { label: '打印', icon: 'print', run: printProject },
      { label: '历史版本', icon: 'history', run: () => openHistory(classId, { id: detail.id, name: detail.name }, async () => { base = snapshot(); await refreshProjects(); await open(detail.id); }, assetUrl) }
    ] : [];
    return [
      { label: '选择模板新建…', icon: 'plus', run: newFromTemplate },
      null, ...current,
      { label: `显示已删除的项目（${projects.filter(p => p.deleted).length}）`, checked: showDeleted, run: () => { showDeleted = !showDeleted; renderBar(); } },
      { label: '导出全部项目 JSON', icon: 'download', run: () => download(`/api/classes/${classId}/export`) },
      ...(draft && !readOnly() ? [null, { label: '删除项目', icon: 'trash', danger: true, run: deleteProject }] : [])
    ];
  }
  /** 按组批量布置：把当前项目已布置的科目写进同组其他班级同一天的项目。有未保存的修改时先保存。 */
  async function copyToGroup() {
    const peers = (state.classes || []).filter(x => c.groupId && x.groupId === c.groupId && x.id !== classId);
    const subs = live().filter(s => s.name.trim() && s.entries.some(e => rtPlain(e.runs).trim() || e.atts.length || e.hand));
    if (!subs.length) return toast('这个项目还没有布置作业', 'error');
    const result = await modal({
      title: `复制到${c.groupName}的其他班级`, submit: '复制', wide: true,
      body: html`<div class="field"><span>复制到</span><div class="checklist">${peers.map(p => html`<label class="check"><input type="checkbox" name="cls" value="${p.id}" checked>${p.name}</label>`)}</div></div>
        <div class="field"><span>科目</span><div class="checklist">${subs.map(s => html`<label class="check"><input type="checkbox" name="sub" value="${s.name.trim()}" ${can(s.name) ? 'checked' : ''}>${s.name}</label>`)}</div></div>
        <p class="faint small">写进各班同一天的项目：同名科目的作业会被替换，没有的科目新增磁贴；还没有当天项目的班级会新建一个。</p>`,
      onSubmit: async f => {
        const classIds = $$('input[name=cls]:checked', f).map(x => x.value), subjects = $$('input[name=sub]:checked', f).map(x => x.value);
        if (!classIds.length) throw new Error('至少选一个班级');
        if (!subjects.length) throw new Error('至少选一个科目');
        if (dirty()) { await save(); if (dirty()) throw new Error('当前修改还没保存成功，处理好再复制'); }
        return api(`/api/classes/${classId}/projects/${detail.id}/copy-to`, { method: 'POST', body: { classIds, subjects } });
      }
    });
    if (!Array.isArray(result)) return;
    await modal({
      title: '复制结果', submit: '', cancel: '完成',
      body: html`<ul class="copy-result">${result.map(r => html`<li class="${r.error ? 'bad' : ''}"><b>${r.className}</b><span>${r.error
        || `${r.created ? '新建了当天的项目，' : ''}写入${r.copied.join('、')}${r.skipped.length ? `；${r.skipped.join('、')}没有权限，已跳过` : ''}`}</span></li>`)}</ul>`
    });
  }
  function printProject() {
    const name = draft?.name || detail.name, date = draft ? draft.date || null : detail.date;
    $('#hw-print', root).innerHTML = show(html`<h2 style="margin:0 0 4px">${name}</h2><p class="muted" style="margin-bottom:12px">${dateLabel(date, true)}</p>${renderSubjects(draft ? viewSubjects() : subjectsOf(detail.payloadJson, detail.runs), assetUrl)}`);
    print();
  }

  // ---------- 事件
  root.addEventListener('input', e => {
    const el = e.target;
    if (el.matches('[data-grid-size]')) {
      if (el.value !== '' && Number.isFinite(+el.value)) { editorGridSize = Math.max(16, Math.min(160, +el.value)); store.set('hwGridSize', editorGridSize); renderCanvas(); }
      return;
    }
    const hf = el.dataset.hwF, f = el.dataset.f;
    if (hf === 'name') draft.name = el.value;
    else if (hf === 'date') { draft.date = el.value; $('.hw-picker span', bar).textContent = dateLabel(el.value || null); }
    else if (f === 'name') subjectAt(el).name = el.value;
    else if (f === 'color') { const s = subjectAt(el); s.color = el.value.toUpperCase(); s.explicit = true; markAccent(el.closest('.edit-subject'), s); }
    else return;
    schedule();
  });
  root.addEventListener('change', e => {
    if (e.target.matches('[data-grid-snap]')) { editorSnap = e.target.checked; store.set('hwGridSnap', editorSnap); }
    if (e.target.matches('[data-grid-size]')) e.target.value = editorGridSize;
    if (e.target.matches('[data-screen]')) { screenId = e.target.value; store.set('hwScreen.' + classId, screenId); renderCanvas(); renderStageFoot(); }
  });
  root.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset.hwF === 'name') e.target.blur(); });
  root.addEventListener('click', async e => {
    const pickEl = e.target.closest('[data-pick]');
    if (pickEl) return select(live()[+pickEl.dataset.pick], true);
    const swatch = e.target.closest('[data-accent]');
    if (swatch) {
      const s = subjectAt(swatch); if (ro(s)) return;
      s.color = swatch.dataset.accent.toUpperCase(); s.explicit = true;
      markAccent(swatch.closest('.edit-subject'), s); schedule();
      return;
    }
    const mode = e.target.closest('[data-layout-mode]');
    if (mode) { if (mode.dataset.layoutMode !== (boardDoc.LayoutMode || 'Split')) await commitLayout({ LayoutMode: mode.dataset.layoutMode }); return; }
    const hw = e.target.closest('[data-hw]');
    if (hw) {
      const list = ordered(), i = list.findIndex(p => p.id === detail?.id);
      try {
        switch (hw.dataset.hw) {
          case 'prev': return await switchTo(list[i - 1]?.id);
          case 'next': return await switchTo(list[i + 1]?.id);
          case 'pick': return openPicker(hw);
          case 'new': return await newProject();
          case 'more': return openMenu(hw, moreItems());
          case 'save': return await save();
          case 'discard': return discard();
          case 'restore': return await restoreProject();
          case 'display': return await displayOnBoard();
          case 'arrange': return autoArrange();
          case 'scheme': return openScheme(hw);
          case 'keys': return openKeys(hw);
          case 'end-edit': return await endBoardEdit();
          case 'force': return await forceEdit();
          case 'view': view = hw.dataset.v; store.set('hwView', view); renderBar(); renderBody(); return;
        }
      } catch (err) { fail(err); }
      return;
    }
    const b = e.target.closest('[data-ed]'); if (!b) return;
    const act = b.dataset.ed;
    if (act === 'add-subject') return addSubject();
    if (readOnly()) return;
    if (act === 'del-subject') return removeSubject(subjectAt(b));
    if (act === 'add-entry') { const s = subjectAt(b); s.entries.push({ index: null, runs: [], atts: [] }); renderEditors(); schedule(); $$(`[data-si="${draft.subjects.indexOf(s)}"] .rich`, body).pop()?.focus(); return; }
    if (act === 'del-entry') { subjectAt(b).entries.splice(+b.closest('[data-ei]').dataset.ei, 1); renderEditors(); schedule(); return; }
    if (act === 'del-att') { entryAt(b).atts.splice(+b.dataset.ai, 1); renderEditors(); schedule(); return; }
    if (act === 'add-image') return pickImages(entryAt(b));
  });
  const keys = new AbortController();
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!$('dialog[open]')) save().catch(fail); return; }
    if (view !== 'canvas' || !selS || !draft || $('dialog[open]') || $('.menu')) return;
    if (e.target.closest?.('input,textarea,select,[contenteditable=true]')) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.key === 'Escape') return select(null);
    if (ro(selS)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return removeSubject(selS); }
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (d) {
      e.preventDefault();
      const step = e.shiftKey ? gridSize() : 4, { w, h } = bounds(), r = selS.rect;
      r.x = Math.max(0, Math.min(w - r.w, r.x + d[0] * step)); r.y = Math.max(0, Math.min(h - r.h, r.y + d[1] * step));
      schedule();
    }
  }, { signal: keys.signal });
  onDispose(() => keys.abort());

  const pickImages = entry => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
    input.onchange = async () => {
      for (const file of input.files) {
        if (file.size > 50 * 1024 * 1024) { toast(`“${file.name}”超过 50 MB`, 'error'); continue; }
        uploading++;
        try {
          const r = await fetch(`/api/classes/${classId}/assets?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { authorization: 'Bearer ' + state.token }, body: file });
          if (!r.ok) throw new Error((await r.text().catch(() => '')).replace(/^"|"$/g, '') || '上传失败');
          entry.atts.push({ index: null, name: file.name, path: (await r.json()).reference, kind: '图片' });
        } catch (err) { toast(`图片上传失败：${err.message}`, 'error'); }
        finally { uploading--; }
      }
      renderEditors(); schedule();
    };
    input.click();
  };

  // ---------- 实时：项目、编辑占用、屏幕与布局
  function onEditing(ev) {
    const before = locks.get(ev.projectId);
    if (ev.lock) locks.set(ev.projectId, ev.lock); else locks.delete(ev.projectId);
    if (ev.projectId !== detail?.id) return;
    if (mine(before) && !mine(ev.lock)) lockHeld = lockForced = false;
    const was = !!before && !mine(before), now = !!ev.lock && !mine(ev.lock);
    if (endWait && !now) { endWait = null; clearTimeout(endTimer); toast('大屏已保存并退出编辑，可以修改了'); }
    if (was !== now) renderAll(); else renderLock();
  }
  const reloadLocks = () => api(`/api/classes/${classId}/edit-locks`).then(list => {
    const was = readOnly();
    locks.clear(); for (const l of list) locks.set(l.projectId, l);
    // 服务重启后占用都没了：下次修改时会重新占用。
    if (lockHeld && !mine(locks.get(detail?.id))) lockHeld = lockForced = false;
    if (was !== readOnly()) renderAll(); else renderLock();
  }).catch(() => { });
  let remoteTimer, connected = false;
  onDispose(liveSocket(`/ws/classes/${classId}?access_token=${encodeURIComponent(state.token)}`, ev => {
    if (ev.type === 'editing') return onEditing(ev);
    if (ev.type === 'screen') return onScreen(ev);
    if (ev.type === 'layout') return scheduleLayout();
    if (ev.type && !['updated', 'deleted'].includes(ev.type)) return;
    // 大屏或其他老师改了项目：没有未保存的修改时直接载入，否则提醒。
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(async () => {
      await refreshProjects().catch(() => { });
      if (!detail || ev.projectId !== detail.id || Date.now() - savedAt < 4000) return;
      const who = ev.sourceDeviceId ? '大屏' : '其他老师';
      if (dirty()) toast(`${who}刚改了这个项目，保存时会提示冲突`, 'error');
      else if (!drag) { const f = captureFocus(); await open(detail.id, true); restoreFocus(f); toast(`已载入${who}的修改`); }
    }, 400);
  }, on => {
    liveOn = on; renderLive();
    // 重连后补上断线期间漏掉的占用、屏幕与布局变化。
    if (on && connected) { reloadLocks(); refreshDevices(); scheduleLayout(); }
    if (on) connected = true;
  }));
  onDispose(() => clearTimeout(remoteTimer));
  Board.fontsReady.then(() => { if (view === 'canvas') renderCanvas(); });
  renderOnline();

  let id = byId(projectId) ? projectId : defaultProject(projects)?.id;
  if (id && id !== projectId) setHash(`classes/${classId}/homework/${id}`, true);
  await open(id);
  if (query?.get('new')) { setHash(`classes/${classId}/homework${id ? '/' + id : ''}`, true); await newProject(); }
}

// ============================================================ 启动
(function start() {
  const code = new URLSearchParams(location.search).get('code');
  if (code) { history.replaceState(null, '', location.pathname + '#/c/' + encodeURIComponent(code.trim().toLowerCase())); }
  route();
})();
