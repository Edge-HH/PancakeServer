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
  return long ? `${base} ${w}${rel ? ' · ' + rel : ''}` : rel ? `${rel} · ${m}月${d}日` : `${base} ${w}`;
}
function duration(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
}

const roleLabel = r => r === 'Administrator' ? '管理员' : r === 'Teacher' ? '老师' : r;
function avatar(name, cls = '') {
  let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return html`<span class="avatar ${cls}" style="background:hsl(${h} 45% 47%)">${String(name || '?').trim().charAt(0).toUpperCase()}</span>`;
}
function randomPassword() {
  const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map(b => a[b % a.length]).join('');
}
async function copyText(text, label = '已复制') {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
  }
  toast(label);
}

// ============================================================ 主题
const theme = {
  get: () => { try { return localStorage.getItem('pancake.theme') || 'system'; } catch { return 'system'; } },
  set(v) { try { localStorage.setItem('pancake.theme', v); } catch { } theme.apply(); },
  apply() {
    const t = theme.get();
    const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  },
  toggle() { theme.set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); }
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', theme.apply);

// ============================================================ 接口
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const STATUS_TEXT = { 400: '请求无效', 401: '需要登录', 403: '没有权限执行此操作', 404: '内容不存在或已删除', 409: '数据冲突，请刷新后重试', 429: '操作过于频繁，请稍后再试', 500: '服务器内部错误' };
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
    let msg = '';
    try { const t = await r.text(); try { const j = JSON.parse(t); msg = typeof j === 'string' ? j : (j.detail || j.error || ''); } catch { msg = t.length < 200 ? t : ''; } } catch { }
    throw new ApiError(r.status, msg || STATUS_TEXT[r.status] || `请求失败（${r.status}）`);
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

function clearSession() { state.token = ''; state.me = null; state.classes = null; myAssignments = null; store.del('token'); }
/** 可管理的班级列表（侧栏班级切换器用），新建、改名、删除班级后置空重新拉取。 */
async function classList() { if (!state.classes) state.classes = await api('/api/classes').catch(() => []); return state.classes; }
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
  'toggle-theme': () => theme.toggle(),
  'logout': async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch { } clearSession(); navigate(''); toast('已退出登录'); },
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
  [/^overview$/, viewOverview],
  [/^classes$/, viewClasses],
  [/^classes\/([\w-]+)(?:\/(\w+))?(?:\/([\w-]+))?$/, viewClass],
  // 旧地址：作业与公告已并入班级。
  [/^homework(?:\/([\w-]+))?(?:\/([\w-]+))?$/, (c, p) => toClass(c, p ? 'homework/' + p : 'homework')],
  [/^announcements$/, () => toClass(null, 'notices')],
  [/^users$/, viewUsers, { admin: true }],
  [/^audit$/, viewAudit, { admin: true }],
  [/^settings$/, viewSettings]
];
let routeToken = 0;
/** 当前视图的局部刷新：重新拉数据后原地替换内容，不重建页面框架。 */
let reloadView = () => route();
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
  disposers.forEach(fn => { try { fn(); } catch { } }); disposers = []; viewActions = {}; reloadView = () => route();
  $('.drawer')?.remove(); $('.scrim')?.remove(); closeMenu();
  const [path, qs] = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('?');
  const query = new URLSearchParams(qs || '');
  for (const [re, fn, opt = {}] of routes) {
    const m = path.match(re); if (!m) continue;
    if (!opt.public && !await ensureMe()) return navigate('login?next=' + encodeURIComponent(path));
    if (opt.admin && !isAdmin()) return navigate('overview');
    if (!opt.public) await classList();
    if (token !== routeToken) return;
    try { await fn(...m.slice(1), query); } catch (err) { if (err.status !== 401) renderError(err); }
    finally { if (token === routeToken) document.body.classList.remove('routing'); }
    return;
  }
  navigate(state.token ? 'overview' : '');
}
window.addEventListener('hashchange', route);
window.addEventListener('scroll', () => $('.topbar')?.classList.toggle('scrolled', scrollY > 4), { passive: true });

function renderError(err) {
  const target = $('#page') || $('#app');
  target.innerHTML = show(html`<div class="empty">${icon('alert')}<b>出错了</b><span>${err.message}</span><button class="btn" style="margin-top:10px" onclick="location.reload()">${icon('refresh')}重新加载</button></div>`);
}

// ============================================================ 应用框架
/** 班级内的分区：侧栏按“日常 / 管理”两组排列。 */
const CLASS_SECTIONS = [
  ['日常', [['homework', 'book', '作业'], ['notices', 'megaphone', '公告'], ['duty', 'broom', '值日']]],
  ['管理', [['people', 'users', '人员'], ['devices', 'device', '设备'], ['layout', 'layout', '大屏设置'], ['settings', 'settings', '班级设置']]]
];
const SECTION_LABEL = Object.fromEntries(CLASS_SECTIONS.flatMap(([, items]) => items.map(([k, , l]) => [k, l])));

