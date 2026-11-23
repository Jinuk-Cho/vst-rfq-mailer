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


// ---- 실제 DOM 입력(input 이벤트, click)을 거치는 테스트 ----
const typeIn = (w, el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
const labelOf = (doc, txt, scope) => { const l = [...(scope || doc).querySelectorAll('label')].find(x => x.textContent.trim().startsWith(txt));
  if (!l) throw new Error('라벨 없음: ' + txt); return doc.getElementById(l.getAttribute('for')); };
const clickBtn = (doc, txt, scope) => { const b = [...(scope || doc).querySelectorAll('button')].find(x => x.textContent.trim() === txt);
  if (!b) throw new Error('버튼 없음: ' + txt); b.click(); };
const items = doc => doc.querySelectorAll('#form .item');
async function loadWithDom(storage) {
  const r = await load(storage);
  r.w.URL.createObjectURL = () => 'blob:x';
  return r;
}
async function fillByDom(r) {
  const { w, doc } = r;
  typeIn(w, labelOf(doc, '작성자 (담당'), 'James'); typeIn(w, labelOf(doc, '삼성 법인'), 'SEV'); typeIn(w, labelOf(doc, '사용 부서'), '설비팀');
  typeIn(w, labelOf(doc, '용도'), 'maint'); typeIn(w, labelOf(doc, '삼성 요청 납기'), '2026-12-20');
  typeIn(w, labelOf(doc, '공급사명'), 'JYD'); typeIn(w, labelOf(doc, '공급사 이메일'), 'a@b.com');
  const it = items(doc)[0];
  typeIn(w, labelOf(doc, '품명', it), 'VALVE'); typeIn(w, labelOf(doc, '삼성 코드', it), 'SEC-1'); typeIn(w, labelOf(doc, '카탈로그 등재', it), 'yes');
  typeIn(w, it.querySelector('input[aria-label="수량"]'), '10'); typeIn(w, it.querySelector('input[aria-label^="규격"]'), 'M6');
  r.ev("SET.sender='James'; SET.company='VST'; refresh();");
}

test('el()은 중첩 배열을 끝까지 펼친다', async () => {
  const { ev } = await load();
  eq(ev("el('div',null,[[['a'],'b'],[[['c']]]],'d').textContent"), 'abcd');
  eq(ev("el('div',null,0,null,'',undefined).textContent"), '0');
});

test('화면 입력만으로 필수 항목을 채우면 잠금이 풀리고 메일에 반영된다', async () => {
  const r = await loadWithDom(); await fillByDom(r);
  eq(r.ev('validate().miss'), [], 'miss');
  ok(!r.doc.querySelector('#bCopy').disabled, 'copy unlocked');
  const mail = r.ev("$('#mailBody').value");
  ok(mail.includes('1. 품명: VALVE') && mail.includes('- 규격: M6') && mail.includes('- 수량: 10 EA'), mail);
});

test('화면에 있는 모든 입력칸은 상태(S)에 반영된다', async () => {
  const r = await loadWithDom(); const { w, doc } = r;
  clickBtn(doc, '+ 재질'); clickBtn(doc, '+ 규격 추가');
  const inputs = [...doc.querySelectorAll('#form input, #form select')].filter(e => e.type !== 'file' && e.type !== 'checkbox' && e.id !== 'supPick');
  ok(inputs.length > 25, 'inputs ' + inputs.length);
  const dead = [];
  inputs.forEach(e => {
    const before = r.ev('JSON.stringify(S)');
    if (e.tagName === 'SELECT') e.value = [...e.options].map(o => o.value).filter(v => v !== e.value).pop();
    else e.value = e.type === 'date' ? '2031-01-02' : 'zz' + Math.random().toString(36).slice(2, 5);
    e.dispatchEvent(new w.Event('input', { bubbles: true }));
    if (r.ev('JSON.stringify(S)') === before) dead.push(e.getAttribute('aria-label') || e.id);
  });
  eq(dead, [], '상태에 반영되지 않는 입력칸');
});

test('설정 탭의 모든 입력칸은 SET에 반영된다', async () => {
  const r = await loadWithDom(); const { w, doc } = r;
  const inputs = [...doc.querySelectorAll('#setForm input, #syncForm input')];
  eq(inputs.length, 11);
  const dead = [];
  inputs.forEach(e => { const b = r.ev('JSON.stringify(SET)'); typeIn(w, e, 'q' + Math.random().toString(36).slice(2, 5)); if (r.ev('JSON.stringify(SET)') === b) dead.push(e.id); });
  eq(dead, []);
});

test('설정에서 이름을 한 글자씩 쳐도 작성자가 전체 이름을 따라간다', async () => {
  const { w, ev, doc } = await loadWithDom();
  ev("showTab('set')");
  const sender = labelOf(doc, '작성자(발신자)');
  'James'.split('').forEach((_, i) => typeIn(w, sender, 'James'.slice(0, i + 1)));
  eq(ev('S.staff'), 'James');
  ev("showTab('write')"); eq(labelOf(doc, '작성자 (담당').value, 'James');
  ok(!ev('validate().unk').some(x => x.includes('서명')), 'no mismatch warning');
  typeIn(w, labelOf(doc, '작성자 (담당'), 'Lan');     // 직접 바꾼 작성자는 덮어쓰지 않는다
  ev("showTab('set')"); typeIn(w, labelOf(doc, '작성자(발신자)'), 'Jamie');
  eq(ev('S.staff'), 'Lan');
});

test('품목·규격·사양 항목을 화면에서 추가·삭제하면 상태와 메일이 같다', async () => {
  const r = await loadWithDom(); await fillByDom(r); const { w, doc } = r;
  clickBtn(doc, '+ 재질'); clickBtn(doc, '+ 규격 추가'); clickBtn(doc, '+ 품목 추가');
  eq(r.ev('S.items.length'), 2); eq(items(doc).length, 2);
  eq(r.ev('S.items[0].attrs.length'), 1); eq(r.ev('S.items[0].rows.length'), 2);
  let it = items(doc)[0];
  typeIn(w, it.querySelector('input[aria-label="값"]'), 'SUS');
  const specs = it.querySelectorAll('input[aria-label^="규격"]'), qtys = it.querySelectorAll('input[aria-label="수량"]');
  eq(specs.length, 2); eq(qtys.length, 2);
  typeIn(w, qtys[1], '20'); typeIn(w, specs[1], 'M8');
  eq(r.ev('S.items[0].rows.map(x=>x.spec+":"+x.qty).join()'), 'M6:10,M8:20');
  let mail = r.ev("$('#mailBody').value");
  ok(mail.includes('- 재질: SUS') && mail.includes('· M8: 20 EA') && mail.includes('합계: 30 EA'), mail);
  ok(doc.querySelector('#bCopy').disabled, 'second empty item must lock');
  items(doc)[1].querySelector('.top .x').click();
  eq(items(doc).length, 1); eq(r.ev('S.items.length'), 1);
  it = items(doc)[0]; it.querySelectorAll('.fld.wide .inrow')[1].querySelector('button.x').click();
  it = items(doc)[0];
  eq(it.querySelectorAll('input[aria-label^="규격"]').length, 1); eq(r.ev('S.items[0].rows.length'), 1);
  it.querySelector('input[aria-label="값"]').closest('.inrow').querySelector('button.x').click();
  eq(r.ev('S.items[0].attrs.length'), 0); eq(items(doc)[0].querySelectorAll('input[list=attrkeys]').length, 0);
  mail = r.ev("$('#mailBody').value");
  ok(!mail.includes('SUS') && !mail.includes('합계'), mail);
  eq(r.ev('validate().miss'), []);
});

test('첫 품목을 지우면 남은 품목의 입력칸이 자기 값을 보여준다', async () => {
  const r = await loadWithDom(); await fillByDom(r); const { w, doc } = r;
  clickBtn(doc, '+ 품목 추가');
  typeIn(w, labelOf(doc, '품명', items(doc)[1]), 'BOLT');
  items(doc)[0].querySelector('.top .x').click();
  eq(labelOf(doc, '품명', items(doc)[0]).value, 'BOLT');
  ok(r.ev("$('#mailSubj').value").includes('BOLT'));
});

test('사양 항목의 이름만 있거나 값만 있으면 경고하고, 필수 검증은 그대로다', async () => {
  const r = await loadWithDom(); await fillByDom(r);
  clickBtn(r.doc, '+ 재질');
  ok(r.ev('validate().unk').some(x => x.includes('사양 항목')), 'warn');
  eq(r.ev('validate().miss'), [], 'not blocking');
});

test('수량이 문자면 막히고 1,200은 통과한다 (화면 입력)', async () => {
  const r = await loadWithDom(); await fillByDom(r); const { w, doc } = r;
  typeIn(w, items(doc)[0].querySelector('input[aria-label="수량"]'), 'abc');
  ok(doc.querySelector('#bSave').disabled, 'locked');
  typeIn(w, items(doc)[0].querySelector('input[aria-label="수량"]'), '1,200');
  ok(!doc.querySelector('#bSave').disabled, 'unlocked'); ok(r.ev("$('#mailBody').value").includes('1,200 EA'));
});

test('저장 → 새로 작성 → 불러오기가 화면 입력칸까지 복원한다', async () => {
  const r = await loadWithDom(); await fillByDom(r); const { w, doc } = r;
  typeIn(w, labelOf(doc, '공급사 전화'), '031-1'); typeIn(w, labelOf(doc, '삼성 담당자'), 'Kim');
  clickBtn(doc, '+ 재질'); typeIn(w, items(doc)[0].querySelector('input[aria-label="값"]'), 'SUS');
  doc.querySelector('#bSave').click(); await new Promise(x => setTimeout(x, 30));
  eq(r.ev('getHist().length'), 1);
  clickBtn(doc, '새로 작성');
  eq(labelOf(doc, '품명', items(doc)[0]).value, ''); eq(labelOf(doc, '공급사명').value, ''); eq(labelOf(doc, '작성자 (담당').value, 'James');
  r.ev("showTab('hist')");
  clickBtn(doc, '불러오기', doc.querySelector('#hist'));
  ok(!doc.querySelector('#tab-write').hidden, 'write tab');
  eq(items(doc).length, 1);
  eq(labelOf(doc, '품명', items(doc)[0]).value, 'VALVE'); eq(labelOf(doc, '공급사 전화').value, '031-1'); eq(labelOf(doc, '삼성 담당자').value, 'Kim');
  eq(items(doc)[0].querySelector('input[aria-label="값"]').value, 'SUS');
  eq(items(doc)[0].querySelector('input[aria-label="수량"]').value, '10');
  ok(r.ev("$('#mailBody').value").includes('- 재질: SUS'));
  eq(r.ev('S.id'), undefined);
});

test('설정 탭을 다녀와도 작성 탭 입력값이 그대로이고 중복되지 않는다', async () => {
  const r = await loadWithDom(); await fillByDom(r); const { w, doc } = r;
  clickBtn(doc, '+ 규격 추가');
  r.ev("showTab('set')"); typeIn(w, labelOf(doc, '전화', doc.querySelector('#setForm')), '02-123'); r.ev("showTab('write')");
  eq(items(doc).length, 1); eq(doc.querySelectorAll('#form .card').length, 6);
  eq(labelOf(doc, '공급사명').value, 'JYD'); eq(items(doc)[0].querySelectorAll('input[aria-label="수량"]').length, 2);
  ok(r.ev("$('#mailBody').value").includes('Tel: 02-123'));
  eq(doc.querySelectorAll('#fileList').length, 1);
});

test('언어를 바꿔도 입력값과 직접 고친 메일 본문이 유지되고, 베트남어 화면에 한글만 있는 칩이 없다', async () => {
  const r = await loadWithDom(); await fillByDom(r); const { w, doc } = r;
  typeIn(w, doc.querySelector('#mailBody'), '직접 고친 본문');
  doc.querySelector('[data-lang=vi]').click();
  eq(doc.querySelector('#mailBody').value, '직접 고친 본문');
  eq(labelOf(doc, 'Tên hàng', items(doc)[0]).value, 'VALVE');
  eq(labelOf(doc, 'Tên nhà cung cấp').value, 'JYD');
  const kor = [...doc.querySelectorAll('#form button')].map(b => b.textContent).filter(x => /^\+ [가-힣]+$/.test(x));
  eq(kor, [], '한글만 있는 칩');
  eq(doc.querySelectorAll('#form .item').length, 1);
  doc.querySelector('[data-lang=ko]').click();
  eq(doc.querySelector('#mailBody').value, '직접 고친 본문');
  eq(r.errors, [], 'errors');
});

test('입력칸을 고치면 그때는 메일 본문이 다시 만들어진다', async () => {
  const r = await loadWithDom(); await fillByDom(r); const { w, doc } = r;
  typeIn(w, doc.querySelector('#mailBody'), '직접 고친 본문');
  typeIn(w, labelOf(doc, '공급사명'), 'NEWSUP');
  ok(doc.querySelector('#mailBody').value.includes('NEWSUP'));
});

test('공급사 주소록: 저장·선택, 이름 없는 항목은 선택지에 안 나온다', async () => {
  const r = await loadWithDom(); await fillByDom(r); const { w, doc } = r;
  typeIn(w, labelOf(doc, '공급사 전화'), '031-1');
  clickBtn(doc, '이 공급사 저장'); eq(r.ev('SUP.length'), 1);
  r.ev("showTab('set')"); clickBtn(doc, '+ 공급사 추가'); eq(r.ev('SUP.length'), 2);
  r.ev("showTab('write')");
  eq(doc.querySelectorAll('#supPick option').length, 2, '빈 이름 제외');
  clickBtn(doc, '새로 작성');
  const pick = doc.querySelector('#supPick'); pick.value = '0'; pick.dispatchEvent(new w.Event('change', { bubbles: true }));
  eq(labelOf(doc, '공급사명').value, 'JYD'); eq(labelOf(doc, '공급사 전화').value, '031-1'); eq(labelOf(doc, '공급사 이메일').value, 'a@b.com');
});

test('"미확인" 칩은 값을 채우되 경고로 남고, 공급사명이 미확인이면 막는다 (화면)', async () => {
  const r = await loadWithDom(); await fillByDom(r); const { w, doc } = r;
  const dept = labelOf(doc, '사용 부서'); clickBtn(doc, '미확인', dept.closest('.fld'));
  eq(dept.value, '미확인'); eq(r.ev('S.dept'), '미확인');
  ok(r.ev('validate().unk').some(x => x.includes('사용 부서')), 'unk warn');
  ok(!doc.querySelector('#bCopy').disabled);
  typeIn(w, labelOf(doc, '공급사명'), '미확인'); ok(doc.querySelector('#bCopy').disabled, 'supName 미확인 blocks');
});

test('손상된 저장 값(숫자·잘못된 카탈로그 값)이 있어도 오류 없이 정리된다', async () => {
  const r = await load({ vst_rfq_draft: { staff: 123, supEmail: {}, items: [{ name: 5, cat: 'zzz', rows: [{ spec: 1, qty: 3 }], attrs: [{ k: 1, v: null }] }] } });
  eq(r.errors, []);
  eq(r.ev('S.staff'), '123'); eq(r.ev('S.supEmail'), ''); eq(r.ev('S.items[0].cat'), ''); eq(r.ev('S.items[0].rows[0].qty'), '3');
  r.ev('validate(); refresh();'); eq(r.errors, []);
});

test('모든 화면 문구 키가 한국어·베트남어에 있다', async () => {
  const { ev } = await load();
  const src = require('fs').readFileSync(FILE, 'utf8');
  const keys = new Set([...src.matchAll(/\bt\('([a-z_A-Z0-9]+)'\)/g)].map(m => m[1]).concat([...src.matchAll(/data-t="([^"]+)"/g)].map(m => m[1])));
  const missing = [...keys].filter(k => !ev('(' + JSON.stringify(k) + ' in L.ko) && (' + JSON.stringify(k) + ' in L.vi)'));
  eq(missing, []);
});

test('Gmail 열기: 공백이 붙은 이메일도 받는 사람에 들어간다', async () => {
  const r = await loadWithDom(); await fillByDom(r); const { w, doc } = r;
  let url = ''; w.open = u => { url = u; return null; };
  typeIn(w, labelOf(doc, '공급사 이메일'), ' a@b.com ');
  doc.querySelector('#bGmail').click(); await new Promise(x => setTimeout(x, 30));
  ok(url.includes('to=a%40b.com&'), url);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; failures.push(name); console.log('  ✗', name, '\n     ', e.message.split('\n')[0]); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
