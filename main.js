// 유콜 데스크 — 전자칠판용 설치형 클라이언트
// 상태 머신(호출 대기열/카운트다운/자동확인)은 전부 메인 프로세스가 갖는다.
// 렌더러가 숨겨진(트레이) 상태에서도 타이머가 스로틀될 걱정 없이 정확히 동작하도록 하기 위함.
// 렌더러는 순수 표시 담당 — main이 보내주는 이벤트를 그리기만 한다.
const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./main/store');
const api = require('./main/api');

const SMOKE = process.argv.includes('--smoke'); // TeacherDesk2와 동일한 검증 기법: 오프스크린 캡처 후 자동 종료

const POLL_MS = 3000;          // 호출 감지 주기 — 여러 반 상시 폴링의 서버 동시접속 부하를 줄이려 3초로
const BOARD_REFRESH_MS = 3 * 60 * 1000;   // 공지/설정(getBoard) 재조회 주기 — NEIS 미사용·부하 미미, 긴급공지·학급메모 빠른 반영 위해 짧게 유지
const MEAL_REFRESH_MS = 30 * 60 * 1000;   // 급식/시간표(NEIS) 재조회 주기 — 자주 바뀌지 않으므로 드물게
const MEAL_RETRY_MS = 90 * 1000;          // 급식/시간표 중 하나라도 실패하면 30분 안 기다리고 빠르게 1회 재시도

let win = null;
let tray = null;
let quitting = false;
let pollTimer = null;
let boardTimer = null;
let mealTimer = null;
let mealRetryTimer = null;
// 폴링 «세대» — startPolling·stopAllTimers가 부를 때마다 1씩 오른다.
// 예전엔 startPolling이 await 뒤에 setInterval을 만들어, 응답을 기다리는 사이 또 불리면(볼륨 슬라이더를 끌 때마다
// 설정 저장 → 재시작) 3초·3분·30분 타이머가 겹겹이 쌓였다. 기다렸다 돌아온 쪽은 세대가 바뀌었으면 아무것도 만들지 않는다.
let pollGen = 0;
const confirmRetryTimers = new Set();   // 호출 확인 재시도 예약 — 종료·재시작 때 stopAllTimers가 함께 지운다
const CONFIRM_RETRY_MS = [2000, 5000, 10000];
const CLASS_NO_MSG = '학년·반은 숫자만 입력해 주세요 (예: 3, 2)';

// ── 급식/시간표 직전 성공값(last-good) — NEIS 일시 실패 시 빈값으로 덮지 않고 이 값을 유지한다 ──
let lastMeal = [];
// 시간표는 null(한 번도 못 받음)과 []·{}(받았는데 비었음)를 가른다 — 못 받은 걸 «오늘은 수업이 없어요»로 그리지 않게
let lastToday = null;
let lastWeek = null;
let lastBoard = null;   // 렌더러가 준비되기 전에 도착한 board를 잃지 않도록 캐시해 둔다

// ── 호출 상태 머신 ──
let alertedRows = new Set();  // 이번 실행 동안 이미 알림을 시작한 row (재알림 방지)
let current = null;           // 지금 화면에 보여주고 있는 호출 { row, ..., deadlineAt }
let autoDismissSec = 30;      // board 데이터로 갱신됨

function cfg() { return store.load(); }
// 서버에 보낼 학년·반 — 저장값은 켤 때·저장할 때 이미 맞추지만, 스모크(--settings)처럼 우회한 값도 숫자로 보낸다
function classOf(s) { return { grade: store.normClassNo(s.grade), classNum: store.normClassNo(s.classNum) }; }

// 창이 살아 있어도 webContents만 먼저 파괴되는 순간이 있다 — 종료 중이면 아예 건드리지 않는다.
function alive() {
  return !quitting && win && !win.isDestroyed()
      && win.webContents && !win.webContents.isDestroyed();
}

function stopAllTimers() {
  pollGen++;   // 응답을 기다리던 startPolling·tick·refresh는 돌아와서 세대가 바뀐 걸 보고 타이머를 만들지 않는다
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (boardTimer) { clearInterval(boardTimer); boardTimer = null; }
  if (mealTimer) { clearInterval(mealTimer); mealTimer = null; }
  if (mealRetryTimer) { clearTimeout(mealRetryTimer); mealRetryTimer = null; }
  confirmRetryTimers.forEach(t => clearTimeout(t));
  confirmRetryTimers.clear();
}

