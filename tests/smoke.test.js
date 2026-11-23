// 견적요청 메일 작성기 스모크 테스트. 실행: npm test (webapp/tests 폴더에서)
const { JSDOM, VirtualConsole } = require('jsdom');
const path = require('path');

const FILE = path.join(__dirname, '..', 'index.html');
let pass = 0, fail = 0;
const failures = [];

async function load(storage = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e.message || e)));
  vc.on('error', e => errors.push(String(e)));
  const dom = await JSDOM.fromFile(FILE, {
    runScripts: 'dangerously', url: 'https://test.local/', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      for (const k in storage) w.localStorage.setItem(k, typeof storage[k] === 'string' ? storage[k] : JSON.stringify(storage[k]));
      w.__copied = null;
      Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async t => { w.__copied = t; } }, configurable: true });
      w.confirm = () => true;
      w.open = () => null;
    }
  });
  const w = dom.window;
  const ev = c => w.eval(c);
  return { w, ev, errors, doc: w.document };
}

function test(name, fn) { tests.push([name, fn]); }
const tests = [];
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'eq'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

const VALID = `S=normalize({staff:'James',site:'SEV (박닌)',dept:'설비팀',purpose:'maint',needBy:'2026-12-20',replyBy:'2026-12-30',
  supName:'JYD',supEmail:'a@b.com',
  items:[{name:'GLOBE VALVE',model:'J41H-300LB',attrs:[{k:'재질',v:'SCM435'},{k:'표면처리',v:'니켈 도금'}],
    rows:[{spec:'1/2"',qty:'250'},{spec:'3/4"',qty:'50'},{spec:'1"',qty:'130'}],unit:'EA',code:'SEC-1',moq:'',cat:'yes'}]});
  SET.sender='James'; renderForm(); refresh();`;

test('페이지가 오류 없이 로드된다', async () => {
  const { errors, doc } = await load();
  eq(errors, [], 'jsdom errors');
  ok(doc.querySelectorAll('#form .card').length >= 6, 'form cards');
});

test('빈 상태에서는 복사·저장 버튼이 잠긴다', async () => {
  const { ev, doc } = await load();
  ok(ev('validate().miss.length') > 0);
  ['#bCopy', '#bGmail', '#bSave', '#bCopyCall', '#bCopyNudge'].forEach(q => ok(doc.querySelector(q).disabled, q));
});

test('필수 정보를 채우면 잠금이 풀린다', async () => {
  const { ev, doc } = await load();
  ev(VALID);
  eq(ev('validate().miss'), [], 'miss');
  ok(!doc.querySelector('#bCopy').disabled);
});

test('규격별 수량과 합계, 사양 항목이 메일에 들어간다', async () => {
  const { ev } = await load();
  ev(VALID);
  const mail = ev("$('#mailBody').value");
  ok(mail.includes('- 재질: SCM435'), 'attr 재질');
  ok(mail.includes('- 표면처리: 니켈 도금'), 'attr 표면처리');
  ok(mail.includes('· 1/2": 250 EA'), 'row 1/2');
  ok(mail.includes('합계: 430 EA'), 'total');
});

test('규격이 하나면 단순 수량으로 나온다', async () => {
  const { ev } = await load();
  ev(VALID); ev("S.items[0].rows=[{spec:'M6×8mm',qty:'3000'}]; S.items[0].unit='PAC'; refresh();");
  const mail = ev("$('#mailBody').value");
  ok(mail.includes('- 규격: M6×8mm') && mail.includes('- 수량: 3,000 PAC'), mail);
  ok(!mail.includes('합계'), 'no total');
});

test('삼성은 기본으로 메일에 나오지 않고, 켜면 나온다', async () => {
  const { ev } = await load();
  ev(VALID);
  ok(!/삼성/.test(ev("$('#mailBody').value")), 'default leaks 삼성');
  ev("S.oSamsung=true; refresh();");
  ok(ev("$('#mailBody').value").includes('삼성 베트남'));
  ev("S.oSamsung=false; S.intro='B'; refresh();");
  ok(!/삼성/.test(ev("$('#mailBody').value")), 'intro B leaks 삼성');
});

test('삼성 코드는 공개를 켠 경우에만 나온다', async () => {
  const { ev } = await load();
  ev(VALID);
  ok(!ev("$('#mailBody').value").includes('SEC-1'));
  ev("S.oSamsung=true; S.oCode=true; refresh();");
  ok(ev("$('#mailBody').value").includes('SEC-1'));
});

test('공급사명이 "미확인"이면 막힌다', async () => {
  const { ev } = await load();
  ev(VALID); ev("S.supName='미확인'; refresh();");
  ok(ev('validate().miss').some(x => x.includes('공급사명')));
});

test('이메일 형식 오류는 막고, 전화만 있어도 통과한다', async () => {
  const { ev } = await load();
  ev(VALID); ev("S.supEmail='abc'; refresh();");
  ok(ev('validate().miss').some(x => x.includes('형식')), 'bad email');
  ev("S.supEmail=''; S.supTel='031-000-0000'; refresh();");
  eq(ev('validate().miss'), [], 'tel only');
  ev("S.supTel=''; refresh();");
  ok(ev('validate().miss').some(x => x.includes('이메일 또는 전화')), 'neither');
});

test('수량이 0, 음수, 문자면 막힌다', async () => {
  const { ev } = await load();
  ev(VALID);
  for (const q of ['0', '-3', 'abc', '미확인', '']) {
    ev(`S.items[0].rows[0].qty=${JSON.stringify(q)}; refresh();`);
    ok(ev('validate().miss.length') > 0, `qty ${q}`);
  }
});

