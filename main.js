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

const POLL_MS = 2000;          // 호출 감지 주기 — 웹 학생화면과 동일(index.html의 setInterval(checkStudent,2000))
const BOARD_REFRESH_MS = 3 * 60 * 1000; // 대기화면 데이터(급식/시간표/공지 등) 재조회 주기 — 서버가 6시간 캐시라 부담 없음

let win = null;
let tray = null;
let quitting = false;
let pollTimer = null;
let boardTimer = null;

// ── 호출 상태 머신 ──
let alertedRows = new Set();  // 이번 실행 동안 이미 알림을 시작한 row (재알림 방지)
let current = null;           // 지금 화면에 보여주고 있는 호출 { row, ..., deadlineAt }
let autoDismissSec = 30;      // board 데이터로 갱신됨

function cfg() { return store.load(); }

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
  if (!win) return;
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
  if (win && !win.isDestroyed()) win.webContents.send('yc:settings', cfg());
}

// ── 대기화면 데이터(급식/시간표/공지 등) 주기 갱신 ──
async function refreshBoard() {
  const s = cfg();
  if (!store.isConfigured()) return;
  const [board, meal, today, week] = await Promise.all([
    api.getBoard(s.webAppUrl, s.grade, s.classNum),
    api.getMeal(s.webAppUrl),
    api.getTimetable(s.webAppUrl, s.grade, s.classNum, 'today'),
    api.getTimetable(s.webAppUrl, s.grade, s.classNum, 'week')
  ]);
  if (board.ok && board.data && typeof board.data.autoDismiss === 'number') {
    autoDismissSec = board.data.autoDismiss;
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('yc:board', {
      board: board.ok ? board.data : null,
      meal: meal.ok ? meal.data : [],
      todayTimetable: today.ok ? today.data : [],
      weekTimetable: week.ok ? week.data : {}
    });
  }
}

// ── 호출 폴링 + 상태 머신 ──
// 웹 학생화면(index.html)의 checkStudent/showStudentAlert/startCountdown과 동일한 동작을
// 메인 프로세스 쪽 상태 머신으로 재구현한 것 — 렌더러가 숨겨져 있어도 정확히 돈다.
async function tick() {
  const s = cfg();
  if (!store.isConfigured()) return;

  // 현재 표시 중인 호출의 카운트다운이 끝났으면 확인 처리 후 다음으로 넘어간다
  if (current && Date.now() >= current.deadlineAt) {
    api.confirmCall(s.webAppUrl, current.row); // 결과를 기다릴 필요 없음(실패해도 다음 폴링이 재시도하지 않도록 이미 화면은 넘어감)
    current = null;
  }

  const res = await api.getCalls(s.webAppUrl, s.grade, s.classNum);
  if (!res.ok) return; // 네트워크 오류 — 다음 폴링에서 재시도, 화면 상태는 그대로 둔다

  const calls = res.data || [];
  const pending = calls.filter(c => !(current && current.row === c.row));

  if (!current) {
    const fresh = calls.find(c => !alertedRows.has(c.row));
    if (fresh) {
      alertedRows.add(fresh.row);
      current = Object.assign({}, fresh, { deadlineAt: Date.now() + autoDismissSec * 1000, totalSec: autoDismissSec });
      const queueCount = calls.filter(c => c.row !== fresh.row).length;
      if (win && !win.isDestroyed()) win.webContents.send('yc:alert', { call: current, queueCount });

      if (s.autoRestoreOnCall) showAndFocus();
      else notifyNewCall(fresh);
      return;
    }
    if (calls.length === 0 && win && !win.isDestroyed()) {
      win.webContents.send('yc:standby');
    }
    return;
  }

  // 이미 표시 중인 호출이 있으면 대기열 숫자만 갱신
  const queueCount = calls.filter(c => c.row !== current.row).length;
  if (win && !win.isDestroyed()) win.webContents.send('yc:alert', { call: current, queueCount });
}

async function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (boardTimer) clearInterval(boardTimer);
  await refreshBoard(); // autoDismissSec을 먼저 채워야 첫 알림부터 정확한 카운트다운을 쓴다
  await tick();
  pollTimer = setInterval(tick, POLL_MS);
  boardTimer = setInterval(refreshBoard, BOARD_REFRESH_MS);
}

// ── IPC ──
function registerIpc() {
  ipcMain.handle('yc:get-settings', () => cfg());
  ipcMain.handle('yc:save-settings', (e, patch) => {
    const next = store.save(patch);
    if (typeof patch.autoLaunch === 'boolean') applyAutoLaunch(patch.autoLaunch);
    refreshTrayMenu();
    startPolling(); // URL/반이 바뀌었을 수 있으니 즉시 재시작
    return next;
  });
  ipcMain.handle('yc:get-tts', (e, text) => api.getTts(cfg().webAppUrl, text));
  ipcMain.handle('yc:test-connection', async (e, { webAppUrl, grade, classNum }) => {
    return api.getBoard(webAppUrl, grade, classNum);
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
  if (SMOKE) { runSmoke(); return; }
  registerIpc();
  createWindow();
  createTray();
  applyAutoLaunch(cfg().autoLaunch);
  startPolling();
});

app.on('window-all-closed', e => { if (SMOKE) app.quit(); else e.preventDefault(); }); // 트레이 상주 — 창이 닫혀도 앱은 유지

app.on('before-quit', () => {
  quitting = true;
  if (pollTimer) clearInterval(pollTimer);
  if (boardTimer) clearInterval(boardTimer);
  store.flushSync();
});
