// 유콜 데스크 v1.2.0 회귀 검사 — 서버 v4.24에 맞춘 수정을 «소스 원문»으로 잰다.
//   타이머 누수·단일 인스턴스·주소 위생(role·k)·학년반 정규화·호출 확인 재시도/화면 고착·
//   교체 표시·이스케이프·currentPeriodStatus·periodConfig·TTS 제한
//
// 사용: node tests/test-v120.js              ← 이 저장소 소스
//       node tests/test-v120.js <다른 폴더>   ← 예: 고치기 전 원본 사본. 거기서 실패해야 이 검사가 뭔가를 잰다는 증거다.
//
// Electron 없이 돈다.
//   · main.js · main/api.js · main/store.js — 원문 그대로 vm에 올리고 electron·fs·타이머·시계만 가짜로 넣는다
//   · renderer/js/app.js — 함수 원문을 «이름으로» 떼어 vm에 올린다(맨 앞 줄 var 선언도 원문에서 뗀다 — 표 사본을 들지 않는다)
//   · 가짜 DOM은 innerHTML을 새로 넣으면 자식이 비는 실제 동작까지 흉내 낸다(다시 그리기가 옛 칸을 남기는지 보려고)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const failed = [];
async function check(name, fn) {
  try { await fn(); pass++; console.log('[통과] ' + name); }
  catch (e) { fail++; failed.push(name); console.log('[실패] ' + name + ' — ' + ((e && e.message) || e)); }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg ? msg + ': ' : '') + '기대 ' + b + ' / 실제 ' + a);
}
function ok(v, msg) { if (!v) throw new Error(msg || '조건이 거짓'); }
function need(obj, name) { if (!obj || typeof obj[name] !== 'function') throw new Error('함수 없음: ' + name); return obj[name]; }
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
function deferred() { let resolve; const p = new Promise(r => { resolve = r; }); return { p, resolve }; }

/* ───────────── 소스에서 이름으로 떼어 내기 ───────────── */
// 문자열·주석·정규식 안의 괄호·따옴표에 속지 않게 한 글자씩 훑는다. onCode가 true를 돌려주면 그 자리에서 멈춘다.
function walk(src, from, onCode) {
  let i = from, prevSig = '';
  const REGEX_PREV = '(,=:[!&|?{};+-*%<>~^';
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2); if (i < 0) return -1; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; }
      i++; prevSig = c; continue;
    }
    if (c === '/') {
      const before = src.slice(Math.max(0, i - 10), i).replace(/\s+$/, '');
      if (prevSig === '' || REGEX_PREV.indexOf(prevSig) >= 0 || /(^|[^\w$])(return|typeof|case|in|of)$/.test(before)) {
        i++; let inClass = false;
        while (i < src.length) {
          const d = src[i];
          if (d === '\\') { i += 2; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if ((d === '/' && !inClass) || d === '\n') break;
          i++;
        }
        i++; prevSig = 'r'; continue;
      }
    }
    if (onCode(c, i)) return i;
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return -1;
}
function extractFunction(src, name) {
  const re = new RegExp('(^|[^\\w$.])((?:async\\s+)?function\\s+' + name + '\\s*\\()', 'm');
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + m[1].length;
  const parenOpen = m.index + m[0].length - 1;
  let d = 0;
  const parenClose = walk(src, parenOpen, c => { if (c === '(') d++; else if (c === ')') { d--; return d === 0; } return false; });
  const braceOpen = src.indexOf('{', parenClose);
  d = 0;
  const braceClose = walk(src, braceOpen, c => { if (c === '{') d++; else if (c === '}') { d--; return d === 0; } return false; });
  if (parenClose < 0 || braceOpen < 0 || braceClose < 0) return null;
  return src.slice(start, braceClose + 1);
}
// 줄 맨 앞(들여쓰기 없음)의 var 문 — app.js는 IIFE 안이지만 모듈 상태를 들여쓰지 않고 적는다
function extractTopVars(src) {
  const out = [];
  const re = /^var\s/gm;
  let m;
  while ((m = re.exec(src))) {
    let d = 0;
    const end = walk(src, m.index, c => {
      if ('([{'.indexOf(c) >= 0) d++;
      else if (')]}'.indexOf(c) >= 0) d--;
      else if (c === ';' && d === 0) return true;
      return false;
    });
    if (end < 0) break;
    out.push(src.slice(m.index, end + 1));
    re.lastIndex = end + 1;
  }
  return out.join('\n');
}

/* ───────────── 가짜 타이머 ───────────── */
function makeTimers() {
  let seq = 0;
  const iv = new Map(), to = new Map(), timeoutLog = [];
  return {
    timeoutLog,   // 지워진 것까지 포함한 setTimeout 지연값 기록(요청 제한 시간은 finally에서 곧바로 지워진다)
    setInterval: (fn, ms) => { const id = ++seq; iv.set(id, { fn, ms }); return id; },
    clearInterval: id => { iv.delete(id); },
    setTimeout: (fn, ms) => { const id = ++seq; to.set(id, { fn, ms }); timeoutLog.push(ms); return id; },
    clearTimeout: id => { to.delete(id); },
    intervals: () => [...iv.values()],
    timeouts: () => [...to.values()],
    runTimeouts: pred => {
      const due = [...to.entries()].filter(([, t]) => !pred || pred(t));
      due.forEach(([id]) => to.delete(id));
      due.forEach(([, t]) => t.fn());
      return due.length;
    }
  };
}

