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
  windowBounds: null   // {x,y,width,height} — 마지막 창 크기/위치 기억
};

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

function isConfigured() {
  const s = load();
  return !!(s.webAppUrl && s.grade && s.classNum);
}

module.exports = { load, save, flushSync, isConfigured, DEFAULTS };