/** nav：全局页面的键；classId + section：班级内的分区。 */
function shell({ nav, title, crumbs, actions = '', classId = null, section = null }) {
  const me = state.me, classes = state.classes || [];
  const cid = classId || lastClassId();
  const link = (key, href, ic, label, extra = '') => html`<a href="#/${href}" class="${nav === key ? 'active' : ''}">${icon(ic)}<span>${label}</span>${extra}</a>`;
  $('#app').innerHTML = show(html`<div class="shell">
    <aside class="sidebar">
      <a class="brand" href="#/overview">${logo()}<div><b>Pancake 集控</b><small>班级作业同步中心</small></div></a>
      <nav class="nav">
        ${cid ? html`<label class="class-switch" title="切换班级">${icon('class', 'sm')}<select id="class-switch" aria-label="当前班级">${classes.map(c => html`<option value="${c.id}" ${c.id === cid ? 'selected' : ''}>${c.name}</option>`)}</select></label>
          ${CLASS_SECTIONS.map(([group, items]) => html`<div class="nav-label">${group}</div>${items.map(([k, ic, label]) => html`<a href="#/classes/${cid}/${k}" class="${section === k ? 'active' : ''}">${icon(ic)}<span>${label}</span></a>`)}`)}` : ''}
        <div class="nav-label">${cid ? '全局' : '导航'}</div>
        ${link('overview', 'overview', 'home', '概览')}
        ${link('classes', 'classes', 'class', isAdmin() ? '全部班级' : '我的班级')}
        ${isAdmin() ? html`${link('users', 'users', 'users', '账号')}${link('audit', 'audit', 'log', '操作日志')}` : ''}
        ${link('settings', 'settings', 'settings', '个人设置')}
      </nav>
      <div class="sidebar-foot">
        <div class="user-card">${avatar(me.displayName)}<div class="grow"><b>${me.displayName}</b><span>${roleLabel(me.role)} · ${me.userName}</span></div></div>
        <div class="row">
          <button class="btn ghost sm grow" data-act="toggle-theme" title="切换深浅色">${icon('moon')}<span>主题</span></button>
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
  if (sw) sw.onchange = () => navigate(`classes/${sw.value}/${section || 'homework'}`);
  return $('#page');
}
const setPage = (el, content) => { el.innerHTML = show(content); };
const loading = () => html`<div class="card card-body stack"><div class="skeleton" style="width:40%"></div><div class="skeleton"></div><div class="skeleton" style="width:70%"></div></div>`;
// ---------- 人员与班务通用
const DUTY_LABEL = { HeadTeacher: '班主任', SubjectTeacher: '科任老师', Assistant: '助教' };
const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const LEVEL_LABEL = { info: '普通', important: '重要', urgent: '紧急' };
const levelBadge = l => html`<span class="badge ${l === 'urgent' ? 'danger' : l === 'important' ? 'warn' : 'info'}">${LEVEL_LABEL[l] || l}</span>`;
let myAssignments = null;
async function assignments() { if (!myAssignments) myAssignments = await api('/api/me/assignments').catch(() => []); return myAssignments; }
/** 当前用户在班级里的身份：管理员返回 Administrator，老师返回职务，未分配返回 null。 */
async function myDuty(classId) { if (isAdmin()) return 'Administrator'; return (await assignments()).find(a => a.classId === classId)?.duty || null; }
/** 网页编辑作业时允许改动的科目（小写）；null 表示不限。 */
async function editableSubjects(classId) {
  if (isAdmin()) return null;
  const a = (await assignments()).find(x => x.classId === classId);
  if (!a || a.duty === 'HeadTeacher' || !a.subjects.length) return null;
  const set = new Set(a.subjects.map(x => x.trim().toLowerCase()));
  set.names = a.subjects;
  return set;
}
const shortId = () => Math.random().toString(36).slice(2, 10);
const consoleAsset = classId => sha => `/api/classes/${classId}/assets/${sha}?access_token=${encodeURIComponent(state.token)}`;
/** 多选对话框：返回选中的 value 数组，取消返回 undefined。 */
function checklistModal({ title, items, selected = [], submit = '确定', hint = '', emptyText = '没有可选项。' }) {
  return modal({
    title, submit,
    body: html`${hint ? html`<p class="muted">${hint}</p>` : ''}
      ${items.length ? html`<label class="input-icon">${icon('search', 'sm')}<input class="input" data-filter placeholder="筛选"></label>
      <div class="checklist tall">${items.map(i => html`<label class="check" data-label="${i.label.toLowerCase()}"><input type="checkbox" value="${i.value}" ${selected.includes(i.value) ? 'checked' : ''}>${i.label}${i.sub ? html`<span class="faint" style="font-size:12px">${i.sub}</span>` : ''}</label>`)}</div>
      <div class="row"><button type="button" class="btn ghost sm" data-all>全选</button><button type="button" class="btn ghost sm" data-none>全不选</button></div>` : html`<p class="faint">${emptyText}</p>`}`,
    onMount: f => {
      const filter = $('[data-filter]', f);
      if (filter) filter.oninput = () => $$('.checklist label', f).forEach(l => l.classList.toggle('hidden', !l.dataset.label.includes(filter.value.trim().toLowerCase())));
      const all = $('[data-all]', f), none = $('[data-none]', f);
      if (all) all.onclick = () => $$('.checklist label:not(.hidden) input', f).forEach(x => x.checked = true);
      if (none) none.onclick = () => $$('.checklist input', f).forEach(x => x.checked = false);
    },
    onSubmit: f => $$('.checklist input:checked', f).map(x => x.value)
  });
}
const progress = (value, max) => html`<span class="progress"><span style="width:${max ? Math.round(value / max * 100) : 0}%"></span></span>`;

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
/** 展示用：只保留有内容的作业条目。 */
const subjectsOf = (payloadJson, runs) => parseProject(payloadJson, runs).map(s => ({ ...s, entries: s.entries.filter(e => e.text || e.hand || e.atts.length) }));
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
const RT_COLORS = ['#FBBF24', '#F87171', '#60A5FA', '#4ADE80', '#F472B6'];
const RT_HIGHLIGHTS = ['#F7F7F9', '#FBBF24', '#F87171', '#60A5FA', '#4ADE80', '#F472B6'];
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
 * 富文本工具栏：字体、字号、粗体、斜体、下划线、文字颜色与高光，色板与大屏一致。
 * 作用于最近一次获得焦点的编辑框中的选区；onChange(editor) 在格式改变后调用。
 */
function richToolbar(fonts, defaults) {
  const fontOptions = [...new Set([defaults.fontFamily, ...fonts].filter(Boolean))];
  return html`<div class="rt-toolbar" role="toolbar" aria-label="文字格式">
    <select class="input sm" data-rt="font" title="字体">${fontOptions.map(f => html`<option value="${f}">${f}</option>`)}</select>
    <input class="input sm rt-size" type="number" min="8" max="144" step="1" value="${defaults.fontSize}" data-rt="size" title="字号">
    <button type="button" class="btn ghost sm icon-only rt-b" data-rt="bold" title="加粗"><b>B</b></button>
    <button type="button" class="btn ghost sm icon-only" data-rt="italic" title="斜体"><i style="font-family:serif">I</i></button>
    <button type="button" class="btn ghost sm icon-only" data-rt="underline" title="下划线"><u>U</u></button>
    <span class="rt-sep"></span>
    <span class="rt-swatches" title="文字颜色"><button type="button" class="rt-swatch rt-default" data-rt="color" data-v="" title="默认文字色">A</button>${RT_COLORS.map(c => html`<button type="button" class="rt-swatch" data-rt="color" data-v="${c}" style="background:${c}" title="${c}"></button>`)}</span>
    <span class="rt-sep"></span>
    <span class="rt-swatches" title="高光"><button type="button" class="rt-swatch rt-clear" data-rt="highlight" data-v="" title="取消高光"></button>${RT_HIGHLIGHTS.map(c => html`<button type="button" class="rt-swatch rt-hl" data-rt="highlight" data-v="${c}" style="background:${c}" title="高光 ${c}"></button>`)}</span>
  </div>`;
}
/**
 * 把工具栏和若干 .rich 编辑框接起来；getRuns/setRuns 读写编辑框对应的数据。
 * 全部用委托监听挂在 container 上（工具栏和编辑框随时会重绘），再次绑定或 unbindRichEditors 时撤掉旧的监听。
 */
function bindRichEditors(container, { getRuns, setRuns, defaults }) {
  unbindRichEditors(container);
  const controller = new AbortController(), signal = controller.signal;
  container._rtAbort = controller;
  let active = null, saved = null;
  const bar = () => $('.rt-toolbar', container);
  const refreshBar = () => {
    const b = bar();
    if (!b || !active || !saved || !container.contains(active)) return;
    const runs = getRuns(active);
    const sel = saved.end > saved.start ? rtSlice(runs, saved.start, saved.end) : rtSlice(runs, Math.max(0, saved.start - 1), saved.start);
    const first = sel[0] || {};
    $('[data-rt=font]', b).value = first.fontFamily || defaults.fontFamily;
    $('[data-rt=size]', b).value = first.fontSize || defaults.fontSize;
    for (const k of ['bold', 'italic', 'underline']) $(`[data-rt=${k}]`, b).classList.toggle('on', sel.length > 0 && sel.every(r => r[k]));
  };
  /** 选中了文字就作用于选区，否则作用于光标所在的整条作业。 */
  const range = () => {
    if (!active || !container.contains(active)) return null;
    if (saved && saved.end > saved.start) return { ...saved, whole: false };
    const len = rtPlain(getRuns(active)).length;
    return len ? { start: 0, end: len, whole: true } : null;
  };
  const apply = patch => {
    const r = range();
    if (!r) return toast('先点一下要设置格式的作业', 'error');
    const runs = rtApply(getRuns(active), r.start, r.end, patch);
    setRuns(active, runs);
    active.innerHTML = rtHtml(runs, true);
    active.focus();
    if (r.whole) rtSetSelection(active, saved?.start ?? r.end, saved?.start ?? r.end); else rtSetSelection(active, r.start, r.end);
    refreshBar();
  };
  const toggle = k => {
    const r = range();
    const sel = r ? rtSlice(getRuns(active), r.start, r.end) : [];
    const on = !(sel.length && sel.every(x => x[k]));
    apply(() => ({ [k]: on }));
  };
  document.addEventListener('selectionchange', () => {
    const el = getSelection().anchorNode?.parentElement?.closest?.('.rich') || document.activeElement?.closest?.('.rich');
    if (!el || !container.contains(el) || el.contentEditable !== 'true') return;
    active = el; saved = rtSelection(el) || saved; refreshBar();
  }, { signal });
  container.addEventListener('input', e => {
    const el = e.target.closest?.('.rich'); if (!el) return;
    setRuns(el, rtExtract(el));
    // 删光内容后浏览器会留下空的格式元素，清掉以免下一次输入继承旧格式。
    if (!el.textContent) el.innerHTML = '';
  }, { signal });
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
  onDispose(() => controller.abort());
}
function unbindRichEditors(container) { container._rtAbort?.abort(); container._rtAbort = null; }
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
        <div class="row"><span class="badge" id="live" title="实时同步状态"><span class="dot"></span><span>连接中</span></span></div>
      </div>
      <div class="project-list" id="pl">${loading()}</div>
    </aside>
    <section class="card" id="doc">${loading()}</section>
  </div>`);

  const setLive = on => {
    const b = $('#live', root); if (!b) return;
    b.className = 'badge ' + (on ? 'ok' : '');
    b.innerHTML = show(html`<span class="dot ${on ? 'live' : ''}"></span><span>${on ? '实时同步' : '离线'}</span>`);
  };

  function renderList() {
    const q = filter.trim().toLowerCase();
    const items = projects.filter(p => !p.deleted && (!q || p.name.toLowerCase().includes(q) || (p.date || '').includes(q) || dateLabel(p.date).includes(q)));
    const box = $('#pl', root);
    if (!items.length) { box.innerHTML = show(empty('book', projects.length ? '没有匹配的项目' : '暂无项目', projects.length ? '换个关键词试试。' : '设备同步后项目会出现在这里。')); return; }
    box.innerHTML = show(projectGroups(items, p => html`<a class="project-item ${current?.id === p.id ? 'active' : ''}" href="#/${src.link(p.id)}">
        <span class="name">${p.name}</span><span class="meta">更新于 ${relTime(p.updatedAt)}</span></a>`));
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
            <span>${icon('calendar', 'sm')}${dateLabel(detail.date, true)}</span>
            <span>${icon('book', 'sm')}${total} 项作业</span>
            <span title="${fullTime(detail.updatedAt)}">${icon('refresh', 'sm')}更新于 ${relTime(detail.updatedAt)}</span>
          </div>
        </div>
        <div class="row wrap no-print">
          <button class="btn sm" data-act="copy" data-text="${text}" data-label="作业文本已复制">${icon('copy')}复制文本</button>
          <button class="btn sm" data-act="print">${icon('print')}打印</button>
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
  drawer.innerHTML = show(html`<div class="drawer-head">${icon('history')}<h3 class="grow">历史版本 · ${project.name}</h3><button class="btn ghost sm icon-only" id="hx">${icon('x')}</button></div><div class="drawer-body">${loading()}</div>`);
  $('#hx', drawer).onclick = close;
  let items;
  try { items = await api(`/api/classes/${classId}/projects/${project.id}/history`); }
  catch (err) { $('.drawer-body', drawer).innerHTML = show(empty('alert', '加载失败', err.message)); return; }
  const body = $('.drawer-body', drawer);
  if (!items.length) { body.innerHTML = show(empty('history', '暂无历史记录', '升级服务端之后的每次修改都会保存一份快照，最多保留 30 个版本。')); return; }
  body.innerHTML = show(html`${items.map((h, i) => html`
    <div class="revision" data-rev="${h.revision}">
      <div class="row"><b>修订 ${h.revision}</b>${i === 0 ? html`<span class="badge ok">当前</span>` : ''}${h.deleted ? html`<span class="badge danger">删除</span>` : ''}<span class="spacer"></span><span class="faint" style="font-size:12px" title="${fullTime(h.createdAt)}">${relTime(h.createdAt)}</span></div>
      <div class="faint" style="font-size:12.5px">${h.author || '未知来源'} · ${h.name} · ${(h.size / 1024).toFixed(1)} KB</div>
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

async function viewLanding(query) {
  const recent = recentCodes();
  $('#app').innerHTML = show(html`<div class="landing">
    <div class="landing-top">
      <span></span>
      <div class="row">
        <button class="btn ghost icon-only" data-act="toggle-theme" title="切换深浅色">${icon('moon')}</button>
        ${state.token ? html`<a class="btn" href="#/overview">${icon('home')}进入控制台</a>` : html`<a class="btn" href="#/login">${icon('lock')}教师登录</a>`}
      </div>
    </div>
    <div class="landing-hero"><div class="hero-card">
      ${logo()}
      <h1>今天的作业，一目了然</h1>
      <p>输入老师提供的班级短码，查看同步自班级大屏的全部作业。</p>
      <form class="code-form" id="cf">
        <input class="input" id="code" placeholder="班级短码" maxlength="16" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="班级短码">
        <button class="btn primary lg" type="submit">查看作业${icon('arrow-right')}</button>
      </form>
      <div class="form-error" id="ce" style="margin-top:10px"></div>
      ${recent.length ? html`<div class="recent-codes">${recent.map(r => html`<a href="#/c/${r.code}">${icon('history', 'sm')}${r.name || r.code}</a>`)}</div>` : ''}
    </div></div>
    <div class="landing-foot">Pancake 集控 · 公开短码仅提供只读访问</div>
  </div>`);
  $('#cf').onsubmit = async e => {
    e.preventDefault();
    const code = $('#code').value.trim().toLowerCase();
    if (!code) { $('#ce').textContent = '请输入班级短码'; return; }
    navigate('c/' + encodeURIComponent(code));
  };
  $('#code').focus();
}

async function viewLogin(query) {
  if (await ensureMe()) return navigate(query.get('next') || 'overview');
  $('#app').innerHTML = show(html`<div class="landing">
    <div class="landing-top"><a class="btn ghost" href="#/">${icon('left')}返回</a><button class="btn ghost icon-only" data-act="toggle-theme">${icon('moon')}</button></div>
    <div class="landing-hero"><form class="card auth-card stack" id="lf" novalidate>
      <div>${logo()}<h2>登录集控控制台</h2><p class="muted">老师和管理员使用账号登录</p></div>
      ${query.get('expired') ? html`<div class="banner warn" style="margin:0">${icon('alert')}<span>登录已过期，请重新登录。</span></div>` : ''}
      <label class="field"><span>账号</span><input class="input" name="user" autocomplete="username" required></label>
      <label class="field"><span>密码</span><input class="input" name="pass" type="password" autocomplete="current-password" required></label>
      <div class="form-error" id="le"></div>
      <button class="btn primary lg" type="submit">登录</button>
    </form></div>
    <div class="landing-foot">忘记密码请联系管理员重置</div>
  </div>`);
  const f = $('#lf');
  f.user.focus();
  f.onsubmit = async e => {
    e.preventDefault(); $('#le').textContent = '';
    const btn = $('button[type=submit]', f); btn.disabled = true; btn.textContent = '正在登录…';
    try {
      const r = await api('/api/auth/login', { method: 'POST', auth: false, body: { userName: f.user.value.trim(), password: f.pass.value } });
      state.token = r.accessToken; store.set('token', r.accessToken); state.me = null; state.classes = null;
      await ensureMe();
      // 只负责一个班的老师直接进这个班的作业。
      const next = query.get('next'), cls = next || isAdmin() ? [] : await classList();
      navigate(next || (cls.length === 1 ? `classes/${cls[0].id}/homework` : 'overview'));
    } catch (err) {
      $('#le').textContent = err.status === 401 ? '账号或密码不正确，或账号已停用' : err.message;
      btn.disabled = false; btn.textContent = '登录';
    }
  };
}

async function viewPublic(code, projectId) {
  code = code.toLowerCase();
  const base = `/api/public/classes/${encodeURIComponent(code)}`;
  let first;
  try { first = await api(base + '/projects', { auth: false }); }
  catch (err) {
    $('#app').innerHTML = show(html`<div class="landing"><div class="landing-top"><a class="btn ghost" href="#/">${icon('left')}返回</a><span></span></div>
      <div class="landing-hero">${empty('alert', err.status === 404 ? '找不到这个班级' : '加载失败', err.status === 404 ? `短码“${code}”不存在或已被重置，请向老师确认。` : err.message, html`<a class="btn primary" href="#/">重新输入</a>`)}</div></div>`);
    recentCodes().some(r => r.code === code) && err.status === 404 && store.set('recentCodes', recentCodes().filter(r => r.code !== code));
    return;
  }
  rememberCode(code, first.classroom);
  document.title = first.classroom + ' · Pancake 作业';
  onDispose(() => { document.title = 'Pancake 集控'; });
  const shareUrl = `${location.origin}${location.pathname}#/c/${code}`;
  $('#app').innerHTML = show(html`
    <header class="viewer-top">
      <a class="brand" href="#/">${logo()}</a>
      <div class="grow"><div class="class-name">${first.classroom}</div><div class="faint" style="font-size:12px">班级作业 · 只读</div></div>
      <button class="btn sm" data-act="copy" data-text="${shareUrl}" data-label="分享链接已复制">${icon('share')}<span>分享</span></button>
      <button class="btn ghost sm icon-only" data-act="toggle-theme" title="切换深浅色">${icon('moon')}</button>
    </header>
    <main class="viewer-body"><div id="bs"></div><div id="vb"></div></main>`);
  let cached = first.projects;
  const loadBoard = () => api(`${base.replace('/projects', '')}/board`, { auth: false }).then(b => { const el = $('#bs'); if (el) el.innerHTML = show(boardStrip(b)); }).catch(() => { });
  loadBoard();
  await mountBrowser($('#vb'), {
    asset: sha => `${base}/assets/${sha}`,
    onEvent: ev => { if (ev.type === 'board') loadBoard(); },
    list: async () => { if (cached) { const c = cached; cached = null; return c; } return (await api(base + '/projects', { auth: false })).projects; },
    detail: id => api(`${base}/projects/${id}`, { auth: false }),
    link: id => `c/${code}/${id}`,
    ws: `/ws/public/${encodeURIComponent(code)}`
  }, projectId);
}

/** 公告与今日值日卡片：公开页与班级页共用。 */
function boardStrip(b) {
  const items = b?.announcements || [], duty = b?.duty;
  if (!items.length && !duty) return '';
  return html`<div class="board-strip">
    ${items.map(a => html`<article class="notice-card ${a.level}">
      <div class="row wrap">${a.level !== 'info' ? levelBadge(a.level) : ''}${a.pinned ? html`<span class="badge">${icon('pin', 'sm')}置顶</span>` : ''}<b class="grow notice-title">${a.title}</b></div>
      ${a.body ? html`<p class="notice-body">${a.body}</p>` : ''}
      <div class="faint" style="font-size:12px">${a.author ? a.author + ' · ' : ''}${relTime(a.createdAt)}</div>
    </article>`)}
    ${duty ? html`<article class="notice-card duty">
      <div class="row">${icon('broom')}<b class="grow">今日值日</b><span class="faint" style="font-size:12px">${duty.label}</span></div>
      <div class="duty-today">${duty.tasks.map(t => html`<div><span>${t.task}</span><b>${t.students.join('、')}</b></div>`)}</div>
    </article>` : ''}
  </div>`;
}

// ============================================================ 概览
async function viewOverview() {
  const page = shell({ nav: 'overview', title: `你好，${state.me.displayName}`, crumbs: dateLabel(todayStr(), true) });
  setPage(page, loading());
  const [o, mine] = await Promise.all([api('/api/overview'), isAdmin() ? Promise.resolve([]) : assignments()]);
  const stat = (ic, label, value, sub, href) => html`<${href ? 'a' : 'div'} class="card stat ${href ? 'link' : ''}" ${href ? raw(`href="#/${href}"`) : ''}><div class="label">${icon(ic)}${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></${href ? 'a' : 'div'}>`;
  const today = o.today || [];
  const ready = today.filter(t => t.projectId && t.filled > 0).length;
  setPage(page, html`
    ${state.me.weakPassword ? html`<div class="banner warn">${icon('alert')}<div class="grow"><b>当前账号使用弱密码</b><div class="muted" style="font-size:13px">默认或过短的密码容易被猜到，请尽快修改。</div></div><a class="btn sm" href="#/settings">修改密码</a></div>` : ''}
    ${o.deviceIssues?.length ? html`<div class="banner warn">${icon('device')}<div class="grow"><b>${o.deviceIssues.length} 台设备同步异常</b><div class="muted" style="font-size:13px">${o.deviceIssues.slice(0, 3).map(d => `${d.className} · ${d.deviceName}${d.lastError ? '：' + d.lastError : d.pendingChanges ? `：${d.pendingChanges} 项待上传` : ''}`).join('；')}</div></div><a class="btn sm" href="#/classes/${o.deviceIssues[0].classId}/devices">查看设备</a></div>` : ''}
    <div class="stats">
      ${stat('class', '班级', o.classCount, isAdmin() ? '全部班级' : '我负责的班级', 'classes')}
      ${stat('book', '今日作业', `${ready}/${today.length}`, '已布置作业的班级', 'homework')}
      ${stat('device', '已配对设备', o.deviceCount, `24 小时内活跃 ${o.activeDevices} 台 · 在线 ${o.online}`)}
      ${stat('student', '学生', o.studentCount ?? 0, '名单中的在读学生')}
      ${stat('megaphone', '生效公告', o.activeAnnouncements ?? 0, '正在大屏上显示', 'announcements')}
      ${o.userCount != null ? stat('users', '账号', o.userCount, '老师与管理员', 'users') : ''}
    </div>
    ${o.classCount === 0 ? html`<div class="card">${empty('class', isAdmin() ? '还没有班级' : '还没有分配班级', isAdmin() ? '创建第一个班级，然后用配对码把班级大屏连接到服务器。' : '请联系管理员把你分配到班级。', isAdmin() ? html`<a class="btn primary" href="#/classes?new=1">${icon('plus')}新建班级</a>` : '')}</div>` : html`
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h3 class="grow">今日作业</h3><span class="faint" style="font-size:12.5px">${dateLabel(todayStr())}</span></div>
        <div class="list-rows">${today.map(t => html`
          <div class="list-row">
            <span class="grow"><span class="title" style="display:block">${t.className}${t.online ? html` <span class="dot live" title="大屏在线" style="display:inline-block;vertical-align:middle;margin-left:4px"></span>` : ''}</span>
              <span class="meta">${t.projectId ? `${t.projectName} · ${t.filled}/${t.subjects} 个科目已布置` : '今天还没有作业项目'}</span>
              ${t.projectId ? progress(t.filled, t.subjects) : ''}</span>
            ${t.projectId ? html`<a class="btn sm" href="#/classes/${t.classId}/homework/${t.projectId}">${icon('edit')}查看</a>` : html`<a class="btn sm primary" href="#/classes/${t.classId}/homework?new=1">${icon('plus')}布置</a>`}
          </div>`)}</div>
      </section>
      ${mine.length ? html`<section class="card">
        <div class="card-head"><h3 class="grow">我的分工</h3></div>
        <div class="list-rows">${mine.map(a => html`<a class="list-row" href="#/classes/${a.classId}">
          <span class="grow"><span class="title" style="display:block">${a.className}</span><span class="meta">${DUTY_LABEL[a.duty] || a.duty}${a.subjects.length ? ' · ' + a.subjects.join('、') : ''}</span></span>
          ${a.duty === 'HeadTeacher' ? html`<span class="badge accent">班主任</span>` : ''}</a>`)}</div>
      </section>` : html`<section class="card">
        <div class="card-head"><h3 class="grow">最近动态</h3>${isAdmin() ? html`<a class="btn ghost sm" href="#/audit">操作日志${icon('right')}</a>` : ''}</div>
        <div style="padding:6px 0">${o.activity.length ? o.activity.map(a => html`
          <div class="timeline-item"><span class="dot"></span><div><div><b>${a.action}</b>${a.detail ? ' · ' + a.detail : ''}</div><div class="meta">${a.actor} · <span title="${fullTime(a.at)}">${relTime(a.at)}</span></div></div></div>`) : empty('log', '暂无动态', '创建班级、配对设备等操作会记录在这里。')}</div>
      </section>`}
    </div>
    <section class="card" style="margin-top:18px">
      <div class="card-head"><h3 class="grow">最近更新</h3><a class="btn ghost sm" href="#/homework">全部作业${icon('right')}</a></div>
      <div class="list-rows">${o.recent.length ? o.recent.map(p => html`
        <a class="list-row" href="#/classes/${p.classId}/homework/${p.id}">
          <span class="grow"><span class="title" style="display:block">${p.name}${p.deleted ? html` <span class="badge danger">已删除</span>` : ''}</span><span class="meta">${p.className} · ${dateLabel(p.date)}${p.updatedBy ? ' · ' + p.updatedBy : ''}</span></span>
          <span class="meta nowrap" title="${fullTime(p.updatedAt)}">${relTime(p.updatedAt)}</span>
        </a>`) : empty('book', '暂无项目', '设备同步或在网页上新建项目后会出现在这里。')}</div>
    </section>`}`);
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

async function viewClasses(query) {
  const page = shell({ nav: 'classes', title: '班级', actions: isAdmin() ? html`<button class="btn primary" data-act="new-class">${icon('plus')}新建班级</button>` : '' });
  viewActions['new-class'] = async () => { const c = await createClassFlow(); if (c) { state.classes = null; navigate('classes/' + c.id + '/devices'); } };
  setPage(page, loading());
  const classes = await api('/api/classes');
  if (!classes.length) {
    setPage(page, html`<div class="card">${empty('class', isAdmin() ? '还没有班级' : '还没有分配班级', isAdmin() ? '每个班级对应一块班级大屏，创建后使用配对码连接设备。' : '请联系管理员把你分配到班级。', isAdmin() ? html`<button class="btn primary" data-act="new-class">${icon('plus')}新建班级</button>` : '')}</div>`);
  } else {
    setPage(page, html`<div class="toolbar"><label class="input-icon">${icon('search', 'sm')}<input class="input" id="cs" placeholder="搜索班级"></label><span class="faint">${classes.length} 个班级</span></div>
      <div class="class-grid" id="cg"></div>`);
    const renderGrid = q => $('#cg').innerHTML = show(classes.filter(c => !q || c.name.toLowerCase().includes(q) || c.publicCode.includes(q)).map(c => html`
      <a class="card class-card" href="#/classes/${c.id}">
        <div class="row"><h3 class="grow">${c.name}</h3>${c.online ? html`<span class="badge ok" title="实时连接数"><span class="dot live"></span>${c.online}</span>` : ''}</div>
        <div class="mini-stats"><div><b>${c.projectCount}</b><span>项目</span></div><div><b>${c.deviceCount}</b><span>设备</span></div><div><b>${c.teacherCount}</b><span>老师</span></div></div>
        <div class="foot"><span class="mono">${c.publicCode}</span><span class="spacer"></span><span>${c.lastUpdatedAt ? '更新于 ' + relTime(c.lastUpdatedAt) : '尚无同步'}</span></div>
      </a>`));
    renderGrid('');
    $('#cs').oninput = e => renderGrid(e.target.value.trim().toLowerCase());
  }
  if (query.get('new') && isAdmin()) viewActions['new-class']();
}

async function viewClass(classId, section = 'homework', sub, query) {
  if (sub instanceof URLSearchParams) { query = sub; sub = undefined; }
  if (section instanceof URLSearchParams) { query = section; section = 'homework'; }
  if (section === 'projects') section = 'homework';
  if (section === 'teachers') section = 'people';
  if (!SECTION_LABEL[section]) section = 'homework';
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
    classId: c.id, section, title: SECTION_LABEL[section], crumbs: html`<span>${c.name}</span>`,
    actions: html`<span class="code-chip" title="公开短码：学生和家长凭它只读查看作业">${c.publicCode}<button class="btn ghost sm icon-only" data-act="copy" data-text="${publicUrl}" data-label="公开链接已复制" title="复制公开链接">${icon('link', 'sm')}</button></span>
      ${c.online ? html`<span class="badge ok" title="实时连接数"><span class="dot live"></span>${c.online} 在线</span>` : ''}`
  });
  if (section === 'homework') page.classList.add('wide');
  setPage(page, html`<div id="tab">${loading()}</div>`);
  viewActions.pair = () => pairingDialog(c.id, c.name);
  const box = $('#tab');
  const views = { homework: (b, cl) => classHomework(b, cl, sub, query), layout: classLayout, people: classPeople, duty: classDuty, notices: classNotices, devices: classDevices, settings: (b, cl) => classSettings(b, cl, publicUrl) };
  reloadView = () => views[section](box, c);
  await views[section](box, c);
}

async function classDevices(box, c) {
  const devices = await api(`/api/classes/${c.id}/devices`);
  const status = d => {
    if (d.revoked) return html`<span class="badge danger">已吊销</span>`;
    if (d.online) return html`<span class="badge ok"><span class="dot live"></span>在线</span>`;
    const seen = parseTime(d.lastSeenAt);
    if (seen && Date.now() - seen < 15 * 60e3) return html`<span class="badge ok"><span class="dot ok"></span>活跃</span>`;
    return html`<span class="badge">离线</span>`;
  };
  const health = d => d.revoked ? '' : d.lastError ? html`<div class="faint" style="font-size:12px;color:var(--danger)">${icon('alert', 'sm')} ${d.lastError}</div>`
    : d.pendingChanges ? html`<div class="faint" style="font-size:12px">${d.pendingChanges} 项待上传</div>` : '';
  box.innerHTML = show(html`<div class="toolbar"><span class="muted grow">${devices.filter(d => !d.revoked).length} 台设备 · 点设备名称可以直接改名</span><button class="btn primary" data-act="pair">${icon('device')}配对设备</button></div>
    <div class="card">${devices.length ? html`<div class="table-wrap"><table class="table">
    <thead><tr><th>设备</th><th>状态</th><th>最近同步</th><th class="hide-sm">版本 · 当前项目</th><th></th></tr></thead>
    <tbody>${devices.map(d => html`<tr class="${d.revoked ? 'dim' : ''}">
      <td><div class="who">${icon('device')}<div>${d.revoked ? html`<b>${d.deviceName || '未命名设备'}</b>` : html`<input class="inline-edit" data-rename="${d.id}" value="${d.deviceName || ''}" placeholder="未命名设备" maxlength="60" aria-label="设备名称">`}<span>配对于 ${fullTime(d.createdAt).slice(0, 10)}</span></div></div></td>
      <td>${status(d)}${health(d)}</td>
      <td title="${fullTime(d.lastSyncAt || d.lastSeenAt)}">${relTime(d.lastSyncAt || d.lastSeenAt)}</td>
      <td class="hide-sm">${d.appVersion || html`<span class="faint">未上报</span>`}${d.activeProject ? html`<div class="faint" style="font-size:12px">${d.activeProject}</div>` : ''}</td>
      <td class="actions">${d.revoked ? '' : html`
        <button class="btn ghost sm" data-act="dev-sync" data-id="${d.id}" ${d.online ? '' : 'disabled title="设备离线"'}>${icon('sync')}同步</button>
        <button class="btn ghost sm" data-act="dev-msg" data-id="${d.id}" ${d.online ? '' : 'disabled title="设备离线"'}>${icon('send')}消息</button>
        <button class="btn sm danger" data-act="revoke" data-id="${d.id}">吊销</button>`}</td></tr>`)}</tbody></table></div>`
    : empty('device', '还没有配对设备', '生成配对码，在班级大屏的 Pancake 设置 → 集控中输入即可连接。', html`<button class="btn primary" data-act="pair">${icon('device')}配对设备</button>`)}</div>
    <p class="faint" style="margin-top:12px;font-size:12.5px">在线设备可以远程触发同步或在大屏上弹出一条消息。吊销后该设备无法再读取或上传项目，需要重新配对。</p>`);
  const find = id => devices.find(d => d.id === id);
  // 就地改名：回车或离开输入框时保存，Esc 还原。
  for (const input of $$('[data-rename]', box)) {
    const d = find(input.dataset.rename);
    input.onkeydown = e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = d.deviceName || ''; input.blur(); } };
    input.onchange = async () => {
      const name = input.value.trim();
      if (name === (d.deviceName || '')) return;
      try { await api(`/api/classes/${c.id}/devices/${d.id}`, { method: 'PATCH', body: { name } }); d.deviceName = name; toast('设备已重命名'); }
      catch (err) { input.value = d.deviceName || ''; fail(err); }
    };
  }
  Object.assign(viewActions, {
    'dev-sync': async el => {
      const r = await api(`/api/classes/${c.id}/devices/${el.dataset.id}/command`, { method: 'POST', body: { command: 'sync' } });
      toast(r.delivered ? '已通知设备立即同步' : '设备离线，未送达', r.delivered ? 'ok' : 'error');
    },
    'dev-msg': async el => {
      const d = find(el.dataset.id);
      const r = await modal({
        title: `发送消息到“${d.deviceName}”`, submit: '发送',
        body: html`<label class="field"><span>消息内容</span><textarea class="input" name="text" rows="3" maxlength="200" placeholder="例如：请值日生关好门窗"></textarea><small>消息会在大屏顶部提示条中显示。</small></label>`,
        onSubmit: f => { const text = f.text.value.trim(); if (!text) throw new Error('请输入消息内容'); return api(`/api/classes/${c.id}/devices/${d.id}/command`, { method: 'POST', body: { command: 'message', text } }); }
      });
      if (r) toast(r.delivered ? '消息已送达' : '设备离线，未送达', r.delivered ? 'ok' : 'error');
    },
    revoke: async el => {
      const d = find(el.dataset.id);
      if (!await confirmDialog({ title: '吊销设备', message: `吊销“${d.deviceName}”后，它将无法继续同步本班项目，需要重新配对。确定吗？`, confirm: '吊销' })) return;
      await api(`/api/classes/${c.id}/devices/${d.id}`, { method: 'DELETE' }); toast('设备已吊销'); reloadView();
    }
  });
}

