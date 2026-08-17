// 유콜 데스크 렌더러 — 유콜 웹앱(index.html)의 학생(전자칠판) 화면 로직을 이식.
// 차이점: 서버 호출이 google.script.run 대신 window.yc.* (main 프로세스 IPC)를 쓰고,
// 호출 대기열/카운트다운/자동확인 상태 머신은 main.js가 갖고 있어 여기서는 순수 표시만 한다.
(function () {

var SETTINGS = null;
var PERIOD_CONFIG = { start: '08:50', periodLen: 45, breakLen: 10, lunchAfter: 4, lunchLen: 50, maxPeriod: 7 };
var SCHEDULE = [];
var audioCtx = null;

/* ===== 오디오 (원본 웹앱과 동일한 사운드 8종) ===== */
function getAC() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function getVol() { var el = document.getElementById('volSlider'); return el ? parseInt(el.value) / 12 : 0.4; }
function getTtsVol() { var el = document.getElementById('ttsVolSlider'); return el ? parseInt(el.value) / 10 : 1.0; }
function getRepeatCount() {
  var el = document.getElementById('repeatSelect'); if (!el) return 2;
  var v = parseInt(el.value); return (v >= 1 && v <= 3) ? v : 2;
}

function playSound(idx, v) {
  var ac = getAC();
  if (idx===0) { [[1046.5,0],[783.99,300]].forEach(function(p){setTimeout(function(){var o=ac.createOscillator(),g=ac.createGain();o.connect(g);g.connect(ac.destination);o.type='sine';o.frequency.value=p[0];g.gain.setValueAtTime(0,ac.currentTime);g.gain.linearRampToValueAtTime(v,ac.currentTime+0.01);g.gain.exponentialRampToValueAtTime(0.001,ac.currentTime+1.0);o.start();o.stop(ac.currentTime+1.0);},p[1]);}); }
  else if (idx===1) { [[880,0],[660,350]].forEach(function(p){setTimeout(function(){var o=ac.createOscillator(),g=ac.createGain();o.connect(g);g.connect(ac.destination);o.type='sine';o.frequency.value=p[0];g.gain.setValueAtTime(0,ac.currentTime);g.gain.linearRampToValueAtTime(v,ac.currentTime+0.01);g.gain.exponentialRampToValueAtTime(0.001,ac.currentTime+0.9);o.start();o.stop(ac.currentTime+0.9);},p[1]);}); }
  else if (idx===2) { [523.25,659.25,783.99].forEach(function(freq,i){setTimeout(function(){var o=ac.createOscillator(),g=ac.createGain();o.connect(g);g.connect(ac.destination);o.type='triangle';o.frequency.value=freq;g.gain.setValueAtTime(0,ac.currentTime);g.gain.linearRampToValueAtTime(v*0.85,ac.currentTime+0.01);g.gain.exponentialRampToValueAtTime(0.001,ac.currentTime+0.5);o.start();o.stop(ac.currentTime+0.5);},i*200);}); }
  else if (idx===3) { [0,200].forEach(function(d){setTimeout(function(){var o=ac.createOscillator(),g=ac.createGain();o.connect(g);g.connect(ac.destination);o.type='sine';o.frequency.setValueAtTime(900,ac.currentTime);o.frequency.exponentialRampToValueAtTime(300,ac.currentTime+0.07);g.gain.setValueAtTime(v*1.2,ac.currentTime);g.gain.exponentialRampToValueAtTime(0.001,ac.currentTime+0.09);o.start();o.stop(ac.currentTime+0.1);},d);}); }
  else if (idx===4) { [[1400,0],[1100,280]].forEach(function(p){setTimeout(function(){var o=ac.createOscillator(),g=ac.createGain();o.connect(g);g.connect(ac.destination);o.type='sine';o.frequency.setValueAtTime(p[0],ac.currentTime);o.frequency.exponentialRampToValueAtTime(p[0]*0.5,ac.currentTime+0.18);g.gain.setValueAtTime(v,ac.currentTime);g.gain.exponentialRampToValueAtTime(0.001,ac.currentTime+0.22);o.start();o.stop(ac.currentTime+0.25);},p[1]);}); }
  else if (idx===5) { [0,1.05,2.1].forEach(function(delay){var t=ac.currentTime+delay;[[830,1.0,1.2],[1245,0.5,0.9],[1660,0.28,0.7],[2075,0.14,0.5],[2490,0.07,0.35]].forEach(function(r){var o=ac.createOscillator(),g=ac.createGain();o.connect(g);g.connect(ac.destination);o.type='sine';o.frequency.value=r[0];g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(v*r[1],t+0.006);g.gain.exponentialRampToValueAtTime(0.001,t+r[2]);o.start(t);o.stop(t+r[2]+0.05);}); }); }
  else if (idx===6) { [[0,0.4],[0.6,0.4],[1.6,0.4],[2.2,0.4]].forEach(function(seg){var t=ac.currentTime+seg[0],dur=seg[1];[425,480].forEach(function(freq){var o=ac.createOscillator(),g=ac.createGain();o.connect(g);g.connect(ac.destination);o.type='sine';o.frequency.value=freq;g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(v*0.55,t+0.015);g.gain.setValueAtTime(v*0.55,t+dur-0.02);g.gain.linearRampToValueAtTime(0,t+dur);o.start(t);o.stop(t+dur+0.02);}); }); }
  else if (idx===7) { [0,0.75,1.40,1.95,2.40,2.75].forEach(function(s){var t=ac.currentTime+s;[880,1108].forEach(function(f){var o=ac.createOscillator(),g=ac.createGain();o.connect(g);g.connect(ac.destination);o.type='square';o.frequency.value=f;g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(v*0.38,t+0.012);g.gain.setValueAtTime(v*0.38,t+0.27);g.gain.linearRampToValueAtTime(0,t+0.30);o.start(t);o.stop(t+0.32);}); }); }
}

/* ===== TTS — window.yc.getTts(text)가 {ok,data:{audio:base64}}를 돌려준다 ===== */
var _ttsSource = null, _ttsToken = 0;
function setTtsStatus(msg) { var el = document.getElementById('ttsStatus'); if (el) el.textContent = msg; }
function _stopCurrentTts() { if (_ttsSource) { try { _ttsSource.onended = null; _ttsSource.stop(); } catch (e) {} _ttsSource = null; } }

function speakAsync(text, myToken) {
  return new Promise(function (resolve) {
    setTtsStatus('🔄 음성 준비 중...');
    window.yc.getTts(text).then(function (res) {
      if (myToken !== _ttsToken) { resolve(); return; }
      if (!res.ok || !res.data || !res.data.audio) { setTtsStatus('⚠️ 음성 준비 실패'); resolve(); return; }
      try {
        var b64 = res.data.audio;
        var binary = atob(b64), buf = new ArrayBuffer(binary.length), view = new Uint8Array(buf);
        for (var i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);

        var ac = getAC();
        if (ac.state === 'suspended') ac.resume();

        ac.decodeAudioData(buf, function (audioBuffer) {
          if (myToken !== _ttsToken) { resolve(); return; }
          _stopCurrentTts();
          var source = ac.createBufferSource(), gain = ac.createGain();
          gain.gain.value = getTtsVol();
          source.buffer = audioBuffer;
          source.connect(gain); gain.connect(ac.destination);
          source.onended = function () { if (myToken === _ttsToken) setTtsStatus('✅ 준비됨'); _ttsSource = null; resolve(); };
          _ttsSource = source;
          setTtsStatus('🗣️ 말하는 중...');
          try { source.start(0); } catch (e) { resolve(); }
        }, function () { setTtsStatus('⚠️ 디코딩 오류'); resolve(); });
      } catch (e) { setTtsStatus('⚠️ 오류: ' + e.message); resolve(); }
    }).catch(function () { setTtsStatus('⚠️ 통신 오류'); resolve(); });
  });
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function playAlertNTimes(text, count) {
  _ttsToken++;
  var myToken = _ttsToken;
  (async function () {
    for (var i = 0; i < count; i++) {
      if (myToken !== _ttsToken) return;
      playSound(parseInt(document.getElementById('soundSelect').value) || 0, getVol());
      await wait(600);
      if (myToken !== _ttsToken) return;
      await speakAsync(text, myToken);
      if (myToken !== _ttsToken) return;
      if (i < count - 1) await wait(500);
    }
  })();
}
function ttsTest() { getAC(); _ttsToken++; speakAsync('음성 테스트입니다 잘 들리시나요', _ttsToken); }

/* ===== 설정 저장/적용 — localStorage 대신 main 프로세스 store 사용 ===== */
function savePref() {
  var ss = document.getElementById('soundSelect'), vs = document.getElementById('volSlider');
  var tv = document.getElementById('ttsVolSlider'), rp = document.getElementById('repeatSelect');
  window.yc.saveSettings({
    soundIndex: ss ? parseInt(ss.value) : 0,
    volume: vs ? parseInt(vs.value) : 5,
    ttsVolume: tv ? parseInt(tv.value) : 10,
    repeatCount: rp ? parseInt(rp.value) : 2
  });
}
function applyPrefsToUI(s) {
  var ss = document.getElementById('soundSelect'), vs = document.getElementById('volSlider'), vv = document.getElementById('vval');
  var tvs = document.getElementById('ttsVolSlider'), tvv = document.getElementById('tvval'), rps = document.getElementById('repeatSelect');
  if (ss) ss.value = s.soundIndex;
  if (vs) { vs.value = s.volume; if (vv) vv.textContent = s.volume; }
  if (tvs) { tvs.value = s.ttsVolume; if (tvv) tvv.textContent = s.ttsVolume; }
  if (rps) rps.value = s.repeatCount;
}

/* ===== 시정 계산 (원본과 동일) ===== */
function toMinutes(hhmm) { var p = String(hhmm).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); }
function buildSchedule(cfg) {
  var t = toMinutes(cfg.start), slots = [];
  for (var n = 1; n <= cfg.maxPeriod; n++) {
    var s = t, e = t + cfg.periodLen;
    slots.push({ type: 'period', period: n, start: s, end: e });
    t = e + cfg.breakLen;
    if (n === cfg.lunchAfter) { var ls = t, le = t + cfg.lunchLen; slots.push({ type: 'lunch', start: ls, end: le }); t = le; }
  }
  return slots;
}
function currentPeriodStatus(nowMin) {
  for (var i = 0; i < SCHEDULE.length; i++) {
    var s = SCHEDULE[i];
    if (nowMin >= s.start && nowMin < s.end) {
      return s.type === 'lunch' ? { label: '점심시간', period: null, lunch: true, off: false }
                                 : { label: s.period + '교시 수업중', period: s.period, lunch: false, off: false };
    }
  }
  for (var i2 = 0; i2 < SCHEDULE.length - 1; i2++) {
    if (nowMin >= SCHEDULE[i2].end && nowMin < SCHEDULE[i2 + 1].start) return { label: '쉬는시간', period: null, lunch: false, off: true };
  }
  if (SCHEDULE.length && nowMin < SCHEDULE[0].start) return { label: '등교 전', period: null, lunch: false, off: true };
  return { label: '방과후', period: null, lunch: false, off: true };
}

var _todaySubjects = {};
function renderNotice(notice) {
  var bar = document.getElementById('noticeBar'), txt = document.getElementById('noticeText');
  if (!bar || !txt) return;
  if (notice && notice.trim()) { txt.textContent = notice; bar.classList.add('show'); } else { bar.classList.remove('show'); }
}
function renderClassMemo(memo) {
  var el = document.getElementById('classMemoText'); if (!el) return;
  if (memo && memo.trim()) { el.textContent = memo; el.classList.remove('empty'); }
  else { el.textContent = '설정 시트 "학급 메모"에 문구를 입력하면 여기에 표시됩니다.'; el.classList.add('empty'); }
}
function renderAgenda(agenda) {
  var el = document.getElementById('agendaList'); if (!el) return;
  if (!agenda || !agenda.length) { el.innerHTML = '<div class="agenda-empty">예정된 일정이 없습니다</div>'; return; }
  el.innerHTML = '';
  agenda.forEach(function (a) {
    var row = document.createElement('div'); row.className = 'agenda-item';
    var at = document.createElement('div'); at.className = 'at'; at.textContent = a.title;
    var ad = document.createElement('div'); ad.className = 'ad'; ad.textContent = a.dday === 0 ? 'D-DAY' : ('D-' + a.dday);
    row.appendChild(at); row.appendChild(ad); el.appendChild(row);
  });
}
function renderMeal(meals) {
  var el = document.getElementById('mealList'); if (!el) return;
  if (!meals || !meals.length) { el.innerHTML = '<div class="meal-empty">오늘은 급식이 없어요</div>'; return; }
  el.innerHTML = '';
  el.className = (meals.length > 1) ? 'multi' : '';
  var typeIcon = { '조식': '🌅', '중식': '🍚', '석식': '🌙' };
  meals.forEach(function (m) {
    var wrap = document.createElement('div'); wrap.className = 'meal-slot';
    if (String(m.type).indexOf('석') === 0) wrap.className += ' dinner';
    var mh = document.createElement('div'); mh.className = 'mh';
    var mt = document.createElement('div'); mt.className = 'mt'; mt.textContent = (typeIcon[m.type] || '🍽️') + ' ' + m.type;
    mh.appendChild(mt);
    if (m.kcal) { var mk = document.createElement('div'); mk.className = 'mk'; mk.textContent = m.kcal + 'kcal'; mh.appendChild(mk); }
    var mm = document.createElement('div'); mm.className = 'mm'; mm.innerHTML = (m.dishes || []).join('<br>');
    wrap.appendChild(mh); wrap.appendChild(mm);
    if (m.allergy && m.allergy.length) {
      var ma = document.createElement('div'); ma.className = 'ma'; ma.textContent = '알레르기: ' + m.allergy.join(', ') + '번';
      wrap.appendChild(ma);
    }
    el.appendChild(wrap);
  });
  fitMealBox();
  // 웹폰트가 늦게 적용되면 첫 측정이 실제보다 작게 나와 배율이 덜 낮아진다 — 폰트 준비 후 다시 맞춘다
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fitMealBox(); });
}
/* 급식이 박스를 넘치면 글자 배율(--ms)을 단계적으로 낮춰 스크롤 없이 다 보이게 맞춘다.
   중식+석식이 함께 있는 고등학교에서 석식이 아래로 잘리던 문제. */
