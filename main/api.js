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

// 서버에 묻는 길 — 크롬과 같은 네트워크(Electron net.fetch)를 쓴다.
// 예전엔 Node 내장 fetch를 썼는데, 그건 윈도우에 깔린 인증서(교육청 SSL 검사 장비)·프록시 설정을 보지 않아
// 같은 PC에서 크롬(웹 칠판)은 되는데 유콜 데스크만 «fetch failed»로 연결에 실패하는 학교가 있었다(2026-09-28 제보).
// Electron이 아닌 곳(검사 vm)에서는 전역 fetch로 물러난다.
function doFetch(url, opts) {
  try {
    const net = require('electron').net;
    if (net && typeof net.fetch === 'function') return net.fetch(url, opts);
  } catch (e) { /* Electron 밖 — 아래 전역 fetch */ }
  return fetch(url, opts);
}

// 실패 문구 — «fetch failed»처럼 원인이 가려진 말 대신 무엇이 막혔는지 알 수 있게 한다
function describeError(e) {
  const msg = (e && e.message) || String(e);
  const code = (e && e.cause && (e.cause.code || e.cause.message)) || '';
  const all = msg + ' ' + code;
  let hint = '';
  if (/CERT|SSL|certificate|self.signed|issuer/i.test(all)) hint = '보안 인증서 문제 — 학교망 인증서를 확인하세요';
  else if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(all)) hint = '서버 주소를 찾지 못함 — 인터넷·DNS를 확인하세요';
  else if (/PROXY|TUNNEL/i.test(all)) hint = '프록시 연결 문제';
  else if (/INTERNET_DISCONNECTED|NETWORK_CHANGED|ENETUNREACH/i.test(all)) hint = '인터넷 연결이 끊김';
  else if (/abort/i.test(all)) hint = '응답 시간 초과';
  const detail = code && msg.indexOf(code) < 0 ? msg + ' (' + code + ')' : msg;
  return hint ? hint + ' · ' + detail : detail;
}

async function callApi(webAppUrl, api, params, timeoutMs) {
  if (!webAppUrl) return { ok: false, error: 'webAppUrl 미설정' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const url = buildUrl(webAppUrl, Object.assign({ api }, params));
    const res = await doFetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: describeError(e) };
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