// ---------- 人员：老师分工与学生名单
async function classPeople(box, c) {
  const [staff, students, duty] = await Promise.all([api(`/api/classes/${c.id}/staff`), api(`/api/classes/${c.id}/students`), myDuty(c.id)]);
  const canStaff = isAdmin() || duty === 'HeadTeacher';
  const canRoster = canStaff || !staff.some(t => t.duty === 'HeadTeacher');
  const others = isAdmin() ? (await api('/api/admin/users')).filter(u => u.role === 'Teacher' && !staff.some(t => t.id === u.id)) : [];
  let q = '', editing = null;
  const groups = () => [...new Set(students.map(x => x.group).filter(Boolean))];
  const viewRow = x => html`<tr class="${x.active ? '' : 'dim'}">
      <td class="mono">${x.number || html`<span class="faint">—</span>`}</td>
      <td><b>${x.name}</b>${x.note ? html`<div class="faint" style="font-size:12px">${x.note}</div>` : ''}</td>
      <td>${x.group ? html`<span class="badge">${x.group}</span>` : html`<span class="faint">—</span>`}</td>
      <td class="hide-sm">${x.active ? html`<span class="badge ok">在读</span>` : html`<span class="badge">停用</span>`}</td>
      <td class="actions">${canRoster ? html`<button class="btn ghost sm icon-only" data-act="edit-student" data-id="${x.id}" title="编辑">${icon('edit')}</button><button class="btn ghost sm icon-only danger" data-act="del-student" data-id="${x.id}" title="移除">${icon('trash')}</button>` : ''}</td></tr>`;
  // 行内编辑：回车保存，Esc 取消。
  const editRow = x => html`<tr class="row-edit" data-row="${x.id}">
      <td><input class="input sm" data-ef="number" value="${x.number}" maxlength="20" placeholder="学号"></td>
      <td><input class="input sm" data-ef="name" value="${x.name}" maxlength="30" placeholder="姓名"><input class="input sm" data-ef="note" value="${x.note}" maxlength="100" placeholder="备注" style="margin-top:6px"></td>
      <td><input class="input sm" data-ef="group" value="${x.group}" maxlength="20" list="groups" placeholder="小组"></td>
      <td class="hide-sm"><label class="check"><input type="checkbox" data-ef="active" ${x.active ? 'checked' : ''}>在读</label></td>
      <td class="actions"><button class="btn sm primary" data-act="save-student" data-id="${x.id}">保存</button><button class="btn sm ghost" data-act="cancel-student">取消</button></td></tr>`;
  // 名单顶部的快速添加行：填完按回车就添加，可以连续录入。
  const quickRow = () => canRoster ? html`<tr class="row-edit quick-add">
      <td><input class="input sm" data-qa="number" maxlength="20" placeholder="学号"></td>
      <td><input class="input sm" data-qa="name" maxlength="30" placeholder="姓名，回车添加"></td>
      <td><input class="input sm" data-qa="group" maxlength="20" list="groups" placeholder="小组"></td>
      <td class="hide-sm"></td>
      <td class="actions"><button class="btn sm primary" data-act="quick-add">${icon('plus')}添加</button></td></tr>` : '';
  const renderStudents = () => {
    const rows = students.filter(x => !q || x.name.includes(q) || x.number.includes(q) || x.group.includes(q));
    $('#sb').innerHTML = show(html`${quickRow()}${rows.length ? rows.map(x => editing === x.id ? editRow(x) : viewRow(x))
      : html`<tr><td colspan="5">${empty('student', students.length ? '没有匹配的学生' : '还没有学生名单', students.length ? '换个关键词试试。' : canRoster ? '在上面一行逐个录入，或用“批量导入”从表格粘贴。' : '名单由班主任维护。')}</td></tr>`}`);
    $('#groups').innerHTML = show(groups().map(g => html`<option value="${g}">`));
    const active = students.filter(x => x.active).length, gs = groups().length;
    $('#scount').textContent = `${active} 人${gs ? ` · ${gs} 个小组` : ''}`;
  };
  box.innerHTML = show(html`
    <section class="card">
      <div class="card-head"><h3 class="grow">老师与分工</h3>
        ${isAdmin() ? html`<select class="input" id="ta" style="width:220px" ${others.length ? '' : 'disabled'}><option value="">${others.length ? '选择要加入的老师…' : '没有可加入的老师'}</option>${others.map(u => html`<option value="${u.id}">${u.displayName}（${u.userName}）</option>`)}</select>
          <button class="btn sm primary" data-act="add-teacher" ${others.length ? '' : 'disabled'}>${icon('plus')}加入</button>` : ''}
      </div>
      ${staff.length ? html`<div class="list-rows">${staff.map(t => html`
        <div class="list-row">${avatar(t.displayName, 'sm')}
          <span class="grow"><span class="title" style="display:block">${t.displayName}${t.id === state.me.id ? html` <span class="badge accent">我</span>` : ''}${t.enabled ? '' : html` <span class="badge danger">已停用</span>`}</span>
            <span class="meta">${t.userName}</span></span>
          <span class="badge ${t.duty === 'HeadTeacher' ? 'accent' : t.duty === 'Assistant' ? '' : 'info'}">${DUTY_LABEL[t.duty] || t.duty}</span>
          <span class="chips hide-sm" style="max-width:300px">${t.duty === 'HeadTeacher' ? html`<span class="faint" style="font-size:12px">全部科目</span>` : t.subjects.length ? t.subjects.map(x => html`<span class="chip">${x}</span>`) : html`<span class="faint" style="font-size:12px">未限定科目</span>`}</span>
          ${canStaff ? html`<button class="btn ghost sm" data-act="edit-staff" data-id="${t.id}">${icon('edit')}分工</button>` : ''}
          ${isAdmin() ? html`<button class="btn ghost sm icon-only danger" data-act="remove-teacher" data-id="${t.id}" title="移出班级">${icon('x')}</button>` : ''}
        </div>`)}</div>` : empty('users', '还没有分配老师', isAdmin() ? '加入老师后可以设置班主任和科任老师的科目。' : '请联系管理员分配老师。')}
      <div class="card-body faint" style="font-size:12.5px;border-top:1px solid var(--border)">班主任可以管理本班全部内容和人员分工；指定了科目的科任老师和助教在网页上只能编辑自己负责的科目，未指定科目则不受限。</div>
    </section>
    <section class="card" style="margin-top:18px">
      <div class="card-head"><h3 class="grow">学生名单 <span class="faint" style="font-weight:500;font-size:13px" id="scount"></span></h3>
        ${canRoster ? html`<button class="btn sm" data-act="import-students">${icon('upload')}批量导入</button>` : ''}</div>
      <div class="card-body" style="padding-bottom:0"><label class="input-icon" style="max-width:280px;display:block">${icon('search', 'sm')}<input class="input" id="sq" placeholder="搜索姓名、学号或小组"></label></div>
      <div class="table-wrap"><table class="table"><thead><tr><th style="width:120px">学号</th><th>姓名</th><th style="width:150px">小组</th><th class="hide-sm">状态</th><th></th></tr></thead><tbody id="sb"></tbody></table></div>
      <datalist id="groups"></datalist>
    </section>`);
  renderStudents();
  $('#sq').oninput = e => { q = e.target.value.trim(); renderStudents(); };
  $('#sb').addEventListener('keydown', e => {
    if (e.target.dataset.qa && e.key === 'Enter') { e.preventDefault(); viewActions['quick-add']().catch(fail); }
    if (e.target.dataset.ef && e.key === 'Enter') { e.preventDefault(); viewActions['save-student']($('[data-act=save-student]', e.target.closest('tr'))).catch(fail); }
    if (e.target.dataset.ef && e.key === 'Escape') { editing = null; renderStudents(); }
  });
  const rowBody = tr => ({ name: $('[data-ef=name]', tr).value.trim(), number: $('[data-ef=number]', tr).value.trim(), group: $('[data-ef=group]', tr).value.trim(), note: $('[data-ef=note]', tr).value.trim(), active: $('[data-ef=active]', tr).checked });

  Object.assign(viewActions, {
    'add-teacher': async () => {
      const id = $('#ta').value; if (!id) return toast('请选择老师', 'error');
      await api(`/api/admin/classes/${c.id}/teachers/${id}`, { method: 'POST' }); toast('老师已加入班级'); reloadView();
    },
    'remove-teacher': async el => {
      const t = staff.find(x => x.id === el.dataset.id);
      if (!await confirmDialog({ title: '移出班级', message: `将“${t.displayName}”移出${c.name}？该老师将无法再管理本班。`, confirm: '移出' })) return;
      await api(`/api/admin/classes/${c.id}/teachers/${t.id}`, { method: 'DELETE' }); toast('已移出'); reloadView();
    },
    'edit-staff': async el => {
      const t = staff.find(x => x.id === el.dataset.id);
      const known = await api(`/api/classes/${c.id}/subjects`).catch(() => []);
      const all = [...new Set([...known, ...t.subjects])];
      const ok = await modal({
        title: `${t.displayName} 的分工`, submit: '保存',
        body: html`<label class="field"><span>职务</span><select class="input" name="duty">${Object.entries(DUTY_LABEL).map(([k, v]) => html`<option value="${k}" ${t.duty === k ? 'selected' : ''}>${v}</option>`)}</select><small>每班只有一位班主任，任命新班主任时原班主任会改为科任老师。</small></label>
          <div class="field" id="sf"><span>负责科目</span>
            <div class="checklist">${all.length ? all.map(x => html`<label class="check"><input type="checkbox" name="subj" value="${x}" ${t.subjects.includes(x) ? 'checked' : ''}>${x}</label>`) : html`<span class="faint" style="font-size:12.5px;padding:6px 0">本班项目里还没有科目，可以在下面手动添加。</span>`}</div>
            <div class="row"><input class="input grow" id="ns" placeholder="添加其他科目，例如：信息技术" maxlength="40"><button type="button" class="btn" id="nsb">${icon('plus')}添加</button></div>
            <small>不勾选任何科目表示不限科目。</small></div>`,
        onMount: f => {
          const toggle = () => $('#sf', f).classList.toggle('hidden', f.duty.value === 'HeadTeacher');
          f.duty.onchange = toggle; toggle();
          const add = () => {
            const v = $('#ns', f).value.trim(); if (!v) return;
            const list = $('.checklist', f);
            if (!$$('input[name=subj]', f).some(x => x.value === v)) { $('.faint', list)?.remove(); list.insertAdjacentHTML('beforeend', show(html`<label class="check"><input type="checkbox" name="subj" value="${v}" checked>${v}</label>`)); }
            $('#ns', f).value = '';
          };
          $('#nsb', f).onclick = add;
          $('#ns', f).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
        },
        onSubmit: f => api(`/api/classes/${c.id}/staff/${t.id}`, { method: 'PUT', body: { duty: f.duty.value, subjects: f.duty.value === 'HeadTeacher' ? [] : $$('input[name=subj]:checked', f).map(x => x.value) } })
      });
      if (ok) { myAssignments = null; toast('分工已保存'); reloadView(); }
    },
    'quick-add': async () => {
      const get = k => $(`[data-qa=${k}]`, box);
      const body = { name: get('name').value.trim(), number: get('number').value.trim(), group: get('group').value.trim(), note: '', active: true };
      if (!body.name) { get('name').focus(); return toast('请输入姓名', 'error'); }
      const x = await api(`/api/classes/${c.id}/students`, { method: 'POST', body });
      students.push(x); renderStudents();
      // 小组保留方便连续录入同组学生；学号是数字时自动加一。
      get('group').value = body.group;
      if (/^\d+$/.test(body.number)) get('number').value = String(+body.number + 1).padStart(body.number.length, '0');
      (body.number ? get('number') : get('name')).focus();
      toast(`已添加 ${x.name}`);
    },
    'edit-student': el => { editing = el.dataset.id; renderStudents(); $('[data-ef=name]', $('#sb'))?.focus(); },
    'cancel-student': () => { editing = null; renderStudents(); },
    'save-student': async el => {
      const tr = el.closest('tr'), body = rowBody(tr);
      if (!body.name) { $('[data-ef=name]', tr).focus(); return toast('请输入姓名', 'error'); }
      const x = await api(`/api/classes/${c.id}/students/${el.dataset.id}`, { method: 'PATCH', body });
      students[students.findIndex(y => y.id === x.id)] = x; editing = null; renderStudents(); toast('已保存');
    },
    'del-student': async el => {
      const x = students.find(y => y.id === el.dataset.id);
      if (!await confirmDialog({ title: '移除学生', message: `从名单中移除“${x.name}”？值日安排里的这名学生也会被移除。如果只是暂时不参与值日，可以编辑后取消“在读”。`, confirm: '移除' })) return;
      await api(`/api/classes/${c.id}/students/${x.id}`, { method: 'DELETE' });
      students.splice(students.indexOf(x), 1); renderStudents(); toast('已移除');
    },
    'import-students': async () => {
      const r = await modal({
        title: '批量导入学生', submit: '导入', wide: true,
        body: html`<p class="muted">每行一名学生，可以直接从表格复制粘贴。支持“姓名”“学号 姓名”或“学号 姓名 小组”，用空格、逗号或制表符分隔。</p>
          <textarea class="input mono" name="text" rows="10" placeholder="01 张三 第一组&#10;02 李四 第一组&#10;03 王五 第二组"></textarea>
          <label class="check"><input type="checkbox" name="replace">替换现有名单（不勾选时按学号或姓名合并更新）</label>`,
        onSubmit: f => { if (!f.text.value.trim()) throw new Error('请粘贴学生名单'); return api(`/api/classes/${c.id}/students/import`, { method: 'POST', body: { text: f.text.value, replaceAll: f.replace.checked } }); }
      });
      if (r) { toast(`导入完成：新增 ${r.added} 人，更新 ${r.updated} 人`); reloadView(); }
    }
  });
}