test('구버전 품목(spec, qty)이 새 구조로 변환된다', async () => {
  const { ev } = await load();
  const r = JSON.parse(ev(`JSON.stringify(normalize({items:[{name:'x',spec:'1/2"',qty:'250'}]}).items[0])`));
  eq(r.rows, [{ spec: '1/2"', qty: '250' }]);
  ok(!('spec' in r) && !('qty' in r));
});

test('손상된 저장 데이터가 있어도 앱이 뜬다', async () => {
  const { ev, errors } = await load({
    vst_rfq_draft: { items: [null, 5, { name: 'x' }], purpose: 'zzz', att: null, asks: 'bad' },
    vst_rfq_hist: { a: 1 }, vst_rfq_lang: 'en', vst_rfq_sup: 'oops'
  });
  eq(errors, [], 'errors');
  eq(ev('lang'), 'ko'); eq(ev('S.items.length'), 1); eq(ev('SUP.length'), 0); eq(ev('getHist().length'), 0);
});

test('기록의 구버전 품목도 변환된다', async () => {
  const { ev } = await load({ vst_rfq_hist: [{ id: 'r1', supName: 'A', items: [{ name: 'x', spec: 's', qty: '10' }] }] });
  eq(ev('getHist()[0].items[0].rows[0].qty'), '10');
  ev("showTab('hist')");
  ok(ev("document.querySelector('#hist').textContent").includes('x × 10'));
});

test('시트 전송 행은 19열이고 수량은 합계다', async () => {
  const { ev } = await load();
  ev(VALID);
  const rows = JSON.parse(ev("JSON.stringify(toRows(Object.assign(JSON.parse(JSON.stringify(S)),{id:'r1',ts:'2026-11-23T00:00:00Z'})))"));
  eq(rows.length, 1); eq(rows[0].length, 19);
  eq(rows[0][11], '430');
});

test('공유 저장은 Google Apps Script 주소만 허용한다', async () => {
  const { ev } = await load();
  ev("SET.syncToken='t'; SET.syncUrl='https://evil.example.com/x'");
  eq(ev('syncOn()'), false);
  ev("SET.syncUrl='https://script.google.com/macros/s/ABC/exec'");
  eq(ev('syncOn()'), true);
  ev("SET.syncUrl='http://script.google.com/macros/s/ABC/exec'");
  eq(ev('syncOn()'), false, 'http');
});

test('공유 저장 실패해도 syncRecord가 false를 돌려주고 멈추지 않는다', async () => {
  const { w, ev } = await load();
  ev("SET.syncToken='t'; SET.syncUrl='https://script.google.com/macros/s/ABC/exec'");
  w.fetch = async () => { throw new Error('net'); };
  eq(await ev("syncRecord({id:'r',ts:'2026-11-23T00:00:00Z',items:[normItem({name:'a'})]})"), false);
  eq(await ev("(SET.syncUrl='',syncRecord({items:[]}))"), null);
});

test('공급사를 바꿔 저장하면 새 기록이 되고, 같으면 덮어쓴다', async () => {
  const { ev } = await load();
  ev(VALID); ev('saveRecord()');
  eq(ev('getHist().length'), 1);
  ev('saveRecord()'); eq(ev('getHist().length'), 1, 'same supplier');
  ev("S.supName='DAEHANBOLT'; saveRecord()"); eq(ev('getHist().length'), 2, 'other supplier');
});

test('필수 검증은 클릭 시점에도 다시 한다(guard)', async () => {
  const { ev } = await load();
  eq(ev('guard()'), false);
  ev(VALID); eq(ev('guard()'), true);
});

test('작성자는 설정의 발신자 이름으로 자동 채워진다', async () => {
  const { ev } = await load({ vst_rfq_set: { sender: 'Minh' } });
  eq(ev('S.staff'), 'Minh');
  ev("S.staff='Lan'; refresh();");
  ok(ev('validate().unk').some(x => x.includes('서명')), 'mismatch warning');
});

test('영업일 계산은 주말을 건너뛰고 로컬 날짜를 쓴다', async () => {
  const { ev } = await load();
  const d = new Date(ev('addBizDays(3)') + 'T12:00:00');
  ok(d.getDay() !== 0 && d.getDay() !== 6, 'weekend');
  eq(ev('ymd(new Date(2026,10,23))'), '2026-11-23');
});

test('품목 입력 화면에 사양·규격 입력칸이 생긴다', async () => {
  const { ev, doc } = await load();
  ev(VALID);
  ok(doc.querySelectorAll('#form .item').length === 1);
  ok(doc.querySelectorAll('#form .item input[list=attrkeys]').length === 2, 'attr key inputs');
  ok(doc.querySelectorAll('#form .item .fld.wide .inrow').length >= 5, 'attr + row inputs');
});

test('베트남어로 바꿔도 오류가 없고 키가 빠지지 않는다', async () => {
  const { ev, errors } = await load();
  ev(VALID); ev("lang='vi'; applyLang();");
  eq(errors, [], 'errors');
  eq(ev("Object.keys(L.ko).filter(k=>!(k in L.vi))"), [], 'missing vi keys');
  eq(ev("Object.keys(L.vi).filter(k=>!(k in L.ko))"), [], 'extra vi keys');
});

test('코드에 회사·개인 정보가 하드코딩되어 있지 않다', async () => {
  const src = require('fs').readFileSync(FILE, 'utf8');
  for (const bad of ['Kim Jung Ho', 'Cho Jinuk', 'iMarket', '80억', 'JOEUN', 'DAEHANBOLT', '봉신로드셀', 'jinuk', '@gmail'])
    ok(!src.includes(bad), 'found: ' + bad);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; failures.push(name); console.log('  ✗', name, '\n     ', e.message.split('\n')[0]); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