/* ───────────── main/api.js ───────────── */
function loadApi(fetchImpl) {
  const mod = { exports: {} };
  const timers = makeTimers();
  const ctx = {
    module: mod, exports: mod.exports, URL, AbortController, console,
    fetch: fetchImpl || (() => Promise.reject(new Error('fetch 없음'))),
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout
  };
  vm.createContext(ctx);
  new vm.Script(read('main/api.js'), { filename: 'main/api.js' }).runInContext(ctx);
  return { exports: mod.exports, ctx, timers };
}

/* ───────────── main/store.js ───────────── */
const USERDATA = 'C:\\fake-userdata';
function loadStore(initial) {
  const files = {};
  if (initial) files[path.join(USERDATA, 'store.json')] = JSON.stringify(initial);
  const fakeFs = {
    readFileSync: p => { if (!(p in files)) throw new Error('ENOENT ' + p); return files[p]; },
    writeFileSync: (p, data) => { files[p] = String(data); },
    existsSync: p => p in files,
    copyFileSync: (a, b) => { files[b] = files[a]; },
    renameSync: (a, b) => { files[b] = files[a]; delete files[a]; }
  };
  const mod = { exports: {} };
  const ctx = {
    module: mod, exports: mod.exports, console,
    require: m => {
      if (m === 'electron') return { app: { getPath: () => USERDATA } };
      if (m === 'path') return path;
      if (m === 'fs') return fakeFs;
      throw new Error('store.js 모르는 require: ' + m);
    },
    setTimeout: () => 0, clearTimeout: () => {}
  };
  vm.createContext(ctx);
  new vm.Script(read('main/store.js'), { filename: 'main/store.js' }).runInContext(ctx);
  return { exports: mod.exports, files };
}

/* ───────────── main.js ───────────── */
const CONFIGURED = { webAppUrl: 'https://script.google.com/macros/s/TEST/exec', grade: '3', classNum: '2' };
const DEFAULT_API = {
  getBoard: () => ({ ok: true, data: { autoDismiss: 30, periodConfig: { start: '08:50', periodLen: 45, breakLen: 10, lunchAfter: 4, lunchLen: 50, maxPeriod: 7 } } }),
  getCalls: () => ({ ok: true, data: [] }),
  confirmCall: () => ({ ok: true, data: { ok: true } }),
  getMeal: () => ({ ok: true, data: [] }),
  getTimetable: () => ({ ok: true, data: [] }),
  getTts: () => ({ ok: true, data: { audio: '' } })
};
function loadMain(opts = {}) {
  const timers = makeTimers();
  const storeMod = loadStore(opts.store === undefined ? CONFIGURED : opts.store);
  const realApi = loadApi().exports;
  const calls = {};
  const handlers = Object.assign({}, DEFAULT_API, opts.api || {});
  const api = Object.assign({}, realApi);
  Object.keys(DEFAULT_API).forEach(k => {
    calls[k] = [];
    api[k] = (...a) => { calls[k].push(a); return Promise.resolve(handlers[k](...a)); };
  });

  const ev = { app: {}, ipc: {}, windows: [], sent: [], quitCalls: 0, lockAsked: 0 };
  let readyResolve;
  const ready = new Promise(r => { readyResolve = r; });
  const app = {
    whenReady: () => ready,
    requestSingleInstanceLock: () => { ev.lockAsked++; return opts.lock !== false; },
    on: (name, fn) => { (ev.app[name] = ev.app[name] || []).push(fn); },
    quit: () => { ev.quitCalls++; },
    exit: () => {},
    isPackaged: false,
    setLoginItemSettings: () => {},
    getPath: () => USERDATA
  };
  class BrowserWindow {
    constructor() {
      ev.windows.push(this);
      this.shown = 0; this.focused = 0;
      this.webContents = { send: (ch, p) => ev.sent.push([ch, p]), isDestroyed: () => false, on() {}, executeJavaScript: () => Promise.resolve() };
    }
    loadFile() { return Promise.resolve(); }
    once() {} on() {}
    show() { this.shown++; } hide() {} focus() { this.focused++; }
    isMinimized() { return false; } restore() {} isDestroyed() { return false; }
    getBounds() { return { x: 0, y: 0, width: 960, height: 640 }; }
  }
  class Tray { setToolTip() {} on() {} setContextMenu() {} isDestroyed() { return false; } destroy() {} }
  function Notification() { return { show() {} }; }
  Notification.isSupported = () => false;
  const electron = {
    app, BrowserWindow, Tray, Notification,
    Menu: { buildFromTemplate: t => t, setApplicationMenu() {} },
    nativeImage: { createFromPath: () => ({}) },
    ipcMain: { handle: (ch, fn) => { ev.ipc[ch] = fn; } }
  };
  const fakeFs = { appendFileSync() {}, mkdirSync() {}, writeFileSync() {}, existsSync: () => false };

  let nowMs = new Date(2026, 8, 14, 10, 0, 0).getTime();   // 월요일 10:00
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(nowMs); }
    static now() { return nowMs; }
  }
  const ctx = {
    require: m => {
      if (m === 'electron') return electron;
      if (m === 'path') return path;
      if (m === 'fs') return fakeFs;
      if (m === './main/store') return storeMod.exports;
      if (m === './main/api') return api;
      throw new Error('main.js 모르는 require: ' + m);
    },
    __dirname: 'C:\\fake-app', console,
    process: { argv: ['electron', '.'], on() {}, platform: 'win32', env: {} },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    Date: FakeDate, module: { exports: {} }
  };
  vm.createContext(ctx);
  new vm.Script(read('main.js'), { filename: 'main.js' }).runInContext(ctx);
  return {
    ctx, ev, timers, calls, handlers, store: storeMod.exports,
    fireReady: async () => { readyResolve(); await flush(); },
    advance: ms => { nowMs += ms; },
    lastSent: () => ev.sent[ev.sent.length - 1]
  };
}