// ---------- 值日安排
async function classDuty(box, c) {
  const [res, students, staff, duty] = await Promise.all([api(`/api/classes/${c.id}/duty`), api(`/api/classes/${c.id}/students`), api(`/api/classes/${c.id}/staff`), myDuty(c.id)]);
  const canEdit = isAdmin() || duty === 'HeadTeacher' || !staff.some(t => t.duty === 'HeadTeacher');
  const active = students.filter(x => x.active);
  const nameOf = id => active.find(x => x.id === id)?.name;
  if (!active.length) {
    box.innerHTML = show(html`<div class="card">${empty('broom', '先导入学生名单', '值日安排需要先在“人员”页导入学生名单。', html`<a class="btn primary" href="#/classes/${c.id}/people">${icon('student')}去导入名单</a>`)}</div>`);
    return;
  }
  const plan = JSON.parse(JSON.stringify(res.plan || {}));
  plan.mode ||= 'fixed'; plan.unit ||= 'day'; plan.weekdays ||= [1, 2, 3, 4, 5]; plan.tasks ||= []; plan.fixed ||= {}; plan.groups ||= [];
  plan.anchor ||= todayStr();
  if (!plan.tasks.length) plan.tasks = [{ id: shortId(), name: '扫地' }, { id: shortId(), name: '擦黑板' }, { id: shortId(), name: '倒垃圾' }];
  let dirty = false;
  setLeaveGuard(() => dirty ? '值日安排还没有保存，离开后修改会丢失。' : '');
  const chips = ids => ids.map(nameOf).filter(Boolean).map(n => html`<span class="chip">${n}</span>`);

  const render = () => {
    box.innerHTML = show(html`<div class="stack">
      ${canEdit ? '' : html`<div class="banner warn">${icon('lock')}<span>值日安排由班主任维护，你可以查看。</span></div>`}
      <section class="card"><div class="card-head"><h3 class="grow">安排方式</h3>
        <div class="segmented" id="dm">${[['fixed', '按星期固定'], ['rotate', '小组轮换']].map(([k, l]) => html`<button type="button" data-v="${k}" class="${plan.mode === k ? 'active' : ''}" ${canEdit ? '' : 'disabled'}>${l}</button>`)}</div></div>
        <div class="card-body stack">
          <div class="row wrap"><span class="muted" style="min-width:72px">值日日</span>${[1, 2, 3, 4, 5, 6, 7].map(d => html`<label class="check day-check"><input type="checkbox" data-day="${d}" ${plan.weekdays.includes(d) ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>${WEEKDAY_NAMES[d]}</label>`)}</div>
          <div class="row wrap"><span class="muted" style="min-width:72px">岗位</span>
            <span class="chips">${plan.tasks.map((t, i) => html`<span class="chip">${t.name}${canEdit ? html`<button type="button" class="chip-x" data-del-task="${i}" title="删除岗位">${icon('x', 'sm')}</button>` : ''}</span>`)}</span>
            ${canEdit ? html`<input class="input" id="nt" placeholder="新岗位" maxlength="20" style="width:140px"><button type="button" class="btn sm" id="ntb">${icon('plus')}添加</button>` : ''}</div>
          ${plan.mode === 'rotate' ? html`<div class="row wrap"><span class="muted" style="min-width:72px">轮换</span>
            <div class="segmented" id="du">${[['day', '每个值日日换一组'], ['week', '每周换一组']].map(([k, l]) => html`<button type="button" data-v="${k}" class="${plan.unit === k ? 'active' : ''}" ${canEdit ? '' : 'disabled'}>${l}</button>`)}</div>
            <label class="row" style="gap:6px"><span class="muted">从</span><input class="input" type="date" id="da" value="${plan.anchor}" style="width:160px" ${canEdit ? '' : 'disabled'}><span class="muted">起由第一组开始</span></label></div>` : ''}
        </div></section>

      ${plan.mode === 'fixed' ? html`<section class="card"><div class="card-head"><h3 class="grow">每周安排</h3><span class="faint" style="font-size:12.5px">点击格子选择学生</span></div>
        <div class="table-wrap"><table class="table duty-grid"><thead><tr><th>岗位</th>${plan.weekdays.map(d => html`<th>${WEEKDAY_NAMES[d]}</th>`)}</tr></thead>
        <tbody>${plan.tasks.map(t => html`<tr><td><b>${t.name}</b></td>${plan.weekdays.map(d => {
          const ids = plan.fixed[d]?.[t.id] || [];
          return html`<td><button type="button" class="duty-cell" data-cell="${d}|${t.id}" ${canEdit ? '' : 'disabled'}>${ids.length ? chips(ids) : html`<span class="faint">${canEdit ? '＋ 选择' : '—'}</span>`}</button></td>`;
        })}</tr>`)}</tbody></table></div></section>`
      : html`<section class="card"><div class="card-head"><h3 class="grow">值日小组</h3>
          ${canEdit ? html`<button type="button" class="btn sm" id="gby">${icon('users')}按名单中的小组生成</button><button type="button" class="btn sm" id="gsplit">平均分组</button><button type="button" class="btn sm primary" id="gadd">${icon('plus')}添加小组</button>` : ''}</div>
        <div class="card-body">${plan.groups.length ? html`<div class="group-grid">${plan.groups.map((g, i) => html`<div class="group-card">
            <div class="row"><span class="badge accent">${i + 1}</span><input class="input" data-gname="${i}" value="${g.name}" maxlength="20" ${canEdit ? '' : 'disabled'}>
              ${canEdit ? html`<button type="button" class="btn ghost sm icon-only danger" data-gdel="${i}" title="删除小组">${icon('trash')}</button>` : ''}</div>
            <button type="button" class="duty-cell" data-gmem="${i}" ${canEdit ? '' : 'disabled'}>${g.members.length ? chips(g.members) : html`<span class="faint">＋ 选择组员</span>`}</button>
          </div>`)}</div>` : empty('users', '还没有小组', '可以按名单中的“小组”一键生成，或平均分成若干组。')}
          <p class="faint" style="font-size:12.5px;margin-top:12px">轮到的小组按顺序分配岗位：第 1 位做第 1 个岗位，第 2 位做第 2 个岗位……人数多于岗位时循环分配。</p></div></section>`}

      <section class="card"><div class="card-head"><h3 class="grow">本周值日</h3>${dirty ? html`<span class="badge warn">保存后更新</span>` : ''}</div>
        <div class="week-grid">${res.week.map((d, i) => {
          const date = shiftDay(todayStr(), i + 1 - (new Date().getDay() || 7));
          return html`<div class="week-day ${date === todayStr() ? 'today' : ''}"><div class="week-head"><b>${WEEKDAY_NAMES[i + 1]}</b><span class="faint">${date.slice(5).replace('-', '/')}</span></div>
            ${d ? d.tasks.map(t => html`<div class="week-task"><span>${t.task}</span><b>${t.students.join('、')}</b></div>`) : html`<span class="faint" style="font-size:12.5px">休息</span>`}</div>`;
        })}</div></section>

      ${canEdit ? html`<div class="save-bar"><span class="faint grow">${res.updatedAt ? `上次保存：${res.updatedBy} · ${relTime(res.updatedAt)}` : '尚未保存'}　保存后班级大屏和公开页会立即显示今日值日。</span><button type="button" class="btn primary" id="ds">${icon('check')}保存安排</button></div>` : ''}
    </div>`);
    bind();
  };
  const touch = () => { dirty = true; render(); };
  const pickStudents = async (title, selected) => checklistModal({ title, items: active.map(x => ({ value: x.id, label: x.name, sub: [x.number, x.group].filter(Boolean).join(' · ') })), selected });
  const bind = () => {
    if (!canEdit) return;
    $$('#dm button').forEach(b => b.onclick = () => { plan.mode = b.dataset.v; touch(); });
    $$('#du button').forEach(b => b.onclick = () => { plan.unit = b.dataset.v; touch(); });
    $$('[data-day]').forEach(x => x.onchange = () => { const d = +x.dataset.day; plan.weekdays = x.checked ? [...plan.weekdays, d].sort() : plan.weekdays.filter(y => y !== d); touch(); });
    $$('[data-del-task]').forEach(b => b.onclick = () => { plan.tasks.splice(+b.dataset.delTask, 1); touch(); });
    const addTask = () => { const v = $('#nt').value.trim(); if (!v) return; plan.tasks.push({ id: shortId(), name: v }); touch(); $('#nt')?.focus(); };
    $('#ntb').onclick = addTask; $('#nt').onkeydown = e => { if (e.key === 'Enter') addTask(); };
    if ($('#da')) $('#da').onchange = e => { plan.anchor = e.target.value || todayStr(); dirty = true; };
    $$('[data-cell]').forEach(b => b.onclick = async () => {
      const [d, t] = b.dataset.cell.split('|');
      const task = plan.tasks.find(x => x.id === t);
      const ids = await pickStudents(`${WEEKDAY_NAMES[d]} · ${task.name}`, plan.fixed[d]?.[t] || []);
      if (!ids) return;
      (plan.fixed[d] ||= {})[t] = ids; touch();
    });
    $$('[data-gname]').forEach(x => x.oninput = () => { plan.groups[+x.dataset.gname].name = x.value; dirty = true; });
    $$('[data-gdel]').forEach(b => b.onclick = () => { plan.groups.splice(+b.dataset.gdel, 1); touch(); });
    $$('[data-gmem]').forEach(b => b.onclick = async () => {
      const g = plan.groups[+b.dataset.gmem];
      const ids = await pickStudents(`${g.name} · 组员`, g.members);
      if (ids) { g.members = ids; touch(); }
    });
    if ($('#gadd')) $('#gadd').onclick = () => { plan.groups.push({ name: `第${plan.groups.length + 1}组`, members: [] }); touch(); };
    if ($('#gby')) $('#gby').onclick = () => {
      const names = [...new Set(active.map(x => x.group).filter(Boolean))];
      if (!names.length) return toast('名单里还没有填写小组', 'error');
      plan.groups = names.map(n => ({ name: n, members: active.filter(x => x.group === n).map(x => x.id) })); touch();
    };
    if ($('#gsplit')) $('#gsplit').onclick = async () => {
      const r = await modal({ title: '平均分组', submit: '生成', body: html`<label class="field"><span>分成几组</span><input class="input" type="number" name="n" min="1" max="30" value="${Math.max(1, Math.min(10, Math.round(active.length / 4)))}"><small>按名单顺序依次分配，共 ${active.length} 名学生。</small></label>`, onSubmit: f => Math.max(1, Math.min(30, +f.n.value || 1)) });
      if (!r) return;
      plan.groups = Array.from({ length: r }, (_, i) => ({ name: `第${i + 1}组`, members: active.filter((_, k) => Math.floor(k * r / active.length) === i).map(x => x.id) }));
      touch();
    };
    $('#ds').onclick = async () => {
      try {
        await api(`/api/classes/${c.id}/duty`, { method: 'PUT', body: { expectedRevision: res.revision, plan } });
        toast('值日安排已保存'); reloadView();
      } catch (err) { fail(err); }
    };
  };
  render();
}

// ---------- 公告
function announcementForm(a = {}) {
  const local = v => { const d = parseTime(v); return d ? `${ymd(d)}T${hm(d)}` : ''; };
  return html`<label class="field"><span>标题</span><input class="input" name="title" value="${a.title || ''}" maxlength="60" placeholder="例如：明天上午体检"></label>
    <label class="field"><span>内容（可选）</span><textarea class="input" name="body" rows="4" maxlength="2000">${a.body || ''}</textarea></label>
    <div class="grid-2" style="gap:14px">
      <label class="field"><span>级别</span><select class="input" name="level">${Object.entries(LEVEL_LABEL).map(([k, v]) => html`<option value="${k}" ${(a.level || 'info') === k ? 'selected' : ''}>${v}${k === 'urgent' ? '（红色醒目）' : k === 'important' ? '（橙色醒目）' : ''}</option>`)}</select></label>
      <label class="check" style="align-self:end"><input type="checkbox" name="pinned" ${a.pinned ? 'checked' : ''}>置顶（同级别中排在最前）</label>
      <label class="field"><span>开始显示</span><input class="input" type="datetime-local" name="starts" value="${local(a.startsAt)}"><small>留空表示立即显示</small></label>
      <label class="field"><span>结束显示</span><input class="input" type="datetime-local" name="expires" value="${local(a.expiresAt)}"><small>留空表示一直显示</small></label>
    </div>`;
}
function announcementBody(f) {
  const title = f.title.value.trim(); if (!title) throw new Error('请输入标题');
  const iso = v => v ? new Date(v).toISOString() : null;
  return { title, body: f.body.value.trim(), level: f.level.value, pinned: f.pinned.checked, startsAt: iso(f.starts.value), expiresAt: iso(f.expires.value) };
}
function announcementCard(a, { showClass = false, actions = true } = {}) {
  return html`<article class="notice-card ${a.level} ${a.active ? '' : 'inactive'}">
    <div class="row">${levelBadge(a.level)}${a.pinned ? html`<span class="badge">${icon('pin', 'sm')}置顶</span>` : ''}${a.active ? '' : html`<span class="badge">${parseTime(a.startsAt) > new Date() ? '未开始' : '已结束'}</span>`}
      <b class="grow notice-title">${a.title}</b>
      ${actions ? html`<button class="btn ghost sm icon-only" data-act="edit-notice" data-id="${a.id}" title="编辑">${icon('edit')}</button><button class="btn ghost sm icon-only danger" data-act="del-notice" data-id="${a.id}" title="删除">${icon('trash')}</button>` : ''}</div>
    ${a.body ? html`<p class="notice-body">${a.body}</p>` : ''}
    <div class="faint" style="font-size:12px">${showClass ? a.className + ' · ' : ''}${a.author} · 发布于 ${relTime(a.createdAt)}${a.expiresAt ? ` · 显示到 ${fullTime(a.expiresAt)}` : ''}</div>
  </article>`;
}
async function classNotices(box, c) {
  const items = await api(`/api/classes/${c.id}/announcements`);
  box.innerHTML = show(html`
    <div class="toolbar"><span class="muted grow">生效中的公告会实时显示在班级大屏的班务条上（多条轮播，紧急和重要靠前），也会出现在公开页上。可在布局设置里改为只显示重要公告。</span><button class="btn primary" data-act="new-notice">${icon('plus')}发布公告</button></div>
    ${items.length ? html`<div class="stack">${items.map(a => announcementCard(a))}</div>` : html`<div class="card">${empty('megaphone', '还没有公告', '发布后会实时推送到班级大屏。')}</div>`}`);
  const find = id => items.find(a => a.id === id);
  Object.assign(viewActions, {
    'new-notice': async () => {
      const others = (state.classes || []).filter(x => x.id !== c.id);
      const r = await modal({
        title: '发布公告', submit: '发布', wide: true,
        body: html`${announcementForm()}${others.length ? html`<div class="field"><span>同时发到其他班级（可选）</span><div class="checklist">${others.map(x => html`<label class="check"><input type="checkbox" name="cls" value="${x.id}">${x.name}</label>`)}</div></div>` : ''}`,
        onSubmit: f => {
          const body = announcementBody(f), ids = $$('input[name=cls]:checked', f).map(x => x.value);
          return ids.length ? api('/api/announcements/broadcast', { method: 'POST', body: { classIds: [c.id, ...ids], ...body } }) : api(`/api/classes/${c.id}/announcements`, { method: 'POST', body });
        }
      });
      if (r) { toast(r.count > 1 ? `已发布到 ${r.count} 个班级` : '公告已发布'); reloadView(); }
    },
    'edit-notice': async el => { const a = find(el.dataset.id); if (await modal({ title: '编辑公告', submit: '保存', wide: true, body: announcementForm(a), onSubmit: f => api(`/api/classes/${c.id}/announcements/${a.id}`, { method: 'PUT', body: announcementBody(f) }) })) { toast('公告已更新'); reloadView(); } },
    'del-notice': async el => { const a = find(el.dataset.id); if (!await confirmDialog({ title: '删除公告', message: `删除“${a.title}”？大屏上会立即撤下。`, confirm: '删除' })) return; await api(`/api/classes/${c.id}/announcements/${a.id}`, { method: 'DELETE' }); toast('已删除'); reloadView(); }
  });
}

// ---------- 大屏设置
/**
 * 班级的大屏设置：左侧导航与大屏设置窗口相同（布局 / 外观 / 组件 / 自动填充 / 数据），每页的设置项、顺序与名称
 * 来自服务端清单（/api/settings-schema），右侧预览用 board.js 按大屏同样的结构绘制。布局页的预览是可拖动的整屏：
 * 拖动分隔条调整分屏比例，拖动磁贴移动、拖右下角调整大小，自由布局下拖动组件。
 * 保存时只提交改动的键，服务端按键合并，大屏上同时修改的其他设置不会被覆盖。
 */
const BOARD_W = 1600, BOARD_H = 900;
const TILE_MIN = { w: 280, h: 96 }, TILE_MAX = { w: 900, h: 680 };
const SETTING_ICON = { layout: 'layout', board: 'book', image: 'image', palette: 'palette', grid: 'layout', settings: 'settings', components: 'device', clock: 'history',
  weather: 'sun', mic: 'megaphone', megaphone: 'megaphone', book: 'student', edit: 'edit', db: 'db' };
let weatherCities = null;
const loadWeatherCities = async () => weatherCities ??= await fetch('weather-cities.json').then(r => r.json()).catch(() => []);

/** 设置清单里的显示条件："Key"、"!Key"、"Key=A|B"、"Key^=前缀"、"Key$=后缀"，用 & 连接。 */
function settingCondition(expr, current) {
  if (!expr) return true;
  return expr.split('&').every(raw => {
    const neg = raw.startsWith('!'), part = neg ? raw.slice(1) : raw;
    const m = /^(.+?)(\^=|\$=|=)(.*)$/.exec(part);
    let ok;
    if (m) { const v = String(current(m[1]) ?? ''); ok = m[2] === '=' ? m[3].split('|').includes(v) : m[2] === '^=' ? v.startsWith(m[3]) : v.endsWith(m[3]); }
    else ok = !!current(part);
    return neg ? !ok : ok;
  });
}

const toggleHtml = (attrs, on) => html`<label class="toggle"><input type="checkbox" ${raw(attrs)} ${on ? 'checked' : ''}><span class="track"></span><span class="state">${on ? '开' : '关'}</span></label>`;
const swatchHtml = (attrs, color, label) => html`<label class="btn sm swatch-btn"><i style="--sw:${color}"></i>${label}<input type="color" ${raw(attrs)} value="${/^#[0-9a-f]{6}$/i.test(color) ? color : '#808080'}"></label>`;
const rgbOf = hex => typeof hex === 'string' && hex.length >= 7 ? '#' + hex.slice(-6) : '';
/** 滑块旁的数值：0–1 的比例显示为百分比，其余按单位显示。 */
function settingValueText(s, v) {
  if (s.unit === '×') return (+v).toFixed(2) + '×';
  if (!s.unit && s.min >= 0 && s.max <= 1) return Math.round(v * 100) + '%';
  return `${+(+v).toFixed(2)}${s.unit ? ' ' + s.unit : ''}`;
}

/** 一项设置的控件；外观照大屏设置页：开关、滑块、下拉框、颜色按钮、九宫格与背景编辑器。 */
function settingControl(s, ctx) {
  const v = ctx.current(s.key), hint = s.hint ? html`<small>${s.hint}</small>` : '';
  const item = (body, cls = '') => html`<div class="set-item ${cls}" data-item="${s.key}">${body}${hint}</div>`;
  switch (s.kind) {
    case 'Bool': return item(html`<div class="set-label">${s.label}</div>${toggleHtml(`data-k="${esc(s.key)}"`, v)}`);
    case 'Number':
      if (s.variant === 'NumberBox') return item(html`<div class="set-label">${s.label}</div>
        <div class="set-number"><input type="number" data-k="${s.key}" min="${s.min}" max="${s.max}" step="${s.step || 1}" value="${v}"><button type="button" data-step="-1" data-for="${s.key}">−</button><button type="button" data-step="1" data-for="${s.key}">+</button></div>`);
      return item(html`<div class="set-label">${s.label}<b data-out="${s.key}">${settingValueText(s, v)}</b></div>
        <input type="range" data-k="${s.key}" min="${s.min}" max="${s.max}" step="${s.step || 1}" value="${v}">`);
    case 'Enum':
      if (s.variant === 'Position') {
        const cell = { TopLeft: [1, 1, 'start', 'start'], TopCenter: [1, 2, 'center', 'start'], TopRight: [1, 3, 'end', 'start'], CenterLeft: [2, 1, 'start', 'center'], CenterRight: [2, 3, 'end', 'center'], BottomLeft: [3, 1, 'start', 'end'], BottomCenter: [3, 2, 'center', 'end'], BottomRight: [3, 3, 'end', 'end'] };
        return item(html`<div class="set-label">${s.label}</div><div class="pos-picker">${s.options.map(o => { const [r, c, jx, jy] = cell[o.value];
          return html`<label title="${o.label}" style="grid-row:${r};grid-column:${c};justify-content:${jx};align-items:${jy}"><input type="radio" name="pos-${s.key}" data-k="${s.key}" value="${o.value}" ${o.value === v ? 'checked' : ''} aria-label="${o.label}"><span></span></label>`; })}</div>`);
      }
      return item(html`<div class="set-label">${s.label}</div><select class="input" data-k="${s.key}">${s.options.map(o => html`<option value="${o.value}" ${o.value === v ? 'selected' : ''}>${o.label}</option>`)}</select>`);
    case 'Font':
      return item(html`<div class="set-label">${s.label}</div><input class="input" data-k="${s.key}" list="set-fonts" value="${v || ''}" placeholder="${s.default === '' ? '默认（内置 HarmonyOS Sans SC）' : s.default}" autocomplete="off">`);
    case 'Color': {
      const t = Board.theme(ctx.doc());
      if (s.variant === 'Surface') {
        const cleared = !!ctx.current(s.clearedKey), opacity = +(ctx.current(s.opacityKey) ?? 1);
        const shown = cleared ? 'transparent' : v ? rgbOf(v) : t.surface;
        return item(html`<div class="set-label">${s.label}</div>
          <div class="set-row" data-surface="${s.key}">${swatchHtml('data-sc="color"', shown, '背景颜色')}
            <button type="button" class="btn sm" data-sc="clear" ${cleared ? 'disabled' : ''}>清除背景颜色</button>
            <button type="button" class="btn sm" data-sc="reset">恢复主题背景色</button></div>
          <div class="set-item ${cleared ? 'disabled' : ''}"><div class="set-label">背景颜色透明度（%）<b data-out="${s.opacityKey}">${Math.round((1 - opacity) * 100)}%</b></div>
            <input type="range" min="0" max="100" step="1" value="${Math.round((1 - opacity) * 100)}" data-sc="transparency" data-for="${s.key}"></div>
          <small>透明度只影响背景颜色：0% 不透明，100% 完全透明。清除颜色会保留已开启的毛玻璃效果和背景媒体。</small>`);
      }
      const themed = s.key === 'ClockColor' ? t.text : s.key === 'ToolbarBorderColor' ? t.line : '#808080';
      const alpha = typeof v === 'string' && v.length === 9;
      const reset = s.default === '' ? html`<button type="button" class="btn sm" data-cr="${s.key}">${s.key === 'ClockColor' ? '恢复主题颜色' : s.key === 'ToolbarBorderColor' ? '恢复主题边框色' : '恢复默认'}</button>` : '';
      return item(html`<div class="set-label">${s.label}</div><div class="set-row">${swatchHtml(`data-k="${esc(s.key)}" data-part="rgb"`, rgbOf(v) || themed, s.label)}${reset}
        ${alpha || /^#[0-9A-F]{8}$/i.test(s.default) ? html`<span class="set-row" style="gap:6px;font-size:12.5px;color:var(--text-2)">不透明度<input type="range" min="0" max="255" data-k="${s.key}" data-part="alpha" value="${alpha ? parseInt(v.slice(1, 3), 16) : 255}" style="width:120px"><b data-out="${s.key}">${Math.round((alpha ? parseInt(v.slice(1, 3), 16) : 255) / 2.55)}%</b></span>` : ''}</div>`);
    }
    case 'Background': return backgroundControl(s, ctx);
    default: return '';
  }
}

/** 背景编辑器，与大屏的 BackgroundEditor 相同：区域背景只有颜色按钮，面板背景（磁贴）带透明度与清除。 */
function backgroundControl(s, ctx) {
  const b = ctx.current(s.key) || {}, surface = s.variant === 'Surface', t = Board.theme(ctx.doc());
  const doc = ctx.doc(), sharedUsed = (doc.LayoutMode || 'Split') === 'Split' && doc.SharedBackgroundEnabled;
  const mediaLocked = (s.key === 'ClockBackground' || s.key === 'BoardBackground') && sharedUsed;
  const chip = (p, i) => {
    const m = ASSET_RE.exec(p || ''), src = m && ctx.assetUrl(m[1].toLowerCase());
    const inner = !m ? html`<span title="${p}">大屏本地文件</span>` : IMAGE_EXT.test(m[2] || '') ? html`<img src="${src}" alt="">` : html`<video src="${src}" muted></video>`;
    return html`<span class="media-chip">${inner}${i != null ? html`<button type="button" class="att-x" data-bg-act="del-item" data-i="${i}" title="移除">${icon('x', 'sm')}</button>` : ''}</span>`;
  };
  const list = b.Playlist || [];
  const opacity = b.ColorOpacity ?? .8;
  return html`<div class="set-block" data-item="${s.key}" data-bg="${s.key}">
    ${surface ? html`<div class="set-row">${swatchHtml('data-bf="Color"', b.ColorCleared ? 'transparent' : rgbOf(b.Color) || t.surface, '背景颜色')}
        <button type="button" class="btn sm" data-bg-act="clear-color" ${b.ColorCleared ? 'disabled' : ''}>清除背景颜色</button>
        <button type="button" class="btn sm" data-bg-act="reset-color">恢复主题背景色</button></div>
      <div class="set-item ${b.ColorCleared ? 'disabled' : ''}"><div class="set-label">背景颜色透明度（%）<b>${Math.round((1 - opacity) * 100)}%</b></div>
        <input type="range" min="0" max="100" step="1" value="${Math.round((1 - opacity) * 100)}" data-bf="Transparency"></div>
      <small>透明度只影响背景颜色：0% 不透明，100% 完全透明。清除颜色会保留已开启的毛玻璃效果和背景媒体。</small>` : ''}
    <div class="set-block ${mediaLocked ? 'disabled' : ''}">
      ${surface ? '' : html`<div class="set-row">${swatchHtml('data-bf="Color"', rgbOf(b.Color) || t.surface, '背景颜色')}<button type="button" class="btn sm" data-bg-act="reset-color">恢复主题背景色</button></div>`}
      <div class="set-item"><div class="set-label">背景媒体</div>
        <div class="set-row">${b.ImagePath && !b.PlaylistEnabled ? chip(b.ImagePath) : ''}<button type="button" class="btn sm" data-bg-act="pick">${icon('upload')}选择图片或视频</button></div></div>
      <div class="set-item"><div class="set-label">播放队列模式</div>${toggleHtml('data-bf="PlaylistEnabled"', b.PlaylistEnabled)}</div>
      ${b.PlaylistEnabled ? html`<div class="set-sub">
        <div class="media-list">${list.map((p, i) => chip(p, i))}${list.length ? '' : html`<small>队列为空，请添加图片或视频。</small>`}</div>
        <div><button type="button" class="btn sm" data-bg-act="add-items">${icon('plus')}添加多个媒体</button></div>
        <div class="set-item"><div class="set-label">随机播放</div>${toggleHtml('data-bf="Shuffle"', b.Shuffle)}</div>
        <div class="set-item"><div class="set-label">按固定时间切换</div>${toggleHtml('data-bf="SwitchOnTimer"', b.SwitchOnTimer !== false)}</div>
        <div class="set-item ${b.SwitchOnTimer === false ? 'disabled' : ''}"><div class="set-label">切换间隔（秒）</div><div class="set-number"><input type="number" min="1" max="86400" data-bf="SwitchIntervalSeconds" value="${b.SwitchIntervalSeconds ?? 60}"></div></div>
        <div class="set-item"><div class="set-label">视频播放完成时切换</div>${toggleHtml('data-bf="SwitchOnMediaEnded"', b.SwitchOnMediaEnded !== false)}</div>
        <small>两种切换都开启时，先触发的条件生效。关闭播放完成切换后视频循环播放；两个开关都关闭时停留在当前媒体。</small></div>` : ''}
      <div class="set-item"><div class="set-label">图片模式</div><select class="input" data-bf="ImageMode">${[['Zoom', '缩放'], ['Stretch', '拉伸'], ['Fit', '适应']].map(([k, l]) => html`<option value="${k}" ${(b.ImageMode || 'Zoom') === k ? 'selected' : ''}>${l}</option>`)}</select></div>
      <div><button type="button" class="btn sm" data-bg-act="clear-media" ${b.ImagePath || list.length ? '' : 'disabled'}>清除背景媒体</button></div>
      ${mediaLocked ? html`<small>已开启跨区背景，区域底图由跨区背景统一管理。</small>` : ''}
    </div>
    <div class="set-item"><div class="set-label">毛玻璃效果</div>${toggleHtml('data-bf="Glass"', b.Glass)}</div>
    <div class="set-item ${b.Glass ? '' : 'disabled'}"><div class="set-label">模糊程度<b>${Math.round(b.Blur ?? 20)}</b></div><input type="range" min="0" max="100" step="1" data-bf="Blur" value="${b.Blur ?? 20}"></div>
  </div>`;
}

/** 项目里的科目转为预览磁贴：位置、大小、主题色、正文富文本与图片和大屏一致。 */
function boardTiles(detail, assetUrl) {
  let doc = {}; try { doc = JSON.parse(detail.payloadJson || '{}'); } catch { }
  const rawSubjects = pick(doc, 'Subjects') || [];
  return parseProject(detail.payloadJson, detail.runs).filter(s => s.rect.w > 0).map(s => ({
    index: s.index, name: s.name, accent: s.color || '#818CF8', explicit: !!pick(rawSubjects[s.index], 'IsAccentExplicit'),
    x: s.rect.x, y: s.rect.y, w: s.rect.w, h: s.rect.h,
    entries: s.entries.map(e => ({ runs: e.runs, images: e.atts.map(a => assetImage(a, assetUrl)).filter(Boolean) }))
  }));
}

async function classLayout(box, c) {
  const [layout, schema, projects, classes, history, duty, fonts] = await Promise.all([
    api(`/api/classes/${c.id}/layout`), api('/api/settings-schema'), api(`/api/classes/${c.id}/projects`), api('/api/classes'),
    api(`/api/classes/${c.id}/layout/history`).catch(() => []), myDuty(c.id), api(`/api/classes/${c.id}/fonts`).catch(() => ['HarmonyOS Sans SC'])]);
  const canPolicy = isAdmin() || duty === 'HeadTeacher';
  const assetUrl = consoleAsset(c.id);
  let saved = {}; try { saved = JSON.parse(layout.payloadJson || '{}'); } catch { }
  const byKey = Object.fromEntries(schema.settings.map(s => [s.key, s]));
  const pages = [...schema.pages, { key: 'Sync', nav: null, title: '同步与历史', description: '设置大屏与网页之间的同步方式，查看和恢复历史版本。', icon: 'sync' }];
  const draft = {};
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const current = k => k in draft ? draft[k] : saved[k] !== undefined ? saved[k] : byKey[k]?.default;
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const setValue = (k, v) => { const base = saved[k] !== undefined ? saved[k] : byKey[k]?.default; if (same(v, base)) delete draft[k]; else draft[k] = v; };
  const doc = () => { const d = { ...saved }; for (const s of schema.settings) d[s.key] = current(s.key); return d; };
  const ctx = { current, doc, assetUrl };
  let page = pages.some(p => p.key === store.get('settingsPage')) ? store.get('settingsPage') : 'Layout';

  // 预览里的磁贴取自最近的项目，只作参照；磁贴位置和作业内容在“作业”画布里调整。
  const live = projects.filter(p => !p.deleted).sort((a, b) => (b.date || '').localeCompare(a.date || '') || parseTime(b.updatedAt) - parseTime(a.updatedAt));
  const tileProject = live[0] || null;
  const tiles = tileProject ? boardTiles(await api(`/api/classes/${c.id}/projects/${tileProject.id}`), assetUrl).map(t => ({ ...t, locked: true, cls: 'locked' })) : [];
  setLeaveGuard(() => Object.keys(draft).length ? '大屏设置有未保存的修改，离开后会丢失。' : '');

  const navIcon = p => icon(SETTING_ICON[p.icon] || p.icon || 'settings');
  box.innerHTML = show(html`<div class="set-shell" id="ss">
      <nav class="card set-nav" id="sn" aria-label="设置分类"></nav>
      <div class="set-page" id="sp"></div>
      <aside class="set-preview" id="pv"><div class="set-preview-frame"><div id="pv-stage"></div></div><div id="pv-bar"></div></aside>
    </div>
    <datalist id="set-fonts">${[...new Set(['HarmonyOS Sans SC', ...fonts])].map(f => html`<option value="${f}">`)}</datalist>
    <div class="savebar" id="savebar" hidden><span class="grow" id="sb-text"></span><button class="btn" data-act="discard-settings">撤销修改</button><button class="btn primary" data-act="save-settings">${icon('send')}保存并下发</button></div>`);
  const nav = $('#sn'), sp = $('#sp'), stage = $('#pv-stage');

  function renderNav() {
    const dirtyPages = new Set(Object.keys(draft).map(k => byKey[k]?.page));
    let lastNav = null, out = '';
    for (const p of pages) {
      if (p.key === 'Sync') out += '<hr>';
      if (p.nav && p.nav !== lastNav) out += `<div class="set-nav-group">${esc(p.nav)}</div>`;
      lastNav = p.nav;
      out += show(html`<a href="#" data-page="${p.key}" class="${p.nav ? 'sub' : ''} ${p.key === page ? 'active' : ''}">${navIcon(p)}<span>${p.title}</span>${dirtyPages.has(p.key) ? html`<span class="dirty" title="有未保存的修改"></span>` : ''}</a>`);
    }
    nav.innerHTML = out;
  }

  const policies = [['Shared', '双向同步', '大屏上调整的设置会上传，网页修改会下发到所有大屏。不同设置可以同时修改。'], ['Managed', '网页统一下发', '只能在网页修改；大屏上的改动会被还原。'], ['Off', '不同步', '每块大屏各自保存设置。']];
  function renderPage() {
    const p = pages.find(x => x.key === page);
    const head = html`<div class="set-page-head"><h2>${p.title}</h2><p>${p.description}</p></div>`;
    if (page === 'Sync') {
      sp.innerHTML = show(html`${head}
        <section class="card set-card"><div class="set-section" style="margin:0">同步策略</div>
          ${policies.map(([k, l, d]) => html`<label class="policy ${layout.policy === k ? 'active' : ''}"><input type="radio" name="policy" value="${k}" ${layout.policy === k ? 'checked' : ''} ${canPolicy ? '' : 'disabled'}><span><b>${l}</b><small>${d}</small></span></label>`)}
          ${canPolicy ? '' : html`<small class="faint">同步策略由管理员或班主任设置。</small>`}</section>
        <section class="card"><div class="card-head"><h3 class="grow">历史版本</h3><button class="btn sm" data-act="copy-layout" ${layout.revision ? '' : 'disabled'}>${icon('copy')}复制到其他班级</button></div>
          ${history.length ? html`<div class="list-rows">${history.slice(0, 12).map((h, i) => html`<div class="list-row"><span class="grow"><span class="title" style="display:block">修订 ${h.revision}${i === 0 ? html` <span class="badge ok">当前</span>` : ''}</span><span class="meta">${h.author} · ${relTime(h.createdAt)}</span></span>
            ${i === 0 ? '' : html`<button class="btn ghost sm" data-act="restore-layout" data-rev="${h.revision}">${icon('restore')}恢复</button>`}</div>`)}</div>`
            : html`<div class="card-body faint" style="font-size:13px">大屏连接集控后会自动上传当前设置；也可以直接在这里修改后下发。</div>`}</section>`);
      $$('input[name=policy]', sp).forEach(r => r.onchange = async () => {
        try { await api(`/api/classes/${c.id}/layout/policy`, { method: 'PUT', body: { policy: r.value } }); toast('同步策略已更新'); route(); } catch (err) { fail(err); }
      });
      return;
    }
    const items = schema.settings.filter(s => s.page === page && !s.hidden);
    // 同一小标题下的设置放进同一张卡片；没有小标题的放在页首卡片。
    const cards = [];
    for (const s of items) { const sec = s.section || ''; if (!cards.length || cards.at(-1).section !== sec) cards.push({ section: sec, items: [] }); cards.at(-1).items.push(s); }
    const extra = page === 'ComponentsWeather' ? html`<div class="set-item"><div class="set-label">地区</div><input class="input" list="wc" id="weather-city" value="${current('WeatherCityName')}" placeholder="搜索城市" autocomplete="off"><datalist id="wc"></datalist><small>从列表中选择后生效。</small></div>` : '';
    sp.innerHTML = show(html`${head}
      ${cards.map((card, i) => html`${card.section ? html`<div class="set-section">${card.section}</div>` : ''}<section class="card set-card">${i === 0 ? extra : ''}${card.items.map(s => settingControl(s, ctx))}</section>`)}
      ${p.note ? html`<div class="set-note">${p.note}</div>` : ''}`);
    applyConditions();
  }
  /** 按清单里的 When / EnableWhen 显示或停用设置项，与大屏设置页的联动一致。 */
  function applyConditions() {
    for (const el of $$('[data-item]', sp)) {
      const s = byKey[el.dataset.item]; if (!s) continue;
      el.hidden = !settingCondition(s.when, current);
      el.classList.toggle('disabled', !settingCondition(s.enableWhen, current));
    }
  }
  const rerenderItem = key => {
    const el = $(`[data-item="${CSS.escape(key)}"]`, sp); if (!el) return;
    const tmp = document.createElement('div'); tmp.innerHTML = show(settingControl(byKey[key], ctx));
    el.replaceWith(tmp.firstElementChild); applyConditions();
  };

  // ---------- 预览
  let previewQueued = false, clockTimer = 0;
  const previewKind = () => pages.find(x => x.key === page)?.preview;
  function schedulePreview() { if (previewQueued) return; previewQueued = true; requestAnimationFrame(() => { previewQueued = false; renderPreview(); }); }
  function renderPreview() {
    const kind = previewKind(), d = doc(), t = Board.theme(d);
    $('#ss').classList.toggle('no-preview', !kind);
    stage.classList.toggle('pk-interactive', kind === 'Layout');
    if (!kind) { stage.innerHTML = ''; $('#pv-bar').innerHTML = ''; return; }
    const full = kind === 'Layout' || kind === 'Background' || kind === 'Board';
    const html_ = full
      ? Board.screen(d, t, BOARD_W, BOARD_H, { tiles, interactive: kind === 'Layout', assetUrl, placeholder: tiles.length ? '' : `<div class="pk-center" style="color:${t.text};opacity:.5;font-size:28px">${tileProject ? '这个项目还没有摆放磁贴' : '暂无项目'}</div>` })
      : Board.sample(kind, d, t, { assetUrl });
    Board.mount(stage, html_, d);
  }
  function renderPreviewBar() {
    const kind = previewKind();
    const bar = $('#pv-bar');
    if (kind === 'Layout' || kind === 'Background' || kind === 'Board') {
      bar.innerHTML = show(html`<div class="set-preview-bar"><span class="grow">磁贴取自“${tileProject?.name || '暂无项目'}”，仅作参照</span>
          <a class="btn sm" href="#/classes/${c.id}/homework${tileProject ? '/' + tileProject.id : ''}">${icon('book')}去作业里调整磁贴</a></div>
        <small class="faint">${kind === 'Layout' ? '拖动分隔条调整分屏比例；自由布局下可以拖动时钟与组件。磁贴的位置、大小和作业内容在「作业」画布里一起修改。' : '按大屏整屏比例显示。'}
          ${layout.revision ? `修订 ${layout.revision} · ${layout.updatedBy || ''} · ${relTime(layout.updatedAt)}` : '大屏尚未上传设置'}</small>`);
    } else bar.innerHTML = show(html`<small class="faint">预览使用与大屏相同的字体、图标和尺寸，随设置即时变化。</small>`);
  }
  function showPage(key) {
    page = key; store.set('settingsPage', key);
    renderNav(); renderPage(); renderPreviewBar(); renderPreview();
  }
  // 预览里的时钟与大屏一样走秒。
  clockTimer = setInterval(() => {
    const now = new Date(), p2 = n => String(n).padStart(2, '0');
    for (const el of $$('.pk-time-main', stage)) el.textContent = `${p2(now.getHours())}:${p2(now.getMinutes())}`;
    for (const el of $$('.pk-time-sec', stage)) el.textContent = p2(now.getSeconds());
  }, 1000);
  onDispose(() => clearInterval(clockTimer));
  Board.fontsReady.then(() => schedulePreview());

  function refresh() {
    const keys = Object.keys(draft);
    renderNav();
    $('#savebar').hidden = keys.length === 0;
    $('#sb-text').textContent = `有 ${keys.length} 项设置未保存：${keys.map(k => byKey[k]?.label || k).slice(0, 6).join('、')}${keys.length > 6 ? ' 等' : ''}`;
    applyConditions();
    schedulePreview();
  }

  // ---------- 布局页的拖动
  let drag = null;
  const scenePoint = e => { const scene = $('.pk-scene', stage), r = scene.getBoundingClientRect(), s = stage._pkScale || 1; return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s }; };
  stage.addEventListener('pointerdown', e => {
    if (previewKind() !== 'Layout') return;
    const p = scenePoint(e), widget = e.target.closest('[data-widget]'), split = e.target.closest('[data-split]');
    if (widget) { const widgets = clone(current('Widgets')) || {}; drag = { kind: 'widget', key: widget.dataset.widget, widgets, el: widget, p, x: widgets[widget.dataset.widget].X, y: widgets[widget.dataset.widget].Y }; }
    else if (split) drag = { kind: 'split' };
    if (drag) { stage.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  stage.addEventListener('pointermove', e => {
    if (!drag) return;
    const p = scenePoint(e);
    if (drag.kind === 'split') { draft.SplitRatio = Math.round(Math.min(.9, Math.max(.1, p.x / BOARD_W)) * 100) / 100; schedulePreview(); return; }
    const dx = p.x - drag.p.x, dy = p.y - drag.p.y;
    if (drag.kind === 'widget') {
      const r = drag.widgets[drag.key]; r.X = Math.round(Math.max(0, Math.min(BOARD_W - r.Width, drag.x + dx))); r.Y = Math.round(Math.max(0, Math.min(BOARD_H - r.Height, drag.y + dy)));
      Object.assign(drag.el.style, { left: r.X + 'px', top: r.Y + 'px' });
    }
  });
  const endDrag = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'split') { const v = draft.SplitRatio; delete draft.SplitRatio; setValue('SplitRatio', v); const r = $('[data-k=SplitRatio]', sp); if (r) { r.value = v; $('[data-out=SplitRatio]', sp).textContent = settingValueText(byKey.SplitRatio, v); } }
    if (d.kind === 'widget') setValue('Widgets', d.widgets);
    refresh();
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  // ---------- 设置项的输入
  nav.addEventListener('click', e => { const a = e.target.closest('[data-page]'); if (!a) return; e.preventDefault(); showPage(a.dataset.page); });
  sp.addEventListener('input', e => {
    const el = e.target;
    if (el.dataset.k && el.type !== 'radio') {
      const s = byKey[el.dataset.k];
      if (s.kind === 'Bool') { setValue(s.key, el.checked); el.nextElementSibling.nextElementSibling.textContent = el.checked ? '开' : '关'; }
      else if (s.kind === 'Number') {
        if (el.type === 'number' && (el.value === '' || !Number.isFinite(+el.value))) return;
        const v = Math.min(s.max, Math.max(s.min, +el.value)); setValue(s.key, v);
        const out = $(`[data-out="${CSS.escape(s.key)}"]`, sp); if (out) out.textContent = settingValueText(s, v);
      }
      else if (s.kind === 'Color') {
        const item = el.closest('[data-item]'), rgb = $('[data-part=rgb]', item).value.slice(1).toUpperCase(), alphaEl = $('[data-part=alpha]', item);
        let v = alphaEl ? '#' + (+alphaEl.value).toString(16).padStart(2, '0').toUpperCase() + rgb : '#' + rgb;
        // 时钟颜色选纯黑或纯白时视为跟随主题，与大屏一致。
        if (s.key === 'ClockColor' && (rgb === '000000' || rgb === 'FFFFFF')) v = '';
        setValue(s.key, v);
        if (alphaEl) $(`[data-out="${CSS.escape(s.key)}"]`, item).textContent = Math.round(alphaEl.value / 2.55) + '%';
        $('.swatch-btn i', item).style.setProperty('--sw', '#' + rgb);
      }
      else if (s.kind === 'Enum') setValue(s.key, el.value);
      else if (s.kind === 'Font') return;
      if (s.kind === 'Bool' || s.kind === 'Enum') for (const k of ['ClockBackground', 'BoardBackground']) if (s.key === 'SharedBackgroundEnabled' || s.key === 'LayoutMode') rerenderItem(k);
    } else if (el.dataset.sc) {
      const box = el.closest('[data-surface]') || el, key = box.dataset.surface || el.dataset.for, s = byKey[key];
      if (el.dataset.sc === 'color') { setValue(s.clearedKey, false); setValue(key, el.value.toUpperCase()); rerenderItem(key); }
      if (el.dataset.sc === 'transparency') { const v = Math.round(1000 - +el.value * 10) / 1000; setValue(s.opacityKey, v); $(`[data-out="${CSS.escape(s.opacityKey)}"]`, sp).textContent = el.value + '%'; }
    } else if (el.dataset.bf) {
      const key = el.closest('[data-bg]').dataset.bg, b = { ...(clone(current(key)) || {}) }, f = el.dataset.bf;
      if (f === 'Color') { b.Color = el.value.toUpperCase(); b.ColorCleared = false; }
      else if (f === 'Transparency') { b.ColorOpacity = Math.round(1000 - +el.value * 10) / 1000; el.previousElementSibling.querySelector('b').textContent = el.value + '%'; }
      else if (el.type === 'checkbox') b[f] = el.checked;
      else if (el.type === 'range' || el.type === 'number') { if (!Number.isFinite(+el.value) || el.value === '') return; b[f] = f === 'SwitchIntervalSeconds' ? Math.min(86400, Math.max(1, +el.value)) : +el.value; if (el.type === 'range') el.previousElementSibling.querySelector('b').textContent = Math.round(+el.value); }
      else b[f] = el.value;
      setValue(key, b);
      if (el.type === 'checkbox' || f === 'Color') rerenderItem(key);
    } else return;
    refresh();
  });
  sp.addEventListener('change', async e => {
    const el = e.target;
    if (el.id === 'weather-city') {
      const city = (await loadWeatherCities()).find(x => x.Name === el.value.trim());
      if (!city) return toast('请从列表中选择地区', 'error');
      setValue('WeatherCityName', city.Name); setValue('WeatherCityCode', city.Code); return refresh();
    }
    if (!el.dataset.k) return;
    const s = byKey[el.dataset.k];
    if (s.kind === 'Font') { setValue(s.key, el.value.trim()); refresh(); }
    if (el.type === 'radio') { setValue(s.key, el.value); applyConditions(); refresh(); }
  });
  sp.addEventListener('focusin', async e => {
    if (e.target.id !== 'weather-city' || $('#wc').childElementCount) return;
    $('#wc').innerHTML = (await loadWeatherCities()).map(x => `<option value="${esc(x.Name)}">`).join('');
  });
  const uploadMedia = multiple => new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*,video/*'; input.multiple = multiple;
    input.onchange = async () => {
      const refs = [];
      for (const file of input.files) {
        try {
          const r = await fetch(`/api/classes/${c.id}/assets?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { authorization: 'Bearer ' + state.token }, body: file });
          if (!r.ok) throw new Error((await r.text().catch(() => '')).replace(/^"|"$/g, '') || '上传失败');
          refs.push((await r.json()).reference);
        } catch (err) { toast(`“${file.name}”上传失败：${err.message}`, 'error'); }
      }
      resolve(refs);
    };
    input.click();
  });
  sp.addEventListener('click', async e => {
    const step = e.target.closest('[data-step]');
    if (step) {
      const s = byKey[step.dataset.for], input = $(`input[data-k="${CSS.escape(s.key)}"]`, sp);
      const v = Math.min(s.max, Math.max(s.min, (+input.value || 0) + (+step.dataset.step) * (s.step || 1)));
      input.value = v; setValue(s.key, v); return refresh();
    }
    const cr = e.target.closest('[data-cr]');
    if (cr) { setValue(cr.dataset.cr, ''); rerenderItem(cr.dataset.cr); return refresh(); }
    const sc = e.target.closest('button[data-sc]');
    if (sc) {
      const key = sc.closest('[data-surface]').dataset.surface, s = byKey[key];
      if (sc.dataset.sc === 'clear') { setValue(key, ''); setValue(s.clearedKey, true); }
      if (sc.dataset.sc === 'reset') { setValue(key, ''); setValue(s.clearedKey, false); }
      rerenderItem(key); return refresh();
    }
    const btn = e.target.closest('[data-bg-act]'); if (!btn) return;
    const key = btn.closest('[data-bg]').dataset.bg, b = { ...(clone(current(key)) || {}) };
    const act = btn.dataset.bgAct;
    if (act === 'pick') { const [ref] = await uploadMedia(false); if (!ref) return; b.ImagePath = ref; b.PlaylistEnabled = false; }
    if (act === 'clear-media') { b.ImagePath = ''; b.Playlist = []; }
    if (act === 'clear-color') { b.Color = ''; b.ColorCleared = true; }
    if (act === 'reset-color') { b.Color = ''; b.ColorCleared = false; }
    if (act === 'add-items') { const refs = await uploadMedia(true); if (!refs.length) return; b.Playlist = [...(b.Playlist || []), ...refs]; b.PlaylistEnabled = true; }
    if (act === 'del-item') b.Playlist = (b.Playlist || []).filter((_, i) => i !== +btn.dataset.i);
    setValue(key, b); rerenderItem(key); refresh();
  });

  // 其他大屏或网页修改了设置：没有未保存的修改时直接刷新，否则提醒。
  let remoteTimer;
  onDispose(liveSocket(`/ws/classes/${c.id}?access_token=${encodeURIComponent(state.token)}`, ev => {
    if (ev.type !== 'layout') return;
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(() => {
      if (!Object.keys(draft).length) route();
      else toast('班级设置刚在其他地方被修改，保存时会自动合并不冲突的部分', 'error');
    }, 500);
  }));
  onDispose(() => clearTimeout(remoteTimer));

  Object.assign(viewActions, {
    'discard-settings': () => { for (const k of Object.keys(draft)) delete draft[k]; renderPage(); refresh(); },
    'save-settings': async el => {
      if (layout.policy === 'Off' && !await confirmDialog({ title: '布局同步已关闭', message: '本班当前设置为“不同步”，保存的设置不会下发到大屏。仍要保存吗？', confirm: '保存', danger: false })) return;
      el.disabled = true;
      try {
        await api(`/api/classes/${c.id}/layout`, { method: 'PATCH', body: { baseRevision: layout.revision, set: draft } });
        toast('设置已保存，在线大屏正在应用'); route();
      } catch (err) {
        el.disabled = false;
        if (err.status === 409) { toast('部分设置刚被大屏修改，已刷新为最新版本，请重新调整', 'error'); route(); }
        else fail(err);
      }
    },
    'restore-layout': async el => {
      if (!await confirmDialog({ title: '恢复设置', message: `把班级设置恢复为修订 ${el.dataset.rev}？会生成新的修订并下发到大屏。`, confirm: '恢复', danger: false })) return;
      await api(`/api/classes/${c.id}/layout/restore`, { method: 'POST', body: { revision: +el.dataset.rev } }); toast('设置已恢复'); route();
    },
    'copy-layout': async () => {
      const ids = await checklistModal({ title: '复制设置到其他班级', submit: '复制', hint: '目标班级的大屏会改用本班的布局与外观设置（含背景图片）。', items: classes.filter(x => x.id !== c.id).map(x => ({ value: x.id, label: x.name })), emptyText: '没有其他可管理的班级。' });
      if (!ids?.length) return;
      const r = await api(`/api/classes/${c.id}/layout/copy`, { method: 'POST', body: { classIds: ids } });
      toast(`已复制到 ${r.copied} 个班级`);
    }
  });
  showPage(page);
  refresh();
}

function classSettings(box, c, publicUrl) {
  box.innerHTML = show(html`<div class="stack" style="max-width:720px">
    <section class="card"><div class="card-head"><h3>公开访问</h3></div><div class="card-body stack">
      <p class="muted">学生和家长可以通过公开短码只读查看本班作业，无需登录。</p>
      <div class="row wrap"><span class="code-chip" style="font-size:16px;padding:6px 12px">${c.publicCode}</span>
        <button class="btn sm" data-act="copy" data-text="${publicUrl}" data-label="公开链接已复制">${icon('link')}复制链接</button>
        <a class="btn sm" href="#/c/${c.publicCode}" target="_blank">${icon('eye')}预览</a>
        ${isAdmin() ? html`<button class="btn sm" data-act="reset-code">${icon('refresh')}重置短码</button>` : ''}</div>
    </div></section>
    <section class="card"><div class="card-head"><h3>数据</h3></div><div class="card-body row wrap">
      <p class="muted grow">导出本班全部项目（含作业内容）为 JSON 文件，用于备份或迁移。</p>
      <button class="btn" data-act="export">${icon('download')}导出 JSON</button>
    </div></section>
    ${isAdmin() ? html`
    <section class="card"><div class="card-head"><h3>班级名称</h3></div><div class="card-body row">
      <input class="input grow" id="cn" value="${c.name}" maxlength="60"><button class="btn primary" data-act="rename">保存</button>
    </div></section>
    <section class="card" style="border-color:color-mix(in srgb,var(--danger) 35%,var(--border))"><div class="card-head"><h3 style="color:var(--danger)">删除班级</h3></div><div class="card-body row wrap">
      <p class="muted grow">删除后班级从列表隐藏，公开短码和设备同步立即失效。</p>
      <button class="btn danger" data-act="delete-class">${icon('trash')}删除班级</button>
    </div></section>` : ''}
  </div>`);
  Object.assign(viewActions, {
    export: () => download(`/api/classes/${c.id}/export`),
    'reset-code': async () => {
      if (!await confirmDialog({ title: '重置公开短码', message: '旧短码和已分享的链接会立即失效。确定重置吗？', confirm: '重置' })) return;
      const r = await api(`/api/admin/classes/${c.id}/public-code`, { method: 'POST' }); toast('新短码：' + r.publicCode); state.classes = null; route();
    },
    rename: async () => { await api(`/api/admin/classes/${c.id}`, { method: 'PATCH', body: { name: $('#cn').value.trim() } }); toast('班级名称已保存'); state.classes = null; route(); },
    'delete-class': async () => {
      const ok = await modal({
        title: '删除班级', submit: '永久删除', danger: true,
        body: html`<p class="muted">此操作会让本班所有设备停止同步。请输入班级名称 <b>${c.name}</b> 确认：</p><input class="input" name="confirm" autocomplete="off">`,
        onSubmit: f => { if (f.confirm.value.trim() !== c.name) throw new Error('输入的名称不一致'); return api(`/api/admin/classes/${c.id}`, { method: 'DELETE' }); }
      });
      if (ok) { toast('班级已删除'); state.classes = null; store.del('lastClass'); navigate('classes'); }
    }
  });
}

// ============================================================ 作业工作台：大屏画布 + 检查器 / 列表
/**
 * 和大屏的“编辑看板”一样：画布上按大屏外观摆放磁贴，拖动移动、拖右下角调整大小；
 * 点选磁贴后在右侧检查器里改科目名、颜色、作业文字和图片。内容和位置共用一份草稿，一次保存。
 * 列表视图是同一份草稿的卡片式编辑，适合连续录入和窄屏。
 */
const NEW_TILE = { w: 430, h: 320 };
const TILE_COLORS = ['#818CF8', '#4ADE80', '#60A5FA', '#FBBF24', '#F472B6', '#2DD4BF', '#F87171'];
const sameRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

async function classHomework(box, c, projectId, query) {
  const classId = c.id, assetUrl = consoleAsset(classId);
  const [layout, allowed, defaults, initial] = await Promise.all([
    api(`/api/classes/${classId}/layout`).catch(() => null), editableSubjects(classId), richDefaults(classId), api(`/api/classes/${classId}/projects`)]);
  let boardDoc = {}; try { boardDoc = JSON.parse(layout?.payloadJson || '{}'); } catch { }
  // 画布只画作业板：分屏时宽度扣掉时钟区，磁贴坐标本来就相对作业板；自由布局画整屏。
  const mode = boardDoc.LayoutMode || 'Split';
  const sceneW = mode === 'Split' ? BOARD_W - Math.round(BOARD_W * Board.SPLIT(boardDoc)) : BOARD_W;
  const sceneDoc = mode === 'Free' ? boardDoc
    : { ...boardDoc, LayoutMode: 'Board', ...(mode === 'Split' && boardDoc.SharedBackgroundEnabled ? { BoardBackground: boardDoc.SharedBackground } : {}) };
  const gridSize = () => Math.max(16, Math.min(160, +boardDoc.GridSize || 48));
  const snap = v => boardDoc.GridSnappingEnabled === false ? Math.round(v) : Math.round(v / gridSize()) * gridSize();
  const can = name => !allowed || allowed.has(name.trim().toLowerCase());

  let projects = initial, showDeleted = false, detail = null, draft = null, base = '', selS = null;
  let savedAt = 0, uploading = 0, saving = false, liveOn = false, openToken = 0;
  let view = store.get('hwView') || (innerWidth <= 860 ? 'list' : 'canvas');
  const byId = id => projects.find(p => p.id === id);
  const live = () => draft ? draft.subjects.filter(s => !s.removed) : [];
  const editorStyle = `--rt-font:${JSON.stringify(defaults.fontFamily).replace(/"/g, "'")};--rt-size:${(defaults.fontSize * .8).toFixed(1)}px`;

  box.innerHTML = show(html`<div class="hw" id="hw">
    <div class="card hw-bar" id="hw-bar"></div>
    <div id="hw-body"></div>
    <div class="save-bar hw-save" id="hw-save" hidden></div>
    <div class="print-only" id="hw-print"></div>
  </div>`);
  const root = $('#hw', box), bar = $('#hw-bar', root), body = $('#hw-body', root);

  // ---------- 草稿
  function buildDraft(d) {
    let raw = []; try { raw = pick(JSON.parse(d.payloadJson || '{}'), 'Subjects') || []; } catch { }
    const subjects = parseProject(d.payloadJson, d.runs).map(s => {
      const rect = { x: s.rect.x, y: s.rect.y, w: s.rect.w, h: s.rect.h };
      return {
        index: s.index, name: s.name, color: (s.color || '#818CF8').toUpperCase(), origColor: (s.color || '').toUpperCase(),
        explicit: !!pick(raw[s.index], 'IsAccentExplicit'), locked: !can(s.name), removed: false, rect, origRect: { ...rect },
        entries: s.entries.map(e => ({ index: e.index, runs: e.runs, hand: e.hand, atts: e.atts.map(a => ({ index: a.index, name: a.name, path: a.path, kind: a.kind })) }))
      };
    });
    // 没有摆放过的科目先放到空位上，不算改动。
    const out = { name: d.name, date: d.date || '', subjects };
    for (const s of subjects) if (s.rect.w <= 0 || s.rect.h <= 0) { s.rect = freeSpot(subjects.filter(x => x !== s && x.rect.w > 0)); s.origRect = { ...s.rect }; }
    return out;
  }
  const snapshotOf = () => draft && {
    n: draft.name.trim(), d: draft.date,
    s: live().map(s => ({ i: s.index, n: s.name, c: s.color, r: s.rect, e: s.entries.map(e => ({ i: e.index, r: rtNormalize(e.runs), a: e.atts.map(a => a.index ?? a.path) })) }))
  };
  const snapshot = () => JSON.stringify(snapshotOf());
  const dirty = () => !!draft && snapshot() !== base;
  setLeaveGuard(() => dirty() ? '作业有未保存的修改，离开后会丢失。' : '');

  function freeSpot(others = live()) {
    const g = gridSize(), { w, h } = NEW_TILE;
    for (let y = g; y < 4000; y += g)
      for (let x = g; x + w <= Math.max(sceneW, w + g); x += g)
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
    name: s.name || '新科目', color: s.color,
    entries: s.entries.map(e => ({ text: rtPlain(e.runs), runs: e.runs, hand: e.hand, atts: e.atts })).filter(e => e.text.trim() || e.hand || e.atts.length)
  }));

  // ---------- 项目切换
  /** 按日期从旧到新排，用来前后翻。 */
  const ordered = () => projects.filter(p => showDeleted || !p.deleted || p.id === detail?.id)
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.name.localeCompare(b.name, 'zh'));
  async function refreshProjects() { projects = await api(`/api/classes/${classId}/projects`); renderBar(); }
  /** keepSel：重新载入同一项目时保留选中的磁贴。 */
  async function open(id, keepSel = false) {
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
      title: '选择模板新建', submit: '创建',
      body: html`<label class="field"><span>项目名称</span><input class="input" name="name" value="${m}月${d}日" maxlength="80"></label>
        <label class="field"><span>作业日期</span><input class="input" type="date" name="date" value="${t}"></label>
        <label class="field"><span>科目布局</span><select class="input" name="tpl">
          <option value="latest">沿用最近的项目</option>${liveP.slice(0, 30).map(p => html`<option value="${p.id}">沿用“${p.name}”</option>`)}<option value="none">空白项目</option></select>
          <small>沿用时保留科目、颜色和磁贴位置，只清空作业内容和笔迹。</small></label>`,
      onSubmit: f => {
        const name = f.elements.name.value.trim(); if (!name) throw new Error('请输入项目名称');
        const tpl = f.tpl.value;
        return api(`/api/classes/${classId}/projects`, { method: 'POST', body: { name, date: f.date.value || null, templateProjectId: /^[0-9a-f-]{36}$/.test(tpl) ? tpl : null, useLatestTemplate: tpl === 'latest' } });
      }
    });
    if (!created) return;
    toast('项目已创建');
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
    if (uploading) return toast('图片还在上传，请稍候', 'error');
    const name = draft.name.trim();
    if (!name) { $('[data-hw-f=name]', root)?.focus(); return toast('项目名称不能为空', 'error'); }
    const blank = live().find(s => !s.name.trim());
    if (blank) { if (view === 'canvas') select(blank); $(`[data-si="${draft.subjects.indexOf(blank)}"] [data-f=name]`, root)?.focus(); return toast('科目名称不能为空', 'error'); }
    const before = JSON.parse(base), now = snapshotOf();
    const contentChanged = JSON.stringify(now.s) !== JSON.stringify(before.s);
    const meta = { name, date: draft.date || '' }, metaChanged = meta.name !== detail.name || meta.date !== (detail.date || '');
    const focus = captureFocus();
    saving = true; refreshBar();
    try {
      if (contentChanged) {
        const d = await api(`/api/classes/${classId}/projects/${detail.id}/content`, { method: 'PUT', body: { expectedRevision: detail.revision, subjects: live().map(serialize) } });
        adopt(d, metaChanged ? meta : null);
      }
      if (metaChanged) {
        const m = await api(`/api/classes/${classId}/projects/${detail.id}`, { method: 'PATCH', body: meta.date ? { name: meta.name, date: meta.date } : { name: meta.name, clearDate: true } });
        adopt({ ...m, runs: detail.runs });
      }
      savedAt = Date.now();
      const i = projects.findIndex(p => p.id === detail.id);
      if (i >= 0) projects[i] = { ...projects[i], name: detail.name, date: detail.date, revision: detail.revision, updatedAt: detail.updatedAt, updatedBy: detail.updatedBy };
      renderAll(); restoreFocus(focus);
      toast('已保存，大屏正在同步');
    } catch (err) {
      if (err.status === 409) {
        if (await confirmDialog({ title: '作业刚被修改', message: '班级大屏或其他老师刚刚修改了这个项目。重新载入最新内容吗？（当前未保存的修改会丢失，可以先复制下来）', confirm: '重新载入', danger: false })) { base = snapshot(); await open(detail.id, true); }
      } else fail(err);
    } finally { saving = false; refreshBar(); }
  }
  function discard() {
    const selPos = live().indexOf(selS);
    draft = buildDraft(detail); base = snapshot();
    selS = selPos >= 0 ? live()[selPos] || null : null;
    renderAll();
  }

  // ---------- 渲染
  function renderAll() { renderBar(); renderBody(); refreshBar(); }
  function renderBar() {
    const list = ordered(), i = list.findIndex(p => p.id === detail?.id);
    const deletedCount = projects.filter(p => p.deleted).length;
    bar.innerHTML = show(html`
      <div class="hw-nav">
        <button class="btn ghost sm icon-only" data-hw="prev" ${i > 0 ? '' : 'disabled'} title="上一个项目">${icon('left')}</button>
        <button class="btn sm hw-picker" data-hw="pick" title="选择项目">${icon('calendar', 'sm')}<span>${detail ? dateLabel(draft ? draft.date || null : detail.date) : '选择项目'}</span>${icon('right', 'sm hw-caret')}</button>
        <button class="btn ghost sm icon-only" data-hw="next" ${i >= 0 && i < list.length - 1 ? '' : 'disabled'} title="下一个项目">${icon('right')}</button>
      </div>
      ${draft ? html`<input class="input hw-name" data-hw-f="name" value="${draft.name}" maxlength="80" aria-label="项目名称" placeholder="项目名称">
        <input class="input hw-date" type="date" data-hw-f="date" value="${draft.date}" aria-label="作业日期" title="作业日期">`
        : detail ? html`<b class="hw-title">${detail.name}</b>` : ''}
      <span class="badge ${liveOn ? 'ok' : ''}" id="hw-live" title="实时同步状态"><span class="dot ${liveOn ? 'live' : ''}"></span>${liveOn ? '实时同步' : '离线'}</span>
      <span class="spacer"></span>
      ${draft ? html`<div class="segmented" role="tablist" aria-label="视图">${[['canvas', '画布'], ['list', '列表']].map(([k, l]) => html`<button type="button" data-hw="view" data-v="${k}" class="${view === k ? 'active' : ''}">${l}</button>`)}</div>
        <button class="btn sm" data-ed="add-subject">${icon('plus')}科目</button>` : ''}
      <button class="btn sm primary" data-hw="new">${icon('plus')}新建项目</button>
      <button class="btn sm icon-only" data-hw="more" title="更多操作${deletedCount ? `（${deletedCount} 个已删除）` : ''}">${icon('more')}</button>`);
  }
  function renderBody() {
    unbindRichEditors(body);
    if (!detail) {
      body.innerHTML = show(html`<div class="card">${empty('book', projects.some(p => !p.deleted) ? '选择一个项目' : '这个班还没有作业项目', '点“新建项目”就能直接在磁贴上布置作业，也可以等班级大屏同步。', html`<button class="btn primary" data-hw="new">${icon('plus')}新建项目</button>`)}</div>`);
      return;
    }
    if (!draft) {
      body.innerHTML = show(html`<div class="banner warn">${icon('trash')}<div class="grow"><b>这个项目已删除</b><div class="muted" style="font-size:13px">恢复后才能编辑；大屏同步后也会恢复。</div></div><button class="btn sm primary" data-hw="restore">${icon('restore')}恢复</button></div>
        <div class="card">${renderSubjects(subjectsOf(detail.payloadJson, detail.runs), assetUrl)}</div>`);
      return;
    }
    if (view === 'canvas') {
      body.innerHTML = show(html`<div class="hw-canvas">
        <div class="card hw-stage-wrap"><div class="hw-stage pk-interactive" id="hw-stage"></div>
          <div class="hw-stage-foot">拖动磁贴移动，拖右下角调整大小 · 双击磁贴直接输入 · 方向键微调，Shift+方向键按格移动 · Delete 删除科目</div></div>
        <aside class="card hw-insp" id="hw-insp"></aside></div>`);
      bindStage($('#hw-stage', body));
      renderCanvas(); renderInspector();
      bindRichEditors($('#hw-insp', body), richOpts);
    } else {
      body.innerHTML = show(html`<div class="card hw-list" id="hw-list"><div class="rt-dock">${richToolbar(defaults.fonts, defaults)}</div><div class="editor" id="hw-cards" style="${editorStyle}"></div></div>`);
      renderCards();
      bindRichEditors($('#hw-list', body), richOpts);
    }
  }
  const richOpts = { getRuns: el => entryAt(el).runs, setRuns: (el, runs) => { entryAt(el).runs = runs; schedule(); }, defaults };
  const subjectAt = el => draft.subjects[+el.closest('[data-si]').dataset.si];
  const entryAt = el => subjectAt(el).entries[+el.closest('[data-ei]').dataset.ei];

  function subjectCard(s) {
    const si = draft.subjects.indexOf(s);
    return html`<section class="edit-subject ${s.locked ? 'locked' : ''}" style="--subject:${s.color}" data-si="${si}">
      <div class="edit-subject-head">
        <input type="color" value="${s.color.slice(0, 7).toLowerCase()}" data-f="color" ${s.locked ? 'disabled' : ''} title="科目颜色" aria-label="科目颜色">
        <input class="input" value="${s.name}" data-f="name" maxlength="40" ${s.locked ? 'disabled' : ''} placeholder="科目名称" aria-label="科目名称">
        ${s.locked ? html`<span class="badge" title="由其他老师负责">${icon('lock', 'sm')}只读</span>` : html`<button type="button" class="btn ghost sm icon-only danger" data-ed="del-subject" title="删除科目">${icon('trash')}</button>`}
      </div>
      <div class="edit-entries">
        ${s.entries.map((e, ei) => html`<div class="edit-entry" data-ei="${ei}">
          <span class="num">${ei + 1}</span>
          <div class="grow" style="display:grid;gap:6px">
            <div class="input rich" contenteditable="${s.locked ? 'false' : 'true'}" role="textbox" aria-multiline="true" data-placeholder="作业内容" ${s.locked ? 'aria-disabled="true"' : ''}>${raw(rtHtml(e.runs, true))}</div>
            ${e.hand ? html`<small class="faint">${icon('pen', 'sm')}含手写笔迹，网页上看不到；修改文字不会影响笔迹。</small>` : ''}
            ${e.atts.length ? html`<div class="attachments">${e.atts.map((a, ai) => {
              const img = assetImage(a, assetUrl);
              return html`<span class="attachment ${img ? 'with-thumb' : ''}">${img ? html`<img src="${img}" alt="">` : icon('clip', 'sm')}<span>${a.name}</span>${s.locked ? '' : html`<button type="button" class="att-x" data-ed="del-att" data-ai="${ai}" title="移除">${icon('x', 'sm')}</button>`}</span>`;
            })}</div>` : ''}
          </div>
          ${s.locked ? '' : html`<div class="edit-entry-actions">
            <button type="button" class="btn ghost sm icon-only" data-ed="add-image" title="添加图片">${icon('image')}</button>
            <button type="button" class="btn ghost sm icon-only danger" data-ed="del-entry" title="删除这一条">${icon('x')}</button></div>`}
        </div>`)}
        ${s.locked ? (s.entries.length ? '' : html`<p class="faint" style="font-size:12.5px;margin:0">暂无作业</p>`) : html`<button type="button" class="btn ghost sm" data-ed="add-entry">${icon('plus')}添加一条</button>`}
      </div>
    </section>`;
  }
  function renderCards() {
    const el = $('#hw-cards', body); if (!el) return;
    el.innerHTML = show(html`${live().map(subjectCard)}<button type="button" class="btn add-subject" data-ed="add-subject">${icon('plus')}添加科目</button>
      <p class="faint" style="font-size:12.5px;grid-column:1/-1">保存后连接的班级大屏会实时更新；新科目会放在作业板的空位上，可以切到“画布”调整位置。</p>`);
  }
  function renderInspector() {
    const el = $('#hw-insp', body); if (!el) return;
    if (!selS) {
      const subs = live();
      el.innerHTML = show(html`<div class="hw-insp-empty">
        <b>点选磁贴编辑作业</b>
        <span class="faint">拖动磁贴移动位置，拖右下角调整大小；双击磁贴直接开始输入。</span>
        ${subs.length ? html`<div class="hw-chips">${subs.map((s, i) => html`<button type="button" class="chip" data-pick="${i}" style="--subject:${s.color}"><i></i>${s.name || '新科目'}${s.locked ? icon('lock', 'sm') : ''}</button>`)}</div>` : ''}
        <button type="button" class="btn" data-ed="add-subject">${icon('plus')}添加科目</button>
        ${allowed ? html`<span class="badge warn">${icon('lock', 'sm')}你负责：${allowed.names.join('、')}</span>` : ''}
      </div>`);
      return;
    }
    el.innerHTML = show(html`<div class="rt-dock">${richToolbar(defaults.fonts, defaults)}</div>
      <div class="hw-insp-body" style="${editorStyle}">${subjectCard(selS)}</div>`);
  }
  /** 结构改动（增删条目、图片）后重绘编辑区。 */
  const renderEditors = () => view === 'canvas' ? renderInspector() : renderCards();

  const tileOf = s => ({
    name: s.name || '新科目', accent: s.color, explicit: s.explicit || s.color !== s.origColor, x: s.rect.x, y: s.rect.y, w: s.rect.w, h: s.rect.h,
    locked: s.locked, cls: [s === selS ? 'sel' : '', s.locked ? 'locked' : '', s.index == null || !sameRect(s.rect, s.origRect) ? 'moved' : ''].join(' '),
    entries: s.entries.map(e => ({ runs: e.runs, images: e.atts.map(a => assetImage(a, assetUrl)).filter(Boolean) }))
  });
  function renderCanvas() {
    const stage = $('#hw-stage', body); if (!stage) return;
    const t = Board.theme(sceneDoc);
    Board.mount(stage, Board.screen(sceneDoc, t, sceneW, BOARD_H, {
      tiles: live().map(tileOf), interactive: true, editing: true, assetUrl,
      placeholder: `<div class="pk-center" style="color:${t.text};opacity:.5;font-size:28px">点“+ 科目”添加第一个磁贴</div>`
    }), sceneDoc);
  }
  let queued = false;
  function schedule() {
    refreshBar();
    if (queued) return; queued = true;
    requestAnimationFrame(() => { queued = false; renderCanvas(); });
  }
  function refreshBar() {
    const el = $('#hw-save', root), on = dirty();
    el.hidden = !on && !saving;
    if (el.hidden) return;
    el.innerHTML = show(html`${icon('edit', 'sm')}<span class="grow">${saving ? '正在保存…' : '有未保存的修改'}</span>
      <button type="button" class="btn sm ghost" data-hw="discard" ${saving ? 'disabled' : ''}>撤销修改</button>
      <button type="button" class="btn sm primary" data-hw="save" ${saving ? 'disabled' : ''}>${icon('send')}保存并同步到大屏<kbd>Ctrl S</kbd></button>`);
  }
  function select(s, focusEntry = false) {
    selS = s;
    const stage = $('#hw-stage', body), subs = live();
    if (stage) $$('.pk-tile', stage).forEach((el, i) => el.classList.toggle('sel', subs[i] === s));
    renderInspector();
    if (focusEntry) {
      const el = $('#hw-insp .rich[contenteditable=true]', body);
      if (el) { el.focus(); rtSetSelection(el, rtPlain(rtExtract(el)).length, rtPlain(rtExtract(el)).length); }
    }
  }
  function addSubject() {
    if (!draft) return;
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

  // ---------- 画布拖动
  let drag = null;
  function bindStage(stage) {
    const scenePoint = e => { const r = $('.pk-scene', stage).getBoundingClientRect(), k = stage._pkScale || 1; return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }; };
    stage.addEventListener('pointerdown', e => {
      const tileEl = e.target.closest('[data-tile]');
      if (!tileEl) { if (selS) select(null); return; }
      const i = +tileEl.dataset.tile, s = live()[i];
      if (s !== selS) select(s);
      if (s.locked) return;
      drag = { i, s, kind: e.target.closest('[data-grip]') ? 'resize' : 'move', p: scenePoint(e), r: { ...s.rect }, moved: false };
      stage.setPointerCapture(e.pointerId); e.preventDefault();
    });
    stage.addEventListener('pointermove', e => {
      if (!drag) return;
      const p = scenePoint(e), dx = p.x - drag.p.x, dy = p.y - drag.p.y, r = drag.s.rect;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true;
      if (drag.kind === 'move') { r.x = Math.max(0, snap(drag.r.x + dx)); r.y = Math.max(0, snap(drag.r.y + dy)); }
      else { r.w = Math.min(TILE_MAX.w, Math.max(TILE_MIN.w, snap(drag.r.w + dx))); r.h = Math.min(TILE_MAX.h, Math.max(TILE_MIN.h, snap(drag.r.h + dy))); }
      const el = stage.querySelector(`[data-tile="${drag.i}"]`);
      if (el) { Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' }); el.classList.add('moved'); }
    });
    const end = () => { if (!drag) return; const moved = drag.moved; drag = null; if (moved) schedule(); };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('dblclick', e => { const t = e.target.closest('[data-tile]'); if (t) select(live()[+t.dataset.tile], true); });
  }

  // ---------- 事件
  root.addEventListener('input', e => {
    const el = e.target, hf = el.dataset.hwF, f = el.dataset.f;
    if (hf === 'name') draft.name = el.value;
    else if (hf === 'date') { draft.date = el.value; $('.hw-picker span', bar).textContent = dateLabel(el.value || null); }
    else if (f === 'name') subjectAt(el).name = el.value;
    else if (f === 'color') { const s = subjectAt(el); s.color = el.value.toUpperCase(); el.closest('.edit-subject').style.setProperty('--subject', s.color); }
    else return;
    schedule();
  });
  root.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset.hwF === 'name') e.target.blur(); });
  root.addEventListener('click', async e => {
    const pickEl = e.target.closest('[data-pick]');
    if (pickEl) return select(live()[+pickEl.dataset.pick], true);
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
          case 'view': view = hw.dataset.v; store.set('hwView', view); renderBar(); renderBody(); return;
        }
      } catch (err) { fail(err); }
      return;
    }
    const b = e.target.closest('[data-ed]'); if (!b) return;
    const act = b.dataset.ed;
    if (act === 'add-subject') return addSubject();
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
    if (selS.locked) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return removeSubject(selS); }
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (d) { e.preventDefault(); const step = e.shiftKey ? gridSize() : 4; selS.rect.x = Math.max(0, selS.rect.x + d[0] * step); selS.rect.y = Math.max(0, selS.rect.y + d[1] * step); schedule(); }
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

  function openPicker(anchor) {
    const el = popover(anchor, html`<label class="input-icon">${icon('search', 'sm')}<input class="input" placeholder="搜索项目或日期" autocomplete="off"></label><div class="hw-picker-list"></div>`, 'hw-pick', 'left');
    const listEl = $('.hw-picker-list', el), q = $('input', el);
    const draw = () => {
      const v = q.value.trim().toLowerCase();
      const items = projects.filter(p => (showDeleted || !p.deleted) && (!v || p.name.toLowerCase().includes(v) || (p.date || '').includes(v) || dateLabel(p.date).includes(v)));
      listEl.innerHTML = show(items.length ? projectGroups(items, p => html`<button type="button" class="project-item ${p.id === detail?.id ? 'active' : ''} ${p.deleted ? 'deleted' : ''}" data-id="${p.id}">
          <span class="name">${p.name}${p.deleted ? html`<span class="badge danger" style="height:18px;font-size:11px">已删除</span>` : ''}</span><span class="meta">更新于 ${relTime(p.updatedAt)}${p.updatedBy ? ' · ' + p.updatedBy : ''}</span></button>`)
        : html`<p class="faint" style="padding:12px">没有匹配的项目</p>`);
    };
    draw(); q.oninput = draw; q.focus();
    listEl.onclick = e => { const b = e.target.closest('[data-id]'); if (!b) return; closeMenu(); switchTo(b.dataset.id).catch(fail); };
  }
  function moreItems() {
    const current = detail ? [
      { label: '复制作业文本', icon: 'copy', run: () => copyText(homeworkText({ name: draft?.name || detail.name, date: draft ? draft.date || null : detail.date }, draft ? viewSubjects() : subjectsOf(detail.payloadJson, detail.runs)), '作业文本已复制') },
      { label: '打印', icon: 'print', run: printProject },
      { label: '历史版本', icon: 'history', run: () => openHistory(classId, { id: detail.id, name: detail.name }, async () => { base = snapshot(); await refreshProjects(); await open(detail.id); }, assetUrl) }
    ] : [];
    return [
      { label: '选择模板新建…', icon: 'plus', run: newFromTemplate },
      null, ...current,
      { label: `显示已删除的项目（${projects.filter(p => p.deleted).length}）`, checked: showDeleted, run: () => { showDeleted = !showDeleted; renderBar(); } },
      { label: '导出全部项目 JSON', icon: 'download', run: () => download(`/api/classes/${classId}/export`) },
      ...(draft ? [null, { label: '删除项目', icon: 'trash', danger: true, run: deleteProject }] : [])
    ];
  }
  function printProject() {
    const name = draft?.name || detail.name, date = draft ? draft.date || null : detail.date;
    $('#hw-print', root).innerHTML = show(html`<h2 style="margin:0 0 4px">${name}</h2><p class="muted" style="margin-bottom:12px">${dateLabel(date, true)}</p>${renderSubjects(draft ? viewSubjects() : subjectsOf(detail.payloadJson, detail.runs), assetUrl)}`);
    print();
  }

  // 大屏或其他老师改了项目：没有未保存修改时直接载入，否则提醒。
  let remoteTimer;
  onDispose(liveSocket(`/ws/classes/${classId}?access_token=${encodeURIComponent(state.token)}`, ev => {
    if (ev.type && !['updated', 'deleted'].includes(ev.type)) return;
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(async () => {
      await refreshProjects().catch(() => { });
      if (!detail || ev.projectId !== detail.id || Date.now() - savedAt < 4000) return;
      if (dirty()) toast('这个项目刚被大屏修改，保存时会提示冲突', 'error');
      else if (!drag) { const f = captureFocus(); await open(detail.id, true); restoreFocus(f); toast('已载入大屏上的最新修改'); }
    }, 400);
  }, on => { liveOn = on; const b = $('#hw-live', bar); if (b) { b.className = 'badge ' + (on ? 'ok' : ''); b.innerHTML = show(html`<span class="dot ${on ? 'live' : ''}"></span>${on ? '实时同步' : '离线'}`); } }));
  onDispose(() => clearTimeout(remoteTimer));
  Board.fontsReady.then(() => { if (view === 'canvas') renderCanvas(); });

  let id = byId(projectId) ? projectId : defaultProject(projects)?.id;
  if (id && id !== projectId) setHash(`classes/${classId}/homework/${id}`, true);
  await open(id);
  if (query?.get('new')) { setHash(`classes/${classId}/homework${id ? '/' + id : ''}`, true); await newProject(); }
}