function createWindow() {
  const s = cfg();
  const bounds = s.windowBounds || { width: 960, height: 640 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 480,
    minHeight: 360,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // 닫기(X) → 완전 종료 대신 트레이로 숨김. 백그라운드 폴링은 계속된다.
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  // 창 크기/위치를 기억해뒀다가 다음 실행 때 복원
  const saveBounds = () => { if (win && !win.isDestroyed()) store.save({ windowBounds: win.getBounds() }); };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
}

function showAndFocus() {
  // 종료 중에 창을 다시 띄우면 윈도우 종료가 그만큼 더 막힌다
  if (quitting) return;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ── 단일 인스턴스 ──
// 자동 실행으로 트레이에 떠 있는데 바탕화면 아이콘을 또 누르면 유콜 데스크가 둘이 돌아
// 호출 하나에 알림·음성이 두 번 나고 서버 폴링도 두 배가 됐다. 나중에 뜬 쪽은 곧바로 물러나고
// 먼저 떠 있던 창을 앞으로 불러온다(자동 실행이든 수동 실행이든 «먼저 뜬 쪽»이 남는다).
// 스모크 검증(--smoke)은 설치본이 트레이에 떠 있어도 돌아야 하므로 잠금을 잡지 않는다.
const gotLock = SMOKE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  quitting = true;
  app.quit();
} else {
  // 창이 아직 없으면(자동 실행 직후 준비 중) showAndFocus가 알아서 넘어간다
  app.on('second-instance', () => showAndFocus());
}

function notifyNewCall(call) {
  if (!Notification.isSupported()) return;
  const loc = call.location ? ' · ' + call.location : '';
  new Notification({
    title: '📣 ' + call.num + '번 ' + call.name + ' 학생 호출',
    body: (call.teacher ? call.teacher + ' 선생님' : '') + (call.message ? ' — ' + call.message : '') + loc
  }).show();
}

// ── 트레이 ──
function refreshTrayMenu() {
  // 종료가 시작되면 트레이는 이미 파괴됐을 수 있다 — 건드리면 'Object has been destroyed'가 난다
  if (quitting) return;
  if (!tray || tray.isDestroyed()) return;
  const s = cfg();
  const menu = Menu.buildFromTemplate([
    { label: '열기', click: showAndFocus },
    { type: 'separator' },
    { label: '상시화면 표시', type: 'checkbox', checked: s.showStandby, click: it => { store.save({ showStandby: it.checked }); pushSettings(); } },
    { label: '새 호출 시 창 자동 복원', type: 'checkbox', checked: s.autoRestoreOnCall, click: it => { store.save({ autoRestoreOnCall: it.checked }); pushSettings(); } },
    { label: '윈도우 시작 시 자동 실행', type: 'checkbox', checked: s.autoLaunch, click: it => { store.save({ autoLaunch: it.checked }); applyAutoLaunch(it.checked); } },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('유콜 데스크');
  tray.on('double-click', showAndFocus);
  refreshTrayMenu();
}

function applyAutoLaunch(on) {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on });
}

function pushSettings() {
  if (alive()) win.webContents.send('yc:settings', cfg());
}

// ── (A) 공지/설정 갱신 — getBoard만. 자주(BOARD_REFRESH_MS) 돈다. ──
// NEIS를 쓰지 않아 부하가 미미하고, 긴급공지·학급메모가 빨리 반영돼야 하므로 짧게 둔다.
// 렌더러엔 board만 실어 보낸다(부분 업데이트) — 실패 시엔 보내지 않아 기존 화면을 유지한다.
async function refreshBoard() {
  if (quitting) return;
  const s = cfg();
  if (!store.isConfigured()) return;
  const gen = pollGen;
  const { grade, classNum } = classOf(s);
  const board = await api.getBoard(s.webAppUrl, grade, classNum);
  if (quitting || gen !== pollGen) return;   // 기다리는 사이 종료·재시작(주소·반 변경)이 있었으면 옛 응답은 버린다
  if (!board.ok || !board.data || typeof board.data !== 'object' || Array.isArray(board.data)) return;
  if (typeof board.data.autoDismiss === 'number') autoDismissSec = board.data.autoDismiss;
  lastBoard = board.data;
  // 정상 시정은 기억해 둔다 — 다음에 켤 때 board보다 시간표가 먼저 그려져도 이 학교 시정을 쓴다
  const pc = store.normPeriodConfig(board.data.periodConfig);
  if (pc && JSON.stringify(pc) !== JSON.stringify(store.normPeriodConfig(s.periodConfig))) store.save({ periodConfig: pc });
  if (alive()) win.webContents.send('yc:board', { board: board.data });
}

// ── (B) 급식/시간표 갱신 — getMeal + getTimetable(today/week). 드물게(MEAL_REFRESH_MS) 돈다. ──
// 성공한 항목만 last-good으로 갱신하고, 실패한 항목은 직전값을 유지한다(NEIS 일시 실패 시 "없음"으로 깜빡이지 않게).
// 셋 중 하나라도 실패하면 30분을 기다리지 않고 MEAL_RETRY_MS 뒤 1회 더 시도한다(중복 예약 방지).
async function refreshMeal() {
  if (quitting) return;
  if (!store.isConfigured()) return;
  if (mealRetryTimer) { clearTimeout(mealRetryTimer); mealRetryTimer = null; }
  const s = cfg();
  const gen = pollGen;
  const { grade, classNum } = classOf(s);
  const [meal, today, week] = await Promise.all([
    api.getMeal(s.webAppUrl),
    api.getTimetable(s.webAppUrl, grade, classNum, 'today'),
    api.getTimetable(s.webAppUrl, grade, classNum, 'week')
  ]);
  if (quitting || gen !== pollGen) return;   // 기다리는 사이 종료·재시작이 있었으면 옛 반의 응답은 버린다
  // 오류 응답({ok:false,msg})이 JSON으로 오면 fetch는 성공이다 — 모양까지 맞아야 성공으로 친다
  const todayOk = today.ok && Array.isArray(today.data);
  const weekOk = week.ok && !!week.data && typeof week.data === 'object' && !Array.isArray(week.data);
  if (meal.ok) lastMeal = meal.data;   // 실패면 직전값 유지(빈값으로 덮지 않음)
  if (todayOk) lastToday = today.data;
  if (weekOk) lastWeek = week.data;
  if (alive()) {
    win.webContents.send('yc:board', {
      meal: lastMeal,
      todayTimetable: lastToday,
      weekTimetable: lastWeek
    });
  }
  if (!meal.ok || !todayOk || !weekOk) {
    if (mealRetryTimer) clearTimeout(mealRetryTimer);
    mealRetryTimer = setTimeout(refreshMeal, MEAL_RETRY_MS);
  }
}

// ── 호출 폴링 + 상태 머신 ──
// 웹 학생화면(index.html)의 checkStudent/showStudentAlert/startCountdown과 동일한 동작을
// 메인 프로세스 쪽 상태 머신으로 재구현한 것 — 렌더러가 숨겨져 있어도 정확히 돈다.

// 호출 확인 — 예전엔 결과를 버려서, 통신이 한 번 끊기면 서버에 «미확인»으로 남은 호출이 화면을 붙잡았다.
// 통신 실패(응답 없음·HTTP 오류)만 2·5·10초 뒤 최대 3번 다시 보낸다. 서버가 답을 했으면(ok든 ok:false든) 끝 —
// ok:false(다른 반·범위 밖·이미 지워진 행)는 다시 보내도 같은 답이다. 기다리지 않고 화면은 곧바로 넘긴다.
function confirmWithRetry(webAppUrl, row, grade, classNum, attempt) {
  attempt = attempt || 0;
  return Promise.resolve(api.confirmCall(webAppUrl, row, grade, classNum)).then(res => {
    if (quitting || (res && res.ok)) return res;
    if (attempt >= CONFIRM_RETRY_MS.length) {
      logError('confirm', 'row ' + row + ' 확인 실패(재시도 ' + attempt + '번): ' + (res && res.error));
      return res;
    }
    const t = setTimeout(() => {
      confirmRetryTimers.delete(t);
      confirmWithRetry(webAppUrl, row, grade, classNum, attempt + 1);
    }, CONFIRM_RETRY_MS[attempt]);
    confirmRetryTimers.add(t);
    return res;
  });
}

async function tick() {
  if (quitting) return;
  const s = cfg();
  if (!store.isConfigured()) return;
  const gen = pollGen;
  const { grade, classNum } = classOf(s);

  // 현재 표시 중인 호출의 카운트다운이 끝났으면 확인 처리 후 다음으로 넘어간다
  let dismissed = false;
  if (current && Date.now() >= current.deadlineAt) {
    confirmWithRetry(s.webAppUrl, current.row, grade, classNum);   // 기다리지 않는다(재시도는 뒤에서 따로)
    current = null;
    dismissed = true;
  }

  const res = await api.getCalls(s.webAppUrl, grade, classNum);
  if (quitting || gen !== pollGen) return;   // 기다리는 사이 종료·재시작이 있었으면 옛 반의 목록은 버린다
  if (!res.ok || !Array.isArray(res.data)) {
    // 네트워크 오류 — 다음 폴링에서 재시도. 단 방금 카운트다운이 끝났으면 «0초» 알림에 멈춰 있지 않게 대기화면으로.
    if (dismissed && alive()) win.webContents.send('yc:standby');
    return;
  }

  const calls = res.data;
  // 아직 한 번도 띄우지 않은 호출만 «대기»로 센다 — 확인이 안 돼 서버에 남은 지난 호출까지 세면 «+ 대기 1건»이 거짓으로 뜬다
  const waiting = () => calls.filter(c => c && !alertedRows.has(c.row)).length;

  if (!current) {
    const fresh = calls.find(c => c && !alertedRows.has(c.row));
    if (fresh) {
      alertedRows.add(fresh.row);
      current = Object.assign({}, fresh, { deadlineAt: Date.now() + autoDismissSec * 1000, totalSec: autoDismissSec });
      if (alive()) win.webContents.send('yc:alert', { call: current, queueCount: waiting() });

      if (s.autoRestoreOnCall) showAndFocus();
      else notifyNewCall(fresh);
      return;
    }
    // 보여 줄 호출이 없으면 대기화면. 예전엔 목록이 «비어야»만 돌아가서, 확인이 실패해 서버에 남은
    // 이미 알린 호출 하나가 새 호출도 아니고 빈 목록도 아니게 되어 알림 화면에 그대로 멈췄다.
    if (alive()) win.webContents.send('yc:standby');
    return;
  }

  // 이미 표시 중인 호출이 있으면 대기열 숫자만 갱신
  if (alive()) win.webContents.send('yc:alert', { call: current, queueCount: waiting() });
}

async function startPolling() {
  stopAllTimers();          // 세대도 여기서 오른다 — 앞서 불려 응답을 기다리던 startPolling은 돌아와서 물러난다
  const gen = pollGen;
  if (quitting || !store.isConfigured()) return;   // 설정이 끝나면 yc:save-settings가 다시 부른다
  await refreshBoard();     // 시정(periodConfig)·autoDismissSec을 먼저 채워야 시간표 칸과 첫 알림 카운트다운이 맞는다
  if (gen !== pollGen || quitting) return;
  refreshMeal();            // 그다음 급식/시간표 — 기다리지 않는다(NEIS가 느려도 호출 감지는 바로 시작)
  await tick();
  if (gen !== pollGen || quitting) return;
  pollTimer = setInterval(tick, POLL_MS);
  boardTimer = setInterval(refreshBoard, BOARD_REFRESH_MS);
  mealTimer = setInterval(refreshMeal, MEAL_REFRESH_MS);
}

// 켤 때 store를 정리한다 — 예전 판이 저장한 교사용 주소(role·k)와 «3학년»·«２» 같은 학년·반.
// 고칠 수 있으면 고쳐 다시 저장하고, 못 고치면 값은 그대로 두되 isConfigured()가 미설정으로 봐 설정 화면이 뜬다.
function sanitizeStoredSettings() {
  const s = cfg();
  const patch = {};
  if (s.webAppUrl) {
    const clean = api.cleanWebAppUrl(s.webAppUrl);
    if (clean !== s.webAppUrl) patch.webAppUrl = clean;
  }
  ['grade', 'classNum'].forEach(key => {
    const raw = s[key];
    if (raw === '' || raw == null) return;
    const n = store.normClassNo(raw);
    if (n && n !== raw) patch[key] = n;
  });
  if (Object.keys(patch).length) store.save(patch);
}

// ── IPC ──
function registerIpc() {
  ipcMain.handle('yc:get-settings', () => cfg());
  // 렌더러는 DOMContentLoaded 뒤에야 onBoard 리스너를 단다 — 그 전에 폴링이 먼저 끝나면
  // 첫 데이터가 통째로 유실돼 급식은 30분, 공지는 3분 동안 "불러오는 중..."에 머물렀다.
  // 렌더러가 준비되면 이걸 한 번 당겨가 즉시 그린다(서버를 다시 부르지 않는다).
  ipcMain.handle('yc:get-snapshot', () => ({
    board: lastBoard,
    meal: lastMeal,
    todayTimetable: lastToday,
    weekTimetable: lastWeek
  }));
  ipcMain.handle('yc:save-settings', (e, patch) => {
    patch = Object.assign({}, patch);
    if ('webAppUrl' in patch) patch.webAppUrl = api.cleanWebAppUrl(patch.webAppUrl);   // role·k는 기기에 남기지 않는다
    for (const key of ['grade', 'classNum']) {
      if (!(key in patch)) continue;
      const n = store.normClassNo(patch[key]);
      if (!n) return { ok: false, error: CLASS_NO_MSG };   // 설정 화면이 먼저 막지만, 숫자가 아닌 학년·반은 저장 자체를 하지 않는다
      patch[key] = n;
    }
    const before = cfg();
    const prev = { webAppUrl: before.webAppUrl, grade: String(before.grade), classNum: String(before.classNum) };
    const next = store.save(patch);
    if (typeof patch.autoLaunch === 'boolean') applyAutoLaunch(patch.autoLaunch);
    refreshTrayMenu();
    // 폴링은 주소·학년·반이 «바뀌었을 때만» 다시 시작한다. 소리·볼륨 저장(슬라이더를 끌 때마다 온다)까지
    // 재시작하면 매번 서버를 세 번씩 다시 부르고, 예전엔 타이머까지 쌓였다.
    const urlChanged = next.webAppUrl !== prev.webAppUrl;
    if (urlChanged || String(next.grade) !== prev.grade || String(next.classNum) !== prev.classNum) {
      // 옛 반의 표시 중 호출·시간표·공지는 새 반 화면에 섞이지 않게 비운다(설정 화면은 저장 뒤 새로고침한다)
      current = null;
      lastBoard = null; lastToday = null; lastWeek = null;
      if (urlChanged) lastMeal = [];
      startPolling();
    }
    return next;
  });
  ipcMain.handle('yc:get-tts', (e, text) => api.getTts(cfg().webAppUrl, text));
  ipcMain.handle('yc:test-connection', async (e, { webAppUrl, grade, classNum }) => {
    const url = api.cleanWebAppUrl(webAppUrl);
    const g = store.normClassNo(grade), c = store.normClassNo(classNum);
    if (!g || !c) return { ok: false, error: CLASS_NO_MSG };
    // GAS가 한동안 안 쓰이다 깨어나는 순간엔 응답이 8초를 넘겨 정상 URL도 "연결 실패"로 뜨던 문제 —
    // 확인 단계만 30초 제한 + 최대 3회 재시도. 첫 시도가 서버를 깨워놔서 재시도는 대부분 바로 붙는다.
    let test = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      test = await api.getBoard(url, g, c, 30000);
      if (test.ok) break;
    }
    if (!test.ok) return test;
    // board만 보면 호출을 받아 올 길이 막혀 있어도 통과한다 — 실제로 호출 목록(calls)이 «배열»로 오는지까지 본다
    const calls = await api.getCalls(url, g, c, 30000);
    if (!calls.ok) return calls;
    if (!Array.isArray(calls.data)) return { ok: false, error: '호출 목록 응답이 올바르지 않습니다' };
    return test;
  });
  ipcMain.handle('yc:quit', () => { quitting = true; app.quit(); });
}

