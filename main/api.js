// GAS 웹앱의 ?api= JSON 엔드포인트를 호출하는 얇은 래퍼.
// Electron 메인 프로세스에서 실행되므로 CORS 제약이 없다 — 브라우저를 거치지 않는다.
// 실패해도 절대 throw 하지 않는다(폴링 루프가 죽으면 안 되므로) — 항상 { ok, ... } 형태로 반환.

// 교사용 주소(?role=teacher&k=<비밀키>)를 설정에 그대로 붙여 넣으면 k가 store.json에 평문으로 남고
// 3초마다 모든 요청에 실려 나갔다. 칠판은 학생 화면만 쓰므로 role·k와 #해시는 늘 버린다.
const STRIP_PARAMS = ['role', 'k'];
const DEFAULT_TIMEOUT_MS = 8000;
// 음성 합성(타입캐스트·구글 번역)은 서버가 외부 API를 한 번 더 부르므로 8초로는 자주 잘렸다 — tts만 넉넉히
const TTS_TIMEOUT_MS = 15000;

function stripBase(u) {
  STRIP_PARAMS.forEach(p => u.searchParams.delete(p));
  u.hash = '';
  return u;
}

function buildUrl(base, params) {
  const u = stripBase(new URL(String(base).trim()));
  Object.keys(params || {}).forEach(k => {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') u.searchParams.set(k, params[k]);
  });
  return u.toString();
}

// 저장용 주소 — role·k·해시를 뗀 모양. 주소로 읽히지 않는 글자는 앞뒤 공백만 걷어 그대로 돌려준다
// (연결 확인에서 어차피 실패하고, 사용자가 무엇을 넣었는지는 설정 화면에 남아야 한다).
function cleanWebAppUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  try { return stripBase(new URL(s)).toString(); } catch (e) { return s; }
}

async function callApi(webAppUrl, api, params, timeoutMs) {
  if (!webAppUrl) return { ok: false, error: 'webAppUrl 미설정' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const url = buildUrl(webAppUrl, Object.assign({ api }, params));
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

const getCalls = (webAppUrl, grade, classNum, timeoutMs) => callApi(webAppUrl, 'calls', { grade, classNum }, timeoutMs);
// 서버 v4.24는 학년·반이 오면 그 행이 이 반 호출일 때만 확인한다(없으면 반 검사를 건너뛰는 옛 동작)
const confirmCall = (webAppUrl, row, grade, classNum) => callApi(webAppUrl, 'confirm', { row, grade, classNum });
const getMeal = (webAppUrl) => callApi(webAppUrl, 'meal', {});
const getTimetable = (webAppUrl, grade, classNum, scope) => callApi(webAppUrl, 'timetable', { grade, classNum, scope });
const getBoard = (webAppUrl, grade, classNum, timeoutMs) => callApi(webAppUrl, 'board', { grade, classNum }, timeoutMs);
const getTts = (webAppUrl, text) => callApi(webAppUrl, 'tts', { text }, TTS_TIMEOUT_MS);

module.exports = { getCalls, confirmCall, getMeal, getTimetable, getBoard, getTts, cleanWebAppUrl };