// ============================================================ 账号管理
async function viewUsers() {
  const page = shell({ nav: 'users', title: '账号', actions: html`<button class="btn primary" data-act="new-user">${icon('plus')}新建账号</button>` });
  setPage(page, loading());
  reloadView = () => usersPage(page);
  await usersPage(page);
}
async function usersPage(page) {
  const [users, classes] = await Promise.all([api('/api/admin/users'), api('/api/classes')]);
  const find = id => users.find(u => u.id === id);
  const classChecklist = selected => classes.length
    ? html`<div class="checklist">${classes.map(c => html`<label class="check"><input type="checkbox" name="cls" value="${c.id}" ${selected.includes(c.id) ? 'checked' : ''}>${c.name}</label>`)}</div>`
    : html`<small class="faint">还没有班级。</small>`;
  const checked = f => $$('input[name=cls]:checked', f).map(x => x.value);

  setPage(page, html`
    <div class="toolbar"><label class="input-icon">${icon('search', 'sm')}<input class="input" id="us" placeholder="搜索姓名或账号"></label><span class="faint">${users.length} 个账号</span></div>
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>用户</th><th>角色</th><th class="hide-sm">负责班级</th><th class="hide-sm">最近登录</th><th></th></tr></thead>
      <tbody id="ub"></tbody></table></div></div>`);
  const renderRows = q => $('#ub').innerHTML = show(users.filter(u => !q || u.displayName.toLowerCase().includes(q) || u.userName.toLowerCase().includes(q)).map(u => html`
    <tr class="${u.enabled ? '' : 'dim'}">
      <td><div class="who">${avatar(u.displayName, 'sm')}<div><b>${u.displayName}${u.id === state.me.id ? html` <span class="badge accent">我</span>` : ''}</b><span>${u.userName}</span></div></div></td>
      <td><span class="badge ${u.role === 'Administrator' ? 'info' : ''}">${roleLabel(u.role)}</span>${u.enabled ? '' : html` <span class="badge danger">已停用</span>`}</td>
      <td class="hide-sm">${u.role === 'Administrator' ? html`<span class="faint">全部班级</span>` : u.classes.length ? u.classes.map(c => html`<span class="badge" style="margin:2px 4px 2px 0">${c.name}</span>`) : html`<span class="faint">未分配</span>`}</td>
      <td class="hide-sm" title="${fullTime(u.lastLoginAt)}">${relTime(u.lastLoginAt)}</td>
      <td class="actions">
        <button class="btn ghost sm" data-act="edit-user" data-id="${u.id}">${icon('edit')}编辑</button>
        <button class="btn ghost sm" data-act="reset-pass" data-id="${u.id}">${icon('key')}重置密码</button>
        ${u.id === state.me.id ? '' : html`<button class="btn ghost sm icon-only danger" data-act="delete-user" data-id="${u.id}" title="删除">${icon('trash')}</button>`}
      </td></tr>`));
  renderRows('');
  $('#us').oninput = e => renderRows(e.target.value.trim().toLowerCase());

  Object.assign(viewActions, {
    'new-user': async () => {
      const created = await modal({
        title: '新建账号', submit: '创建', wide: true,
        body: html`<div class="grid-2" style="gap:14px">
            <label class="field"><span>账号</span><input class="input" name="userName" placeholder="登录名，不含空格" maxlength="32" autocomplete="off"></label>
            <label class="field"><span>显示名称</span><input class="input" name="displayName" placeholder="例如：王老师" maxlength="40"></label>
          </div>
          <label class="field"><span>初始密码</span><div class="row"><input class="input grow mono" name="password" value="${randomPassword()}" minlength="8"><button type="button" class="btn" id="gen">${icon('refresh')}生成</button><button type="button" class="btn icon-only" id="cp" title="复制">${icon('copy')}</button></div><small>至少 8 位。请把初始密码告知对方，登录后可自行修改。</small></label>
          <label class="field"><span>角色</span><select class="input" name="role"><option value="Teacher">老师 — 管理被分配的班级</option><option value="Administrator">管理员 — 管理全部班级和账号</option></select></label>
          <div class="field" id="cls-field"><span>负责班级</span>${classChecklist([])}</div>`,
        onMount: f => {
          $('#gen', f).onclick = () => { f.password.value = randomPassword(); };
          $('#cp', f).onclick = () => copyText(f.password.value, '密码已复制');
          f.role.onchange = () => $('#cls-field', f).classList.toggle('hidden', f.role.value !== 'Teacher');
        },
        onSubmit: async f => {
          const body = { userName: f.userName.value.trim(), displayName: f.displayName.value.trim(), password: f.password.value, role: f.role.value };
          const u = await api('/api/admin/users', { method: 'POST', body });
          const cls = checked(f);
          if (body.role === 'Teacher' && cls.length) await api(`/api/admin/users/${u.id}/classes`, { method: 'PUT', body: { classIds: cls } });
          return u;
        }
      });
      if (created) { toast(`账号 ${created.userName} 已创建`); reloadView(); }
    },
    'edit-user': async el => {
      const u = find(el.dataset.id), self = u.id === state.me.id;
      const ok = await modal({
        title: '编辑账号', submit: '保存', wide: true,
        body: html`<div class="grid-2" style="gap:14px">
            <label class="field"><span>账号</span><input class="input" value="${u.userName}" readonly disabled></label>
            <label class="field"><span>显示名称</span><input class="input" name="displayName" value="${u.displayName}" maxlength="40"></label>
          </div>
          <label class="field"><span>角色</span><select class="input" name="role" ${self ? 'disabled' : ''}><option value="Teacher" ${u.role === 'Teacher' ? 'selected' : ''}>老师</option><option value="Administrator" ${u.role === 'Administrator' ? 'selected' : ''}>管理员</option></select>${self ? html`<small>不能修改自己的角色。</small>` : ''}</label>
          <label class="check"><input type="checkbox" name="enabled" ${u.enabled ? 'checked' : ''} ${self ? 'disabled' : ''}>允许登录</label>
          <div class="field ${u.role === 'Teacher' ? '' : 'hidden'}" id="cls-field"><span>负责班级</span>${classChecklist(u.classes.map(c => c.id))}</div>`,
        onMount: f => { f.role.onchange = () => $('#cls-field', f).classList.toggle('hidden', f.role.value !== 'Teacher'); },
        onSubmit: async f => {
          const body = { displayName: f.displayName.value.trim() };
          if (!self) { body.role = f.role.value; body.enabled = f.enabled.checked; }
          await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body });
          if ((body.role || u.role) === 'Teacher') await api(`/api/admin/users/${u.id}/classes`, { method: 'PUT', body: { classIds: checked(f) } });
        }
      });
      if (ok) {
        toast('账号已更新');
        if (self) { state.me = null; await ensureMe(); }
        route();
      }
    },
    'reset-pass': async el => {
      const u = find(el.dataset.id);
      const ok = await modal({
        title: '重置密码', submit: '重置',
        body: html`<p class="muted">为 <b>${u.displayName}</b> 设置新密码，对方已登录的会话将失效。</p>
          <label class="field"><span>新密码</span><div class="row"><input class="input grow mono" name="p" value="${randomPassword()}"><button type="button" class="btn icon-only" id="cp" title="复制">${icon('copy')}</button></div><small>至少 8 位。</small></label>`,
        onMount: f => { $('#cp', f).onclick = () => copyText(f.p.value, '密码已复制'); },
        onSubmit: f => api(`/api/admin/users/${u.id}/password`, { method: 'POST', body: { newPassword: f.p.value } })
      });
      if (ok) toast('密码已重置');
    },
    'delete-user': async el => {
      const u = find(el.dataset.id);
      if (!await confirmDialog({ title: '删除账号', message: `确定删除“${u.displayName}（${u.userName}）”吗？此操作不可撤销，已配对的设备不受影响。`, confirm: '删除' })) return;
      await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); toast('账号已删除'); reloadView();
    }
  });
}