// ─────────────── 스모크 테스트 (--smoke): 오프스크린 캡처 후 자동 종료 ───────────────
// --open=cfg 로 설정화면을, --settings='{"...json..."}' 로 사전 설정된 상태를 스크린샷할 수 있다.
async function runSmoke() {
  registerIpc();
  const settingsArg = (process.argv.find(a => a.startsWith('--settings=')) || '').slice(11);
  if (settingsArg) { try { store.save(JSON.parse(settingsArg)); } catch (e) { /* ignore */ } }

  const w = new BrowserWindow({
    width: 1280, height: 800, show: false, frame: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') }
  });
  win = w; // tick()/refreshBoard()가 module-level win으로 이벤트를 보내므로 스모크 창을 그대로 연결한다
  const errs = [];
  w.webContents.on('console-message', (e, lvl, msg) => { if (lvl >= 2 && !/Insecure Content-Security/.test(msg)) errs.push(msg); });

  await w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 1000));

  if (store.isConfigured()) startPolling();

  const openArg = (process.argv.find(a => a.startsWith('--open=')) || '').slice(7);
  if (openArg === 'cfg') await w.webContents.executeJavaScript('openCfgModal()').catch(() => {});

  const waitMs = parseInt((process.argv.find(a => a.startsWith('--wait=')) || '').slice(7)) || 1500;
  await new Promise(r => setTimeout(r, waitMs));
  const img = await w.webContents.capturePage();
  const out = path.join(app.getPath('userData'), 'smoke.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  console.log('SMOKE_SHOT ' + out);
  console.log(errs.length ? 'SMOKE_ERRORS\n' + errs.join('\n') : 'SMOKE_CLEAN');
  app.exit(errs.length ? 1 : 0);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // File/Edit/View/Window/Help 기본 메뉴 제거 — 전자칠판 화면에 불필요
  if (SMOKE) { runSmoke(); return; }
  if (!gotLock) return;   // 먼저 떠 있는 유콜 데스크가 있다 — 창·트레이·폴링을 만들지 않고 물러난다
  sanitizeStoredSettings();   // 창이 설정을 읽기 전에 옛 주소(role·k)·학년반 표기를 정리한다
  registerIpc();
  createWindow();
  createTray();
  applyAutoLaunch(cfg().autoLaunch);
  startPolling();
});

