// GAS 웹앱의 ?api= JSON 엔드포인트를 호출하는 얇은 래퍼.
// Electron 메인 프로세스에서 실행되므로 CORS 제약이 없다 — 브라우저를 거치지 않는다.
// 실패해도 절대 throw 하지 않는다(폴링 루프가 죽으면 안 되므로) — 항상 { ok, ... } 형태로 반환.

function buildUrl(base, params) {
  const u = new URL(base);
  Object.keys(params || {}).forEach(k => {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') u.searchParams.set(k, params[k]);
  });
  return u.toString();
}

async function callApi(webAppUrl, api, params, timeoutMs) {
  if (!webAppUrl) return { ok: false, error: 'webAppUrl 미설정' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 8000);
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

const getCalls = (webAppUrl, grade, classNum) => callApi(webAppUrl, 'calls', { grade, classNum });
const confirmCall = (webAppUrl, row) => callApi(webAppUrl, 'confirm', { row });
const getMeal = (webAppUrl) => callApi(webAppUrl, 'meal', {});
const getTimetable = (webAppUrl, grade, classNum, scope) => callApi(webAppUrl, 'timetable', { grade, classNum, scope });
const getBoard = (webAppUrl, grade, classNum) => callApi(webAppUrl, 'board', { grade, classNum });
const getTts = (webAppUrl, text) => callApi(webAppUrl, 'tts', { text });

module.exports = { getCalls, confirmCall, getMeal, getTimetable, getBoard, getTts };