// ============================================================ 操作日志
async function viewAudit() {
  const page = shell({ nav: 'audit', title: '操作日志' });
  const classes = await api('/api/classes');
  let items = [], q = '', classId = '', done = false;
  setPage(page, html`
    <div class="toolbar">
      <label class="input-icon">${icon('search', 'sm')}<input class="input" id="aq" placeholder="搜索操作者、动作或内容"></label>
      <select class="input" id="ac" style="width:200px"><option value="">全部班级</option>${classes.map(c => html`<option value="${c.id}">${c.name}</option>`)}</select>
    </div>
    <div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>内容</th><th class="hide-sm">班级</th></tr></thead><tbody id="ab"></tbody></table></div>
    <div class="card-body row" style="justify-content:center;border-top:1px solid var(--border)"><button class="btn" data-act="more" id="am">加载更多</button></div></div>`);
  const tone = a => /删除|吊销|停用|失败/.test(a) ? 'danger' : /创建|新建|恢复|回滚/.test(a) ? 'ok' : /登录/.test(a) ? '' : 'info';
  const render = () => {
    $('#ab').innerHTML = show(items.length ? items.map(a => html`<tr>
      <td class="nowrap" title="${fullTime(a.at)}">${fullTime(a.at)}</td><td>${a.actor}</td>
      <td><span class="badge ${tone(a.action)}">${a.action}</span></td><td>${a.detail}</td><td class="hide-sm">${a.className || html`<span class="faint">—</span>`}</td></tr>`)
      : html`<tr><td colspan="5">${empty('log', '没有记录', q || classId ? '没有符合条件的记录。' : '系统操作会记录在这里。')}</td></tr>`);
    $('#am').classList.toggle('hidden', done);
  };
  const load = async (reset) => {
    if (reset) { items = []; done = false; }
    const params = new URLSearchParams({ take: 100 });
    if (q) params.set('q', q); if (classId) params.set('classId', classId);
    if (items.length) params.set('before', items[items.length - 1].id);
    const batch = await api('/api/admin/audit?' + params);
    items.push(...batch); done = batch.length < 100; render();
  };
  let t;
  $('#aq').oninput = e => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); load(true).catch(fail); }, 300); };
  $('#ac').onchange = e => { classId = e.target.value; load(true).catch(fail); };
  viewActions.more = () => load(false);
  await load(true);
}

