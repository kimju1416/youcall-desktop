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

// ── 급식/시간표 직전 성공값(last-good) — NEIS 일시 실패 시 빈값으로 덮지 않고 이 값을 유지한다 ──
let lastMeal = [];
let lastToday = [];
let lastWeek = {};
let lastBoard = null;   // 렌더러가 준비되기 전에 도착한 board를 잃지 않도록 캐시해 둔다

// ── 호출 상태 머신 ──
let alertedRows = new Set();  // 이번 실행 동안 이미 알림을 시작한 row (재알림 방지)
let current = null;           // 지금 화면에 보여주고 있는 호출 { row, ..., deadlineAt }
let autoDismissSec = 30;      // board 데이터로 갱신됨

function cfg() { return store.load(); }

// 창이 살아 있어도 webContents만 먼저 파괴되는 순간이 있다 — 종료 중이면 아예 건드리지 않는다.
function alive() {
  return !quitting && win && !win.isDestroyed()
      && win.webContents && !win.webContents.isDestroyed();
}

function stopAllTimers() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (boardTimer) { clearInterval(boardTimer); boardTimer = null; }
  if (mealTimer) { clearInterval(mealTimer); mealTimer = null; }
  if (mealRetryTimer) { clearTimeout(mealRetryTimer); mealRetryTimer = null; }
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
  const board = await api.getBoard(s.webAppUrl, s.grade, s.classNum);
  if (quitting) return;   // 응답을 기다리는 사이에 종료가 시작됐을 수 있다
  if (board.ok && board.data && typeof board.data.autoDismiss === 'number') {
    autoDismissSec = board.data.autoDismiss;
  }
  if (board.ok) lastBoard = board.data;
  if (board.ok && alive()) {
    win.webContents.send('yc:board', { board: board.data });
  }
}

// ── (B) 급식/시간표 갱신 — getMeal + getTimetable(today/week). 드물게(MEAL_REFRESH_MS) 돈다. ──
// 성공한 항목만 last-good으로 갱신하고, 실패한 항목은 직전값을 유지한다(NEIS 일시 실패 시 "없음"으로 깜빡이지 않게).
// 셋 중 하나라도 실패하면 30분을 기다리지 않고 MEAL_RETRY_MS 뒤 1회 더 시도한다(중복 예약 방지).
async function refreshMeal() {
  if (quitting) return;
  if (!store.isConfigured()) return;
  if (mealRetryTimer) { clearTimeout(mealRetryTimer); mealRetryTimer = null; }
  const s = cfg();
  const [meal, today, week] = await Promise.all([
    api.getMeal(s.webAppUrl),
    api.getTimetable(s.webAppUrl, s.grade, s.classNum, 'today'),
    api.getTimetable(s.webAppUrl, s.grade, s.classNum, 'week')
  ]);
  if (quitting) return;   // 응답을 기다리는 사이에 종료가 시작됐을 수 있다
  if (meal.ok) lastMeal = meal.data;   // 실패면 직전값 유지(빈값으로 덮지 않음)
  if (today.ok) lastToday = today.data;
  if (week.ok) lastWeek = week.data;
  if (alive()) {
    win.webContents.send('yc:board', {
      meal: lastMeal,
      todayTimetable: lastToday,
      weekTimetable: lastWeek
    });
  }
  if (!meal.ok || !today.ok || !week.ok) {
    if (mealRetryTimer) clearTimeout(mealRetryTimer);
    mealRetryTimer = setTimeout(refreshMeal, MEAL_RETRY_MS);
  }
}

// ── 호출 폴링 + 상태 머신 ──
// 웹 학생화면(index.html)의 checkStudent/showStudentAlert/startCountdown과 동일한 동작을
// 메인 프로세스 쪽 상태 머신으로 재구현한 것 — 렌더러가 숨겨져 있어도 정확히 돈다.
async function tick() {
  if (quitting) return;
  const s = cfg();
  if (!store.isConfigured()) return;

  // 현재 표시 중인 호출의 카운트다운이 끝났으면 확인 처리 후 다음으로 넘어간다
  if (current && Date.now() >= current.deadlineAt) {
    api.confirmCall(s.webAppUrl, current.row); // 결과를 기다릴 필요 없음(실패해도 다음 폴링이 재시도하지 않도록 이미 화면은 넘어감)
    current = null;
  }

  const res = await api.getCalls(s.webAppUrl, s.grade, s.classNum);
  if (quitting) return;   // 응답을 기다리는 사이에 종료가 시작됐을 수 있다
  if (!res.ok) return; // 네트워크 오류 — 다음 폴링에서 재시도, 화면 상태는 그대로 둔다

  const calls = res.data || [];
  const pending = calls.filter(c => !(current && current.row === c.row));

  if (!current) {
    const fresh = calls.find(c => !alertedRows.has(c.row));
    if (fresh) {
      alertedRows.add(fresh.row);
      current = Object.assign({}, fresh, { deadlineAt: Date.now() + autoDismissSec * 1000, totalSec: autoDismissSec });
      const queueCount = calls.filter(c => c.row !== fresh.row).length;
      if (alive()) win.webContents.send('yc:alert', { call: current, queueCount });

      if (s.autoRestoreOnCall) showAndFocus();
      else notifyNewCall(fresh);
      return;
    }
    if (calls.length === 0 && alive()) {
      win.webContents.send('yc:standby');
    }
    return;
  }

  // 이미 표시 중인 호출이 있으면 대기열 숫자만 갱신
  const queueCount = calls.filter(c => c.row !== current.row).length;
  if (alive()) win.webContents.send('yc:alert', { call: current, queueCount });
}

async function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (boardTimer) clearInterval(boardTimer);
  if (mealTimer) clearInterval(mealTimer);
  if (mealRetryTimer) { clearTimeout(mealRetryTimer); mealRetryTimer = null; }
  refreshMeal(); // 급식/시간표도 시작 즉시 1회 로드 — 설치 직후 30분 기다리지 않게
  await refreshBoard(); // autoDismissSec을 먼저 채워야 첫 알림부터 정확한 카운트다운을 쓴다
  await tick();
  pollTimer = setInterval(tick, POLL_MS);
  boardTimer = setInterval(refreshBoard, BOARD_REFRESH_MS);
  mealTimer = setInterval(refreshMeal, MEAL_REFRESH_MS);
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
    const next = store.save(patch);
    if (typeof patch.autoLaunch === 'boolean') applyAutoLaunch(patch.autoLaunch);
    refreshTrayMenu();
    startPolling(); // URL/반이 바뀌었을 수 있으니 즉시 재시작
    return next;
  });
  ipcMain.handle('yc:get-tts', (e, text) => api.getTts(cfg().webAppUrl, text));
  ipcMain.handle('yc:test-connection', async (e, { webAppUrl, grade, classNum }) => {
    // GAS가 한동안 안 쓰이다 깨어나는 순간엔 응답이 8초를 넘겨 정상 URL도 "연결 실패"로 뜨던 문제 —
    // 확인 단계만 30초 제한 + 최대 3회 재시도. 첫 시도가 서버를 깨워놔서 재시도는 대부분 바로 붙는다.
    let test = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      test = await api.getBoard(webAppUrl, grade, classNum, 30000);
      if (test.ok) break;
    }
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
  store.flushSync();
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