/* ───────────── renderer/js/app.js ───────────── */
function makeDom() {
  const byId = {};
  class El {
    constructor(tag) {
      const self = this;
      this.tagName = String(tag || 'div').toUpperCase();
      this.children = []; this._html = ''; this.className = ''; this.id = ''; this.value = '';
      this.scrollHeight = 0; this.clientHeight = 0; this.offsetParent = null;
      this.style = { _p: {}, setProperty(k, v) { this._p[k] = v; }, getPropertyValue(k) { return this._p[k] || ''; } };
      const list = () => self.className.split(/\s+/).filter(Boolean);
      this.classList = {
        add: c => { const s = list(); if (s.indexOf(c) < 0) s.push(c); self.className = s.join(' '); },
        remove: c => { self.className = list().filter(x => x !== c).join(' '); },
        contains: c => list().indexOf(c) >= 0
      };
    }
    // 실제 브라우저처럼: innerHTML·textContent를 새로 넣으면 appendChild로 붙인 자식이 전부 사라진다
    set innerHTML(v) { this.children = []; this._html = String(v); }
    get innerHTML() { return this._html + this.children.map(c => c.outerHTML).join(''); }
    set textContent(v) { this.children = []; this._html = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    get textContent() { return this._html; }
    get outerHTML() {
      const t = this.tagName.toLowerCase();
      return '<' + t + (this.className ? ' class="' + this.className + '"' : '') + (this.id ? ' id="' + this.id + '"' : '') + '>' + this.innerHTML + '</' + t + '>';
    }
    appendChild(c) { this.children.push(c); return c; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  }
  const document = {
    getElementById: id => byId[id] || null,
    createElement: t => new El(t),
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const add = (id, props) => { const e = new El('div'); e.id = id; Object.assign(e, props || {}); byId[id] = e; return e; };
  return { document, add, byId };
}
const RENDERER_FNS = [
  'escHtml', 'normClassNo', 'normPeriodConfig', 'toMinutes', 'buildSchedule', 'effectiveSchedule',
  'currentPeriodStatus', 'applyPeriodConfig', 'renderPeriodRow', 'renderWeek', 'ymdKey', 'fitWeekBox',
  'renderMeal', 'fitMealBox', 'shrinkNoticeForSpace', 'savePref', 'flushPref'
];
function loadRenderer() {
  const src = read('renderer/js/app.js');
  const parts = [extractTopVars(src)];
  const missing = [];
  RENDERER_FNS.forEach(n => { const f = extractFunction(src, n); if (f) parts.push(f); else missing.push(n); });
  const dom = makeDom();
  const timers = makeTimers();
  const saved = [];
  const win = { yc: { saveSettings: p => { saved.push(p); return Promise.resolve(p); } }, addEventListener() {}, innerHeight: 800 };
  const ctx = {
    window: win, document: dom.document, console,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    getComputedStyle: () => ({ paddingBottom: '0px', lineHeight: '20px', fontSize: '16px' })
  };
  vm.createContext(ctx);
  new vm.Script(parts.join('\n\n'), { filename: 'renderer/js/app.js(이름으로 뗀 원문)' }).runInContext(ctx);
  dom.add('periodRow'); dom.add('weekWrap'); dom.add('mealList');
  dom.add('soundSelect', { value: '3' }); dom.add('volSlider', { value: '7' });
  dom.add('ttsVolSlider', { value: '9' }); dom.add('repeatSelect', { value: '2' });
  if (typeof ctx.buildSchedule === 'function') vm.runInContext('SCHEDULE = buildSchedule(PERIOD_CONFIG);', ctx);
  return { ctx, dom, timers, saved, missing, run: code => vm.runInContext(code, ctx) };
}
// 이번 주 월~금 yyyyMMdd — 렌더러 renderWeek와 같은 계산(검사 날짜가 주말이어도 이번 주 월요일을 잡는다)
function thisWeekKeys() {
  const now = new Date(), dow = now.getDay(), mon = new Date(now);
  mon.setDate(now.getDate() - ((dow + 6) % 7));
  const out = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(mon); d.setDate(mon.getDate() + i);
    out.push(d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'));
  }
  return out;
}
const MON_1000 = new Date(2026, 8, 14, 10, 0);   // 2026-09-14 월요일
const SAT_1000 = new Date(2026, 8, 12, 10, 0);   // 2026-09-12 토요일
const periods = n => Array.from({ length: n }, (_, i) => ({ period: i + 1, subject: '과목' + (i + 1) }));

(async function main() {
  console.log('검사 대상: ' + ROOT);

  /* ═════════ api.js ═════════ */
  await check('api.buildUrl — 교사용 주소의 role·k·#해시를 버리고 요청 인자만 붙인다', () => {
    const { ctx } = loadApi();
    const url = need(ctx, 'buildUrl')('https://script.google.com/macros/s/AAA/exec?role=teacher&k=SECRET123#top', { api: 'calls', grade: '3', classNum: '2' });
    const u = new URL(url);
    ok(!u.searchParams.has('k'), 'k가 남음: ' + url);
    ok(!u.searchParams.has('role'), 'role이 남음: ' + url);
    ok(url.indexOf('#') < 0 && url.indexOf('SECRET123') < 0, '해시·열쇠가 남음: ' + url);
    eq(u.searchParams.get('api'), 'calls');
    eq(u.searchParams.get('grade'), '3');
  });
  await check('api.cleanWebAppUrl — 저장용 주소를 정리하고, 이상한 글자에도 죽지 않는다', () => {
    const { exports } = loadApi();
    const clean = need(exports, 'cleanWebAppUrl');
    eq(clean('  https://script.google.com/macros/s/AAA/exec?role=teacher&k=SECRET#x '), 'https://script.google.com/macros/s/AAA/exec');
    eq(clean('https://script.google.com/macros/s/AAA/exec'), 'https://script.google.com/macros/s/AAA/exec');
    eq(clean('https://script.google.com/macros/s/AAA/exec?foo=1&k=zz'), 'https://script.google.com/macros/s/AAA/exec?foo=1');
    eq(typeof clean('주소 아님'), 'string');
    eq(clean(''), '');
  });
  await check('api.confirmCall — row와 함께 grade·classNum을 보낸다', async () => {
    const urls = [];
    const { exports } = loadApi(u => { urls.push(u); return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }); });
    await exports.confirmCall('https://x.test/exec', 17, '3', '2');
    const u = new URL(urls[0]);
    eq([u.searchParams.get('api'), u.searchParams.get('row'), u.searchParams.get('grade'), u.searchParams.get('classNum')], ['confirm', '17', '3', '2']);
  });
  await check('api 제한 시간 — TTS만 15초, 나머지는 8초 그대로', async () => {
    const { exports, timers } = loadApi(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ audio: '' }) }));
    await exports.getTts('https://x.test/exec', '가');
    await exports.getCalls('https://x.test/exec', '3', '2');
    await exports.getBoard('https://x.test/exec', '3', '2');
    eq(timers.timeoutLog, [15000, 8000, 8000], '요청별 제한 시간');
  });

  /* ═════════ store.js ═════════ */
  const CLASS_CASES = [
    ['3', '3'], ['03', '3'], ['\uFF13', '3'], ['3\uD559\uB144', '3'], [' 2 \uBC18 ', '2'], ['\uFF12\uBC18', '2'],
    ['\u00a03\u3000', '3'], ['12', '12'], ['3-2', ''], ['abc', ''], ['', ''], ['123', ''], ['0', ''], [null, ''], [3, '3'],
    ['3\uD559\uB1442\uBC18', '']
  ];
  await check('store.normClassNo — 전각 숫자·«학년»«반»·공백을 걷고 1~2자리 숫자만', () => {
    const { exports } = loadStore();
    const norm = need(exports, 'normClassNo');
    CLASS_CASES.forEach(([input, want]) => eq(norm(input), want, JSON.stringify(input)));
  });
  await check('store.isConfigured — 고칠 수 없는 학년·반은 미설정으로 본다', () => {
    const a = loadStore({ webAppUrl: 'https://x.test/exec', grade: '3\uD559\uB144', classNum: '\uFF12' }).exports;
    eq(a.isConfigured(), true, '고칠 수 있는 값');
    const b = loadStore({ webAppUrl: 'https://x.test/exec', grade: '\uC0BC', classNum: '2' }).exports;
    eq(b.isConfigured(), false, '«삼»');
  });
  const PC_OK = { start: '09:00', periodLen: 40, breakLen: 10, lunchAfter: 0, lunchLen: 50, maxPeriod: 6 };
  const PC_BAD = [null, [], 'x', {}, { start: '', periodLen: 45, breakLen: 10, lunchAfter: 4, lunchLen: 50, maxPeriod: 7 },
    Object.assign({}, PC_OK, { maxPeriod: 0 }), Object.assign({}, PC_OK, { periodLen: 'abc' }), Object.assign({}, PC_OK, { start: '25:00' }),
    Object.assign({}, PC_OK, { lunchAfter: -1 }), Object.assign({}, PC_OK, { maxPeriod: 2.5 })];
  await check('store.normPeriodConfig — 정상 시정(점심 없음 0 포함)만 통과, 모양이 틀리면 null', () => {
    const { exports } = loadStore();
    const norm = need(exports, 'normPeriodConfig');
    eq(norm(PC_OK), PC_OK);
    eq(norm(Object.assign({}, PC_OK, { periodLen: '40' })), PC_OK, '숫자 글자는 숫자로');
    PC_BAD.forEach(b => eq(norm(b), null, JSON.stringify(b)));
  });

  /* ═════════ main.js ═════════ */
  await check('main.startPolling — 기다리는 사이 5번 겹쳐 불려도 타이머는 1벌(3개)만 산다', async () => {
    const boards = [];
    const m = loadMain({ api: { getBoard: () => { const d = deferred(); boards.push(d); return d.p; } } });
    for (let i = 0; i < 5; i++) need(m.ctx, 'startPolling')();
    await flush();
    boards.forEach(d => d.resolve(DEFAULT_API.getBoard()));
    await flush(12);
    const iv = m.timers.intervals();
    eq(iv.length, 3, '살아 있는 setInterval 수');
    eq(iv.filter(t => t.ms === 3000).length, 1, '3초 호출 폴링');
  });
  await check('main.startPolling — 끝난 뒤 거듭 불러도 1벌 유지', async () => {
    const m = loadMain();
    for (let i = 0; i < 3; i++) { m.ctx.startPolling(); await flush(12); }
    eq(m.timers.intervals().length, 3);
  });
  await check('main.stopAllTimers — 응답을 기다리던 startPolling이 돌아와도 타이머를 만들지 않는다(종료 중)', async () => {
    const d = deferred();
    const m = loadMain({ api: { getBoard: () => d.p } });
    m.ctx.startPolling();
    await flush();
    need(m.ctx, 'stopAllTimers')();
    d.resolve(DEFAULT_API.getBoard());
    await flush(12);
    eq(m.timers.intervals().length, 0, '남은 setInterval');
  });
  await check('main 시작 순서 — board(시정)를 먼저 받고 그다음 시간표를 받는다', async () => {
    const d = deferred();
    const m = loadMain({ api: { getBoard: () => d.p } });
    m.ctx.startPolling();
    await flush();
    eq(m.calls.getTimetable.length, 0, 'board 도착 전 시간표 요청 수');
    d.resolve(DEFAULT_API.getBoard());
    await flush(12);
    eq(m.calls.getTimetable.length, 2, 'board 도착 뒤 시간표 요청 수(오늘·주간)');
  });
  await check('main yc:save-settings — 소리·볼륨만 바뀌면 폴링을 다시 시작하지 않는다', async () => {
    const m = loadMain();
    need(m.ctx, 'registerIpc')();
    const h = m.ev.ipc['yc:save-settings'];
    for (let i = 1; i <= 5; i++) await h({}, { soundIndex: 1, volume: i, ttsVolume: 10, repeatCount: 2 });
    await flush(12);
    eq(m.calls.getBoard.length, 0, 'getBoard 호출 수');
    eq(m.timers.intervals().length, 0, 'setInterval 수');
    eq(m.store.load().volume, 5, '볼륨은 저장');
  });
  await check('main yc:save-settings — 학년이 바뀌면 재시작, 숫자가 아니면 저장 거부', async () => {
    const m = loadMain();
    m.ctx.registerIpc();
    const h = m.ev.ipc['yc:save-settings'];
    await h({}, { grade: '4' });
    await flush(12);
    ok(m.calls.getBoard.length >= 1, '학년 변경 뒤 재시작 안 함');
    eq(m.store.load().grade, '4');
    const before = m.calls.getBoard.length;
    await h({}, { grade: '4\uD559\uB144' });   // 정규화하면 같은 값 → 재시작 없음
    await flush(12);
    eq(m.calls.getBoard.length, before, '같은 학년(표기만 다름)에 재시작');
    const res = await h({}, { grade: '\uC0BC' });
    ok(res && res.ok === false, '잘못된 학년을 받아들임: ' + JSON.stringify(res && res.grade));
    eq(m.store.load().grade, '4', '저장값');
  });
  await check('main yc:save-settings — 교사용 주소를 넣어도 role·k 없이 저장', async () => {
    const m = loadMain();
    m.ctx.registerIpc();
    await m.ev.ipc['yc:save-settings']({}, { webAppUrl: 'https://script.google.com/macros/s/NEW/exec?role=teacher&k=SECRET#a' });
    eq(m.store.load().webAppUrl, 'https://script.google.com/macros/s/NEW/exec');
  });
  await check('main 시작 — store의 옛 주소·학년반을 정리해 다시 저장, 못 고치면 미설정', async () => {
    const m = loadMain({ store: { webAppUrl: 'https://script.google.com/macros/s/OLD/exec?role=teacher&k=SECRET#x', grade: '\uFF13\uD559\uB144', classNum: '2\uBC18' } });
    await m.fireReady();
    const s = m.store.load();
    eq([s.webAppUrl, s.grade, s.classNum], ['https://script.google.com/macros/s/OLD/exec', '3', '2']);
    const m2 = loadMain({ store: { webAppUrl: 'https://x.test/exec', grade: '3', classNum: '\uC774' } });
    await m2.fireReady();
    eq(m2.store.isConfigured(), false, '못 고친 반');
    eq(m2.calls.getCalls.length, 0, '미설정인데 호출 폴링');
  });
  await check('main 단일 인스턴스 — 잠금을 못 잡으면 quit하고 창·IPC를 만들지 않는다', async () => {
    const m = loadMain({ lock: false });
    await m.fireReady();
    ok(m.ev.lockAsked >= 1, 'requestSingleInstanceLock을 부르지 않음');
    ok(m.ev.quitCalls >= 1, 'app.quit을 부르지 않음');
    eq(m.ev.windows.length, 0, '만든 창 수');
    eq(Object.keys(m.ev.ipc).length, 0, '등록한 IPC 수');
  });
  await check('main 단일 인스턴스 — 두 번째 실행이 오면 기존 창을 보여 주고 앞으로', async () => {
    const m = loadMain();
    await m.fireReady();
    const handlers = m.ev.app['second-instance'] || [];
    ok(handlers.length === 1, 'second-instance 처리기 수: ' + handlers.length);
    const w = m.ev.windows[0];
    const shown = w.shown, focused = w.focused;
    handlers[0]({}, [], '');
    ok(w.shown > shown && w.focused > focused, '창을 띄우지 않음');
  });
  await check('main yc:test-connection — calls 응답이 배열이 아니면 연결 실패', async () => {
    const m = loadMain({ api: { getCalls: () => ({ ok: true, data: { ok: false, msg: '알 수 없는 api' } }) } });
    m.ctx.registerIpc();
    const bad = await m.ev.ipc['yc:test-connection']({}, { webAppUrl: 'https://x.test/exec?role=teacher&k=S', grade: '3', classNum: '2' });
    eq(bad && bad.ok, false, 'calls가 객체인데 통과');
    ok(m.calls.getCalls.length >= 1, 'calls를 부르지 않음');
    const m2 = loadMain();
    m2.ctx.registerIpc();
    const good = await m2.ev.ipc['yc:test-connection']({}, { webAppUrl: 'https://x.test/exec', grade: '\uFF13', classNum: '2\uBC18' });
    eq(good && good.ok, true, '정상 응답');
    eq([m2.calls.getCalls[0][1], m2.calls.getCalls[0][2]], ['3', '2'], 'calls에 보낸 학년·반');
  });
  const CALL = row => ({ row, teacher: '김교사', grade: '3', classNum: '2', num: '7', name: '가나다', message: '', time: '10:00', location: '' });
  await check('main 호출 확인 — grade·classNum 동봉, 통신 실패면 2·5·10초 뒤 3번 재시도하고 멈춘다', async () => {
    const m = loadMain({ api: { getCalls: () => ({ ok: true, data: [CALL(5)] }), confirmCall: () => ({ ok: false, error: 'fetch failed' }) } });
    m.ctx.createWindow();
    await m.ctx.tick();
    eq(m.lastSent()[0], 'yc:alert', '첫 알림');
    m.advance(31000);
    await m.ctx.tick();
    await flush();
    eq(m.calls.confirmCall.length, 1, '첫 확인');
    eq(m.calls.confirmCall[0].slice(1), [5, '3', '2'], '확인에 보낸 row·학년·반');
    const delays = [];
    for (let i = 0; i < 5; i++) {
      const ts = m.timers.timeouts();
      if (!ts.length) break;
      delays.push(ts.map(t => t.ms).join('+'));
      m.timers.runTimeouts();
      await flush();
    }
    eq(delays, ['2000', '5000', '10000'], '재시도 간격');
    eq(m.calls.confirmCall.length, 4, '확인 요청 총수(처음 1 + 재시도 3)');
  });
  await check('main 호출 확인 — 서버가 ok:false로 답하면 재시도하지 않는다', async () => {
    const m = loadMain({ api: { getCalls: () => ({ ok: true, data: [CALL(5)] }), confirmCall: () => ({ ok: true, data: { ok: false, msg: '다른 반 호출입니다' } }) } });
    m.ctx.createWindow();
    await m.ctx.tick();
    m.advance(31000);
    await m.ctx.tick();
    await flush();
    eq(m.timers.timeouts().length, 0, '예약된 재시도');
    eq(m.calls.confirmCall.length, 1);
  });
  await check('main 화면 고착 — 확인이 안 돼 서버에 남은 «이미 알린» 호출만 있으면 대기화면으로', async () => {
    let list = [CALL(5)];
    const m = loadMain({ api: { getCalls: () => ({ ok: true, data: list }), confirmCall: () => ({ ok: false, error: 'fetch failed' }) } });
    m.ctx.createWindow();
    await m.ctx.tick();
    m.advance(31000);
    await m.ctx.tick();
    eq(m.lastSent()[0], 'yc:standby', '카운트다운이 끝난 뒤');
    await m.ctx.tick();
    eq(m.lastSent()[0], 'yc:standby', '다음 폴링');
    list = [CALL(5), CALL(6)];
    await m.ctx.tick();
    eq(m.lastSent()[0], 'yc:alert', '새 호출');
    eq([m.lastSent()[1].call.row, m.lastSent()[1].queueCount], [6, 0], '새 호출 row·대기 수(남은 5번은 대기로 세지 않음)');
    // 카운트다운이 끝나는 순간 목록 받기까지 실패해도 0초 알림 화면에 멈추지 않는다
    const m2 = loadMain({ api: { getCalls: () => ({ ok: true, data: [CALL(9)] }) } });
    m2.ctx.createWindow();
    await m2.ctx.tick();
    m2.handlers.getCalls = () => ({ ok: false, error: 'timeout' });
    m2.advance(31000);
    await m2.ctx.tick();
    eq(m2.lastSent()[0], 'yc:standby', '목록 받기 실패 + 카운트다운 끝');
  });
  await check('main periodConfig — 정상 시정은 store에 저장, 모양이 틀리면 저장하지 않는다', async () => {
    let pc = PC_OK;
    const m = loadMain({ api: { getBoard: () => ({ ok: true, data: { autoDismiss: 30, periodConfig: pc } }) } });
    await m.ctx.refreshBoard();
    eq(m.store.load().periodConfig, PC_OK, '저장된 시정');
    pc = { start: '', maxPeriod: 0 };
    await m.ctx.refreshBoard();
    eq(m.store.load().periodConfig, PC_OK, '이상한 시정 뒤');
  });
  await check('main 시간표 — 한 번도 못 받음(null)과 받았는데 빔([])을 가르고, 실패는 직전값 유지', async () => {
    let tt = () => ({ ok: false, error: 'timeout' });
    const m = loadMain({ api: { getTimetable: (...a) => tt(...a) } });
    m.ctx.registerIpc();
    await m.ctx.refreshMeal();
    const snap1 = m.ev.ipc['yc:get-snapshot']();
    eq([snap1.todayTimetable, snap1.weekTimetable], [null, null], '못 받았을 때');
    tt = () => ({ ok: true, data: [] });
    await m.ctx.refreshMeal();
    tt = () => ({ ok: false, error: 'timeout' });
    await m.ctx.refreshMeal();
    eq(m.ev.ipc['yc:get-snapshot']().todayTimetable, [], '빈 결과 뒤 실패');
  });

  /* ═════════ renderer/js/app.js ═════════ */
  await check('renderer 원문에서 필요한 함수를 이름으로 뗄 수 있다', () => {
    const r = loadRenderer();
    eq(r.missing, [], '못 찾은 함수');
  });
  await check('renderer.normClassNo — main(store) 사본과 같은 답 + 안내 문구', () => {
    const r = loadRenderer();
    const a = need(r.ctx, 'normClassNo'), b = need(loadStore().exports, 'normClassNo');
    CLASS_CASES.forEach(([input]) => eq(a(input), b(input), JSON.stringify(input)));
    ok(read('renderer/js/app.js').indexOf('\uD559\uB144\u00B7\uBC18\uC740 \uC22B\uC790\uB9CC \uC785\uB825\uD574 \uC8FC\uC138\uC694 (\uC608: 3, 2)') >= 0, '안내 문구 없음');
  });
  await check('renderer.normPeriodConfig — main(store) 사본과 같은 답', () => {
    const r = loadRenderer();
    const a = need(r.ctx, 'normPeriodConfig'), b = need(loadStore().exports, 'normPeriodConfig');
    [PC_OK, Object.assign({}, PC_OK, { periodLen: '40' })].concat(PC_BAD).forEach(x => eq(a(x), b(x), JSON.stringify(x)));
  });
  await check('renderer.savePref — 슬라이더를 끄는 동안은 모았다가 400ms 뒤 한 번만 저장', () => {
    const r = loadRenderer();
    for (let i = 0; i < 5; i++) need(r.ctx, 'savePref')();
    eq(r.saved.length, 0, '바로 보낸 저장 수');
    eq(r.timers.timeouts().map(t => t.ms), [400], '예약');
    r.timers.runTimeouts();
    eq(r.saved.length, 1, '저장 수');
    eq([r.saved[0].soundIndex, r.saved[0].volume, r.saved[0].ttsVolume, r.saved[0].repeatCount], [3, 7, 9, 2]);
  });
  await check('renderer.renderPeriodRow — 교체 칸에 chg·«교체»·«원래 과목», 과목은 이스케이프', () => {
    const r = loadRenderer();
    need(r.ctx, 'renderPeriodRow')([
      { period: 1, subject: '국어' },
      { period: 2, subject: '<img src=x onerror=alert(1)>', changed: true, orig: '수학&과학', teacher: '김', origTeacher: '이' },
      { period: 3, subject: '영어', changed: true, orig: '영어' }
    ]);
    const h = r.dom.byId.periodRow.innerHTML;
    ok(h.indexOf('<img') < 0, '이스케이프 안 됨: ' + h.slice(0, 300));
    ok(h.indexOf('&lt;img src=x') >= 0, '과목 글자가 사라짐');
    ok(/class="period chg" id="p-2"/.test(h), '2교시 chg 없음');
    ok(/id="p-2"><div class="pn">2교시<span class="chg-tag">교체<\/span><\/div>/.test(h), '«교체» 태그 없음');
    ok(h.indexOf('<div class="po">원래 수학&amp;과학</div>') >= 0, '«원래 과목» 없음');
    ok(/class="period" id="p-1"/.test(h), '1교시가 chg로 잘못 표시');
    ok(!/원래 영어/.test(h), '원래 과목이 같으면 «원래»를 쓰지 않는다');
  });
  await check('renderer.renderPeriodRow — 같은 교시 여러 줄은 «과목이 있는 첫 줄», 배열이 아니어도 안 죽는다', () => {
    const r = loadRenderer();
    r.ctx.renderPeriodRow([{ period: 1, subject: '국어' }, { period: 1, subject: '수학' }, { period: 2, subject: '' }, { period: 2, subject: '과학' }]);
    const h = r.dom.byId.periodRow.innerHTML;
    ok(h.indexOf('id="p-1"><div class="pn">1교시</div><div class="ps">국어</div>') >= 0, '1교시가 국어가 아님: ' + h.slice(0, 200));
    ok(h.indexOf('<div class="ps">과학</div>') >= 0, '2교시 과학 없음');
    const r2 = loadRenderer();
    r2.ctx.renderPeriodRow({ ok: false, msg: 'x' });
    ok(r2.dom.byId.periodRow.innerHTML.indexOf('\uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588') >= 0, '못 받음 안내 없음: ' + r2.dom.byId.periodRow.innerHTML);
  });
  await check('renderer.renderWeek — 교체 칸 chg·title·범례, 과목 이스케이프, 과목이 있는 첫 줄', () => {
    const r = loadRenderer();
    const k = thisWeekKeys();
    const map = {};
    map[k[0]] = [{ period: 1, subject: '' }, { period: 1, subject: '체육' }, { period: 2, subject: '<b>음악</b>', changed: true, orig: '미술"' }];
    map[k[1]] = [{ period: 1, subject: '국어' }];
    need(r.ctx, 'renderWeek')(map);
    const h = r.dom.byId.weekWrap.innerHTML;
    ok(h.indexOf('<b>') < 0, '이스케이프 안 됨');
    ok(/<td class="[^"]*\bchg\b[^"]*" title="원래 미술&quot;">&lt;b&gt;음악&lt;\/b&gt;<\/td>/.test(h), '교체 칸 모양이 다름: ' + h);
    ok(h.indexOf('class="week-legend"') >= 0, '범례 없음');
    ok(/>체육<\/td>/.test(h), '과목 있는 첫 줄(체육)이 아님');
    const r2 = loadRenderer();
    const m2 = {}; m2[k[0]] = [{ period: 1, subject: '국어' }];
    r2.ctx.renderWeek(m2);
    ok(r2.dom.byId.weekWrap.innerHTML.indexOf('week-legend') < 0, '교체가 없는데 범례');
  });
  await check('renderer.renderMeal — 급식 반찬 글자를 이스케이프한다', () => {
    const r = loadRenderer();
    need(r.ctx, 'renderMeal')([{ type: '중식', dishes: ['<script>x</script>', '김치&밥'], kcal: '800', allergy: ['1'] }]);
    const h = r.dom.byId.mealList.innerHTML;
    ok(h.indexOf('<script>') < 0, '이스케이프 안 됨');
    ok(h.indexOf('&lt;script&gt;x&lt;/script&gt;<br>김치&amp;밥') >= 0, '반찬 모양이 다름: ' + h);
  });
  await check('renderer.currentPeriodStatus — 주말', () => {
    const r = loadRenderer();
    r.ctx.renderPeriodRow(periods(6));
    eq(need(r.ctx, 'currentPeriodStatus')(600, SAT_1000).label, '주말');
  });
  await check('renderer.currentPeriodStatus — 이번 주엔 있는데 오늘만 빈 날 «오늘은 수업이 없어요»', () => {
    const r = loadRenderer();
    // 주간표의 «오늘» 칸은 실제 오늘 날짜로 본다 — 과목을 넣는 요일이 검사하는 날과 겹치면 거짓 실패하므로 오늘이 아닌 요일에 넣는다
    const todayKey = r.ctx.ymdKey(new Date());
    const map = {}; map[thisWeekKeys().filter(k => k !== todayKey)[0]] = periods(6);
    r.ctx.renderWeek(map);
    r.ctx.renderPeriodRow([]);
    eq(r.ctx.currentPeriodStatus(600, MON_1000).label, '오늘은 수업이 없어요');
  });
  await check('renderer.currentPeriodStatus — 오늘 조회만 실패(빈 목록)해도 주간표에 오늘 과목이 있으면 수업 있는 날', () => {
    const r = loadRenderer();
    const map = {}; map[r.ctx.ymdKey(new Date())] = periods(6);
    r.ctx.renderWeek(map);
    r.ctx.renderPeriodRow([]);
    eq(r.ctx.currentPeriodStatus(600, MON_1000).label, '2교시 수업중');
    eq(r.ctx.currentPeriodStatus(912, MON_1000).label, '방과후');   // 15:12 — 마지막 교시는 주간표의 오늘(6교시)
  });
  await check('renderer.currentPeriodStatus — 이번 주가 통째로 비면 판정하지 않고 시정대로', () => {
    const r = loadRenderer();
    r.ctx.renderWeek({});
    r.ctx.renderPeriodRow([]);
    eq(r.ctx.currentPeriodStatus(600, MON_1000).label, '2교시 수업중');
  });
  await check('renderer.currentPeriodStatus — 오늘 마지막 교시까지만, 못 받았으면(null) 시정 전체', () => {
    const r = loadRenderer();
    r.ctx.renderPeriodRow(periods(5));
    eq(r.ctx.currentPeriodStatus(800, MON_1000).label, '5교시 수업중', '13:20');
    eq(r.ctx.currentPeriodStatus(850, MON_1000).label, '방과후', '14:10(6교시 없는 날)');
    const r2 = loadRenderer();
    r2.ctx.renderPeriodRow(null);
    eq(r2.ctx.currentPeriodStatus(850, MON_1000).label, '6교시 수업중', '못 받음');
  });
  await check('renderer.applyPeriodConfig — 형태 검사, 바뀌면 SCHEDULE 재계산 + 오늘·주간 다시 그리기', () => {
    const r = loadRenderer();
    const apply = need(r.ctx, 'applyPeriodConfig');
    r.ctx.renderPeriodRow(periods(6));
    const map = {}; map[thisWeekKeys()[0]] = periods(6);
    r.ctx.renderWeek(map);
    const before = r.run('JSON.stringify(PERIOD_CONFIG)');
    PC_BAD.forEach(b => apply(b));
    eq(r.run('JSON.stringify(PERIOD_CONFIG)'), before, '이상한 시정에 바뀜');
    apply({ start: '09:00', periodLen: 40, breakLen: 10, lunchAfter: 0, lunchLen: 50, maxPeriod: 5 });
    eq(r.run('SCHEDULE.length'), 5, '점심 없는 5교시 시정');
    const h = r.dom.byId.periodRow.innerHTML;
    eq((h.match(/id="p-/g) || []).length, 5, '다시 그린 오늘 칸 수(옛 칸이 남으면 안 됨)');
    ok(h.indexOf('p-lunch') < 0, '점심 칸이 남음');
    eq((r.dom.byId.weekWrap.innerHTML.match(/<td class="pnum">/g) || []).length, 5, '다시 그린 주간 줄 수');
    eq(r.run('toMinutes("09:00") === SCHEDULE[0].start'), true, '1교시 시작');
  });

  console.log('');
  console.log('통과 ' + pass + ' / 실패 ' + fail + ' (총 ' + (pass + fail) + ')');
  if (fail) console.log('실패 목록: ' + failed.join(' | '));
  process.exit(fail ? 1 : 0);
})();
