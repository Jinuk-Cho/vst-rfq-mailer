/**
 * 견적요청 공유 기록 (Google 시트 + Apps Script)
 *
 * 설치: 시트를 하나 만들고 [확장 프로그램 > Apps Script]에 이 코드를 붙여 넣는다.
 * TOKEN을 길고 추측하기 어려운 문자열로 바꾼 뒤 [배포 > 새 배포 > 웹 앱]
 *   - 실행 사용자: 나
 *   - 액세스 권한: 모든 사용자
 * 로 배포하고, 나온 웹 앱 URL과 TOKEN을 앱의 설정 탭에 입력한다.
 * 자세한 순서는 SETUP.md 참고.
 */
const TOKEN = '여기에-길고-비밀스러운-문자열로-바꾸세요';
const SHEET_NAME = '요청기록';
const HEAD = ['rid', '품목번호', '작성일시', '작성자', '공급사', '공급사 연락처', '삼성 법인·공장', '사용 부서',
  '품명', '모델·품번', '규격·사양', '수량', '단위', '삼성 코드', 'MOQ', '카탈로그', '용도', '삼성 요청 납기', '회신 확인일',
  '상태', '비고'];
const DATA_COLS = 19;          // 앱이 보내는 열 수 (rid ~ 회신 확인일)
const STATUS_DEFAULT = '요청함'; // 직원이 시트에서 '회신받음', '종결' 등으로 바꾼다. 앱이 다시 저장해도 덮어쓰지 않는다.

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let s = ss.getSheetByName(SHEET_NAME);
  if (!s) {
    s = ss.insertSheet(SHEET_NAME);
    s.appendRow(HEAD);
    s.setFrozenRows(1);
  }
  return s;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// 시트가 수식으로 해석하지 않도록 = + - @ 로 시작하는 값 앞에 ' 를 붙인다.
function safe_(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.token !== TOKEN) return out_({ ok: false, error: 'token' });
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const s = sheet_();
    const last = s.getLastRow();
    const index = {}; // "rid|품목번호" -> 행 번호
    if (last > 1) {
      s.getRange(2, 1, last - 1, 2).getValues().forEach(function (r, i) { index[r[0] + '|' + r[1]] = i + 2; });
    }
    rows.forEach(function (r) {
      const vals = r.slice(0, DATA_COLS).map(safe_);
      while (vals.length < DATA_COLS) vals.push('');
      const key = vals[0] + '|' + vals[1];
      if (index[key]) {
        s.getRange(index[key], 1, 1, DATA_COLS).setValues([vals]); // 상태·비고 열은 건드리지 않는다
      } else {
        s.appendRow(vals.concat([STATUS_DEFAULT, '']));
      }
    });
    return out_({ ok: true, n: rows.length });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.token !== TOKEN) return out_({ ok: false, error: 'token' });
  if (p.action === 'ping') return out_({ ok: true });
  const s = sheet_();
  const last = s.getLastRow();
  if (p.action === 'list') {
    const n = Math.min(last - 1, 500); // 최근 500행
    const rows = n > 0 ? s.getRange(last - n + 1, 1, n, HEAD.length).getDisplayValues().reverse() : [];
    return out_({ ok: true, head: HEAD, rows: rows });
  }
  return out_({ ok: false, error: 'action' });
}
