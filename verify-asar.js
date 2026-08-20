// 빌드된 app.asar 안의 파일이 소스와 바이트 단위로 같은지 대조한다.
// 사용: node verify-asar.js
//
// ⚠ 두 번 사고를 낸 지점이라 방식을 고정해 둔다:
//   1) asar extract-file 은 "현재 폴더에 basename 으로" 파일을 쓴다.
//      앱 루트에서 돌리면 main.js·preload.js 원본을 덮어쓴다 → 반드시 임시 폴더에서 실행한다.
//   2) 아카이브 안의 경로 구분자는 백슬래시다(`renderer\js\app.js`).
//      슬래시로 조회하면 "was not found"가 떠서 패키징 실패로 오해하기 쉽다.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = __dirname;
const ASAR = path.join(APP_DIR, 'dist', 'win-unpacked', 'resources', 'app.asar');
// .cmd는 node에서 직접 spawn하면 EINVAL이 난다 — asar의 js 진입점을 node로 실행한다
const ASAR_JS = path.join(APP_DIR, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');

const TARGETS = ['main.js', 'preload.js', 'renderer/index.html', 'renderer/js/app.js', 'renderer/style.css', 'main/api.js', 'main/store.js'];

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

if (!fs.existsSync(ASAR)) { console.log('❌ 빌드 산출물이 없다: ' + ASAR); process.exit(1); }

// 원본을 절대 건드리지 않도록 임시 폴더에서 추출한다
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-asar-'));
let fail = 0;
try {
  const list = execFileSync(process.execPath, [ASAR_JS, 'list', ASAR], { encoding: 'utf8' });
  TARGETS.forEach(rel => {
    const src = path.join(APP_DIR, rel);
    if (!fs.existsSync(src)) { console.log(`❌ 소스 없음: ${rel}`); fail++; return; }
    const inArchive = '\\' + rel.split('/').join('\\');
    if (list.indexOf(inArchive) === -1) { console.log(`❌ asar에 없음: ${rel} (build.files 누락?)`); fail++; return; }
    execFileSync(process.execPath, [ASAR_JS, 'extract-file', ASAR, rel.split('/').join('\\')], { cwd: tmp });
    const got = fs.readFileSync(path.join(tmp, path.basename(rel)));
    const want = fs.readFileSync(src);
    if (sha(got) === sha(want)) console.log(`✅ ${rel}`);
    else { console.log(`❌ ${rel} 내용 다름 (asar ${sha(got)} vs 소스 ${sha(want)})`); fail++; }
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fail ? `❌ ${fail}건 불일치` : `✅ ${TARGETS.length}개 파일 전부 일치`);
process.exit(fail ? 1 : 0);