// ============================================================ 设置
async function viewSettings() {
  const page = shell({ nav: 'settings', title: '设置' });
  const me = state.me;
  const current = theme.get();
  setPage(page, html`<div class="stack" style="max-width:760px">
    <section class="card"><div class="card-head">${avatar(me.displayName)}<div class="grow"><h3>${me.displayName}</h3><span class="faint" style="font-size:12.5px">${me.userName} · ${roleLabel(me.role)}</span></div></div>
      <form class="card-body stack" id="pw" novalidate>
        <h4>修改密码</h4>
        <label class="field"><span>当前密码</span><input class="input" type="password" name="cur" autocomplete="current-password"></label>
        <div class="grid-2" style="gap:14px">
          <label class="field"><span>新密码</span><input class="input" type="password" name="next" autocomplete="new-password"><small>至少 8 位，不要与账号相同。</small></label>
          <label class="field"><span>确认新密码</span><input class="input" type="password" name="again" autocomplete="new-password"></label>
        </div>
        <div class="form-error" id="pwe"></div>
        <div><button class="btn primary" type="submit">更新密码</button></div>
      </form>
    </section>
    <section class="card"><div class="card-head"><h3 class="grow">外观</h3></div><div class="card-body row wrap">
      <span class="muted grow">界面主题</span>
      <div class="segmented" id="th">${[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([k, l]) => html`<button type="button" data-v="${k}" class="${current === k ? 'active' : ''}">${l}</button>`)}</div>
    </div></section>
    <section class="card"><div class="card-head"><h3 class="grow">服务器</h3><button class="btn ghost sm" data-act="copy" data-text="${location.origin}">${icon('copy')}复制地址</button></div><div class="card-body" id="srv">${loading()}</div></section>
    ${isAdmin() ? html`<section class="card"><div class="card-head"><h3>备份</h3></div><div class="card-body row wrap">
      <p class="muted grow">下载完整的 SQLite 数据库副本（班级、账号、项目及历史）。服务运行时即可安全备份。</p>
      <button class="btn" data-act="backup">${icon('db')}下载数据库备份</button></div></section>` : ''}
  </div>`);
  $$('#th button').forEach(b => b.onclick = () => { theme.set(b.dataset.v); $$('#th button').forEach(x => x.classList.toggle('active', x === b)); });
  const f = $('#pw');
  f.onsubmit = async e => {
    e.preventDefault(); $('#pwe').textContent = '';
    if (f.next.value !== f.again.value) { $('#pwe').textContent = '两次输入的新密码不一致'; return; }
    try {
      await api('/api/auth/password', { method: 'POST', body: { currentPassword: f.cur.value, newPassword: f.next.value } });
      f.reset(); state.me = null; await ensureMe(); toast('密码已更新，其他设备上的登录已失效');
    } catch (err) { $('#pwe').textContent = err.message; }
  };
  viewActions.backup = async () => { await download('/api/admin/backup'); toast('备份已开始下载'); };
  try {
    const h = await api('/api/health', { auth: false });
    $('#srv').innerHTML = show(html`<dl class="kv">
      <dt>地址</dt><dd class="mono">${location.origin}</dd>
      <dt>状态</dt><dd><span class="badge ok"><span class="dot ok"></span>运行中</span></dd>
      <dt>版本</dt><dd>${h.version || '—'}</dd>
      <dt>已运行</dt><dd>${duration(h.uptimeSeconds)}（自 ${fullTime(h.startedAt)}）</dd>
      <dt>实时连接</dt><dd>${h.connections}</dd>
      <dt>登录会话</dt><dd>${h.sessions}</dd>
      <dt>本次登录</dt><dd>有效期至 ${fullTime(me.expiresAt)}</dd>
    </dl>`);
  } catch (err) { $('#srv').innerHTML = show(empty('alert', '无法获取服务器状态', err.message)); }
}

// ============================================================ 启动
(function start() {
  const code = new URLSearchParams(location.search).get('code');
  if (code) { history.replaceState(null, '', location.pathname + '#/c/' + encodeURIComponent(code.trim().toLowerCase())); }
  route();
})();