function fitMealBox() {
  var el = document.getElementById('mealList'); if (!el) return;
  var steps = [1, .94, .88, .82, .76, .7, .66, .62];
  el.classList.remove('compact');
  el.style.overflowY = 'hidden';
  for (var i = 0; i < steps.length; i++) {
    el.style.setProperty('--ms', String(steps[i]));
    if (el.scrollHeight <= el.clientHeight + 1) return;
  }
  el.classList.add('compact');
  for (var j = 0; j < steps.length; j++) {
    el.style.setProperty('--ms', String(steps[j]));
    if (el.scrollHeight <= el.clientHeight + 1) return;
  }
  el.style.overflowY = 'auto';
}
var _fitTimer = null;
window.addEventListener('resize', function () {
  clearTimeout(_fitTimer);
  _fitTimer = setTimeout(fitMealBox, 200);
});
function renderPeriodRow(list) {
  _todaySubjects = {};
  (list || []).forEach(function (x) { _todaySubjects[x.period] = x.subject; });
  var row = document.getElementById('periodRow'); if (!row) return;
  if (!list || !list.length) { row.innerHTML = '<div class="today-empty">오늘은 수업이 없어요</div>'; return; }
  row.innerHTML = '';
  SCHEDULE.forEach(function (s) {
    var el = document.createElement('div');
    if (s.type === 'lunch') { el.className = 'period lunch'; el.id = 'p-lunch'; el.innerHTML = '<div class="pn">점심</div><div class="ps">🍚 급식</div>'; }
    else { el.className = 'period'; el.id = 'p-' + s.period; el.innerHTML = '<div class="pn">' + s.period + '교시</div><div class="ps">' + (_todaySubjects[s.period] || '-') + '</div>'; }
    row.appendChild(el);
  });
}
function renderWeek(weekMap) {
  var wrap = document.getElementById('weekWrap'); if (!wrap) return;
  weekMap = weekMap || {};
  var keys = Object.keys(weekMap);
  if (!keys.length) { wrap.innerHTML = '<div class="week-empty">시간표 정보가 없어요</div>'; return; }
  var days = ['월', '화', '수', '목', '금'];
  var now = new Date(); var dow = now.getDay(); var mon = new Date(now); mon.setDate(now.getDate() - ((dow + 6) % 7));
  var dayKeys = []; for (var i = 0; i < 5; i++) { var d = new Date(mon); d.setDate(mon.getDate() + i); dayKeys.push(ymdKey(d)); }
  var todayKey = ymdKey(now);
  var maxP = PERIOD_CONFIG.maxPeriod || 7;
  var html = '<table class="week"><thead><tr><th class="pnum"></th>';
  days.forEach(function (d, i) { html += '<th' + (dayKeys[i] === todayKey ? ' class="today"' : '') + '>' + d + '</th>'; });
  html += '</tr></thead><tbody>';
  for (var p = 1; p <= maxP; p++) {
    html += '<tr><td class="pnum">' + p + '</td>';
    dayKeys.forEach(function (k) {
      var subj = '-'; var day = weekMap[k] || [];
      for (var j = 0; j < day.length; j++) { if (day[j].period === p) { subj = day[j].subject || '-'; break; } }
      html += '<td' + (k === todayKey ? ' class="today-col"' : '') + '>' + subj + '</td>';
    });
    html += '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
}
function ymdKey(d) { return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }

function startClock() {
  function tick() {
    var now = new Date();
    var hh = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    var clockEl = document.getElementById('sClock'); if (clockEl) clockEl.textContent = hh;
    var dateEl = document.getElementById('sDate');
    if (dateEl) dateEl.textContent = (now.getMonth() + 1) + '월 ' + now.getDate() + '일 (' + ['일', '월', '화', '수', '목', '금', '토'][now.getDay()] + ')';
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var st = currentPeriodStatus(nowMin);
    var chip = document.getElementById('statusChip');
    if (chip) { chip.textContent = st.label; chip.className = 'status' + (st.lunch ? ' lunch' : '') + (st.off ? ' off' : ''); }
    document.querySelectorAll('.period').forEach(function (p) { p.classList.remove('now'); });
    if (st.period) { var pel = document.getElementById('p-' + st.period); if (pel) pel.classList.add('now'); }
    if (st.lunch) { var lel = document.getElementById('p-lunch'); if (lel) lel.classList.add('now'); }
  }
  tick(); setInterval(tick, 1000);
}

/* ===== 호출 알림 표시 — 상태 판단은 main.js가 하고, 여기는 그리기만 ===== */
var _alertTicker = null, _lastAlertRow = null;

function showStandby() {
  document.getElementById('sStandby').style.display = SETTINGS.showStandby ? 'flex' : 'none';
  document.getElementById('sAlert').style.display = 'none';
  if (_alertTicker) { clearInterval(_alertTicker); _alertTicker = null; }
  _lastAlertRow = null;
}

function showAlert(payload) {
  var call = payload.call, queueCount = payload.queueCount || 0;
  document.getElementById('sStandby').style.display = 'none';
  document.getElementById('sAlert').style.display = 'flex';
  document.getElementById('sNum').textContent = call.num + '번';
  document.getElementById('sName').textContent = call.name;

  var msgEl = document.getElementById('sMsg');
  if (call.message && call.message.trim()) { msgEl.textContent = call.message; msgEl.style.display = ''; } else { msgEl.style.display = 'none'; }
  var teacherEl = document.getElementById('sTeacher');
  if (call.teacher && call.teacher.trim()) { teacherEl.textContent = '🍀 ' + call.teacher + ' 선생님'; teacherEl.style.display = ''; } else { teacherEl.style.display = 'none'; }
  var locEl = document.getElementById('sLocation');
  if (call.location && call.location.trim()) { locEl.textContent = '📍 ' + call.location + '로 오세요'; locEl.style.display = ''; } else { locEl.style.display = 'none'; }
  var qEl = document.getElementById('sQueue');
  if (queueCount > 0) { qEl.textContent = '+ 대기 ' + queueCount + '건 더 있음'; qEl.style.display = ''; } else { qEl.style.display = 'none'; }

  // 새 호출이면(직전에 보여주던 것과 다른 row) 소리+음성 재생을 시작한다
  if (_lastAlertRow !== call.row) {
    _lastAlertRow = call.row;
    playAlertNTimes(call.name + ' 학생 교무실로 오세요', getRepeatCount());
  }

  // 카운트다운 표시는 순수 화면용 — 실제 확인 처리는 main.js가 deadlineAt 기준으로 한다
  if (_alertTicker) clearInterval(_alertTicker);
  var totalSec = call.totalSec || 30;
  function updateBar() {
    var remain = Math.max(0, Math.round((call.deadlineAt - Date.now()) / 1000));
    var cd = document.getElementById('sCountdown'), bar = document.getElementById('sBar');
    if (cd) cd.textContent = remain + '초 후 자동 닫힘';
    if (bar) bar.style.width = Math.max(0, (remain / totalSec * 100)) + '%';
  }
  updateBar();
  _alertTicker = setInterval(updateBar, 1000);
}

/* ===== 설정 화면 ===== */
function openCfgModal() {
  var s = SETTINGS || {};
  document.getElementById('cfgUrl').value = s.webAppUrl || '';
  document.getElementById('cfgGrade').value = s.grade || '';
  document.getElementById('cfgClass').value = s.classNum || '';
  document.getElementById('cfgShowStandby').checked = s.showStandby !== false;
  document.getElementById('cfgAutoRestore').checked = s.autoRestoreOnCall !== false;
  document.getElementById('cfgAutoLaunch').checked = s.autoLaunch !== false;
  document.getElementById('cfgStatus').textContent = '';
  document.getElementById('cfgModal').classList.add('show');
}
function wireCfgModal() {
  document.getElementById('openCfgBtn').addEventListener('click', openCfgModal);
  document.getElementById('cfgSaveBtn').addEventListener('click', async function () {
    var url = document.getElementById('cfgUrl').value.trim();
    var grade = document.getElementById('cfgGrade').value.trim();
    var classNum = document.getElementById('cfgClass').value.trim();
    var statusEl = document.getElementById('cfgStatus');
    if (!url || !grade || !classNum) { statusEl.textContent = 'URL·학년·반을 모두 입력하세요.'; statusEl.className = 'cfg-status err'; return; }

    statusEl.textContent = '연결 확인 중...'; statusEl.className = 'cfg-status';
    var test = await window.yc.testConnection(url, grade, classNum);
    if (!test.ok) {
      statusEl.textContent = '연결 실패: ' + test.error + ' (URL을 다시 확인하세요)';
      statusEl.className = 'cfg-status err';
      return;
    }

    await window.yc.saveSettings({
      webAppUrl: url, grade: grade, classNum: classNum,
      showStandby: document.getElementById('cfgShowStandby').checked,
      autoRestoreOnCall: document.getElementById('cfgAutoRestore').checked,
      autoLaunch: document.getElementById('cfgAutoLaunch').checked
    });
    statusEl.textContent = '저장 완료! 시작합니다...';
    statusEl.className = 'cfg-status ok';
    setTimeout(function () { location.reload(); }, 600);
  });
}

/* ===== 초기화 ===== */
window.addEventListener('DOMContentLoaded', async function () {
  wireCfgModal();

  SETTINGS = await window.yc.getSettings();
  applyPrefsToUI(SETTINGS);

  var configured = !!(SETTINGS.webAppUrl && SETTINGS.grade && SETTINGS.classNum);
  if (!configured) { openCfgModal(); return; }

  document.getElementById('sBadge').textContent = SETTINGS.grade + '학년 ' + SETTINGS.classNum + '반';
  SCHEDULE = buildSchedule(PERIOD_CONFIG); // board 데이터 오기 전 기본값으로 시작, 도착하면 갱신
  startClock();
  showStandby();

  ['touchstart', 'mousedown', 'keydown'].forEach(function (ev) {
    document.addEventListener(ev, function h() {
      try { var ac = getAC(), buf = ac.createBuffer(1, 1, 22050), src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination); src.start(0); } catch (e) {}
      document.removeEventListener(ev, h);
    }, { once: true, capture: true });
  });

  // 공지 경로는 {board}만, 급식/시간표 경로는 {meal,todayTimetable,weekTimetable}만 나눠 보낸다.
  // 받은 필드만 다시 그리고, 안 온(undefined) 필드는 기존 화면을 그대로 둔다.
  // (빈 배열/빈 객체로 온 경우의 "없음" 표시는 각 render 함수가 유지 — undefined와는 구분된다.)
  window.yc.onBoard(function (data) {
    if (data.board) {
      document.documentElement.setAttribute('data-theme', String(data.board.theme || 1));
      document.getElementById('sBadge').textContent = (data.board.schoolName ? data.board.schoolName + ' ' : '') + SETTINGS.grade + '학년 ' + SETTINGS.classNum + '반';
      renderNotice(data.board.notice);
      renderClassMemo(data.board.classMemo);
      renderAgenda(data.board.agenda);
      if (data.board.periodConfig) { PERIOD_CONFIG = data.board.periodConfig; SCHEDULE = buildSchedule(PERIOD_CONFIG); }
    }
    if (data.meal !== undefined) renderMeal(data.meal);
    if (data.todayTimetable !== undefined) renderPeriodRow(data.todayTimetable);
    if (data.weekTimetable !== undefined) renderWeek(data.weekTimetable);
  });

  // 리스너를 단 직후, 이미 받아둔 값이 있으면 즉시 그린다(첫 폴링 결과 유실 방지 — main의 캐시를 당겨온다)
  if (window.yc.getSnapshot) {
    try {
      var snap = await window.yc.getSnapshot();
      if (snap) {
        if (snap.board) {
          document.documentElement.setAttribute('data-theme', String(snap.board.theme || 1));
          document.getElementById('sBadge').textContent = (snap.board.schoolName ? snap.board.schoolName + ' ' : '') + SETTINGS.grade + '학년 ' + SETTINGS.classNum + '반';
          renderNotice(snap.board.notice);
          renderClassMemo(snap.board.classMemo);
          renderAgenda(snap.board.agenda);
          if (snap.board.periodConfig) { PERIOD_CONFIG = snap.board.periodConfig; SCHEDULE = buildSchedule(PERIOD_CONFIG); }
        }
        if (snap.meal && snap.meal.length) renderMeal(snap.meal);
        if (snap.todayTimetable && snap.todayTimetable.length) renderPeriodRow(snap.todayTimetable);
        if (snap.weekTimetable && Object.keys(snap.weekTimetable).length) renderWeek(snap.weekTimetable);
      }
    } catch (e) { /* 스냅샷이 없으면 다음 폴링을 기다린다 */ }
  }

  window.yc.onAlert(showAlert);
  window.yc.onStandby(showStandby);
  window.yc.onSettings(function (s) {
    SETTINGS = s;
    document.getElementById('sStandby').style.display = (s.showStandby && !document.getElementById('sAlert').style.display.match('flex')) ? 'flex' : document.getElementById('sStandby').style.display;
    if (document.getElementById('sAlert').style.display !== 'flex') {
      document.getElementById('sStandby').style.display = s.showStandby ? 'flex' : 'none';
    }
  });

  document.getElementById('liveDot').classList.remove('off');

  // 전역 노출 (index.html의 inline onclick / --smoke 검증에서 사용)
  window.YC = { savePref: savePref, playSound: playSound, getVol: getVol, ttsTest: ttsTest };
  window.openCfgModal = openCfgModal;
  window.showAlert = showAlert;
  window.showStandby = showStandby;
});

})();