// 메인 프로세스에서 예외가 새어 나오면 Electron이 'A JavaScript error occurred…'
// 대화상자를 띄우는데, 그 창이 떠 있는 동안 윈도우 종료가 통째로 막힌다.
// 오류는 삼키지 않고 userData\error.log에 남긴다.
function logError(tag, err) {
  try {
    const line = new Date().toISOString() + '  [' + tag + ']  ' + ((err && err.stack) || err) + '\n';
    fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), line, 'utf8');
  } catch (e) { /* 로그조차 못 남기는 상황이면 조용히 넘어간다 */ }
}
process.on('uncaughtException',  err => logError('uncaught',  err));
process.on('unhandledRejection', err => logError('rejection', err));

// 트레이 상주 — 창이 닫혀도 앱은 유지. 단 종료 중이라면 붙잡지 않는다.
app.on('window-all-closed', e => { if (SMOKE || quitting) app.quit(); else e.preventDefault(); });

app.on('before-quit', () => {
  quitting = true;
  stopAllTimers();
  // 잠금을 못 잡고 물러나는 두 번째 인스턴스는 store를 쓰지 않는다 — 먼저 떠 있는 쪽이 방금 저장한 값을 옛 값으로 덮을 수 있다
  if (gotLock) store.flushSync();
});

// 윈도우 종료·재시작·로그오프.
// 이때는 app.quit()이 불리지 않아 before-quit도 안 온다 — 폴링이 그대로 살아
// 이미 파괴된 창·트레이를 건드리다 오류 대화상자를 띄우고 종료를 막는다.
// 여기서 스스로 물러나야 윈도우가 기다리지 않는다.
app.on('session-end', () => {
  quitting = true;
  stopAllTimers();
  try { store.flushSync(); } catch (e) {}          // 설정·창 위치는 잃지 않는다
  try { if (tray && !tray.isDestroyed()) tray.destroy(); } catch (e) {}
  try { app.exit(0); } catch (e) {}
});
