// JSON 스토어 — TeacherDesk2/main/store.js와 동일한 원자적 쓰기 패턴(tmp → 백업 → rename).
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const file = () => path.join(app.getPath('userData'), 'store.json');
const bak = () => path.join(app.getPath('userData'), 'store.backup.json');

const DEFAULTS = {
  v: 1,
  webAppUrl: '',       // 예: https://script.google.com/macros/s/AKfycb.../exec
  grade: '',
  classNum: '',
  showStandby: true,   // 상시(대기)화면 표시 on/off
  autoRestoreOnCall: true, // true=창 자동 복원, false=토스트 알림만
  autoLaunch: true,
  soundIndex: 0,
  volume: 5,
  repeatCount: 2,
  ttsVolume: 10,
  periodConfig: null,  // 마지막으로 받은 정상 시정 — 켤 때 board가 오기 전에도 이 학교 시정으로 그린다
  windowBounds: null   // {x,y,width,height} — 마지막 창 크기/위치 기억
};

/* 학년·반 — 서버 v4.24(digits_)는 숫자만 받는다. «3학년»·«２»를 그대로 보내면 board 연결 확인은 통과하는데
   calls·timetable이 빈 배열로 와서 호출이 «조용히» 안 온다. 전각 숫자는 반각으로, 끝의 «학년»«반»과 공백은 걷고,
   1~2자리 숫자만 «03»→«3»처럼 맞춘다. 고칠 수 없으면 ''.
   ※ renderer/js/app.js에 같은 사본이 있다(설정 화면에서 바로 안내하려고) — 같이 고친다. */
function normClassNo(v) {
  // 전각 숫자(U+FF10~FF19)는 글자 코드로 바꾼다 — 소스에 전각 글자를 직접 적지 않는다(편집 도구가 조용히 바꾼다)
  var s = String(v == null ? '' : v).split('').map(function (ch) {
    var c = ch.charCodeAt(0);
    return (c >= 0xFF10 && c <= 0xFF19) ? String.fromCharCode(c - 0xFEE0) : ch;
  }).join('')
    .replace(/\s+/g, '')          // JS \s는 NBSP(00A0)·전각 공백(3000)까지 잡는다
    .replace(/(학년|반)$/, '');
  if (!/^\d{1,2}$/.test(s)) return '';
  var n = Number(s);
  return n >= 1 ? String(n) : '';
}

/* 시정(periodConfig) 형태 검사 — 모양이 맞으면 숫자로 맞춘 새 객체, 아니면 null.
   이상한 값으로 시정표를 다시 만들면 시간표 칸이 통째로 틀어지므로 받지 않고 직전 시정을 쓴다.
   lunchAfter 0 = 점심 없음(서버 v4.24). ※ renderer/js/app.js에 같은 사본이 있다 — 같이 고친다. */
function normPeriodConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(cfg.start == null ? '' : cfg.start).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  function int(v, lo, hi) {
    var n = (typeof v === 'string' && v.trim() !== '') ? Number(v) : v;
    return (typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n >= lo && n <= hi) ? n : null;
  }
  var out = {
    start: m[1].padStart(2, '0') + ':' + m[2],
    periodLen: int(cfg.periodLen, 1, 180),
    breakLen: int(cfg.breakLen, 0, 60),
    lunchAfter: int(cfg.lunchAfter, 0, 12),
    lunchLen: int(cfg.lunchLen, 0, 180),
    maxPeriod: int(cfg.maxPeriod, 1, 12)
  };
  for (var k in out) { if (out[k] === null) return null; }
  return out;
}

let mem = null;

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || base === null ||
      typeof over !== 'object' || over === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

function load() {
  if (mem) return mem;
  let raw = null;
  for (const p of [file(), bak()]) {
    try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch (e) { /* 다음 후보 */ }
  }
  mem = raw ? deepMerge(DEFAULTS, raw) : JSON.parse(JSON.stringify(DEFAULTS));
  return mem;
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = file() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(mem), 'utf8');
      try { if (fs.existsSync(file())) fs.copyFileSync(file(), bak()); } catch (e) { /* ignore */ }
      fs.renameSync(tmp, file());
    } catch (e) { /* 디스크 오류 — 다음 저장에서 재시도 */ }
  }, 250);
}

function save(patch) {
  const s = load();
  mem = deepMerge(s, patch || {});
  persist();
  return mem;
}

function flushSync() {
  clearTimeout(saveTimer);
  try { fs.writeFileSync(file(), JSON.stringify(mem || load()), 'utf8'); } catch (e) { /* ignore */ }
}

// 학년·반이 숫자로 읽혀야 설정된 것 — «삼»처럼 고칠 수 없는 값이면 미설정으로 보고 설정 화면을 띄운다
function isConfigured() {
  const s = load();
  return !!(s.webAppUrl && normClassNo(s.grade) && normClassNo(s.classNum));
}

module.exports = { load, save, flushSync, isConfigured, normClassNo, normPeriodConfig, DEFAULTS };
