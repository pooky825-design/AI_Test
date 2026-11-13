// 엑셀 내보내기 (3.8) — 내보낸 일시, 시세·환율 기준 시각, 계산 기준 포함(FR-XLS-03)
const ExcelJS = require('exceljs');

const KRW = '#,##0';
const USD = '#,##0.00';
const PCT = '0.0%';
const QTY = '#,##0.######';

function fmtTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}

function header(ws, cols) {
  const row = ws.addRow(cols);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    c.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  return row;
}

function info(ws, pairs) {
  for (const [k, v] of pairs) {
    const r = ws.addRow([k, v]);
    r.getCell(1).font = { bold: true };
  }
  ws.addRow([]);
}

// 그룹별·분류별 합계 행: 올해 손익·전체기간 손익 (v0.10)
function totalsRow(ws, name, x, ongoing) {
  const r = ws.addRow([name, x.count, x.valueKrw, x.costKrw, x.pnlKrw, x.returnPct, x.origCostKrw, x.totalPnlKrw, x.totalPct, ...(ongoing ? [x.todayPnlKrw, x.todayPct] : [])]);
  [3, 4, 5, 7, 8, 10].forEach((i) => (r.getCell(i).numFmt = KRW));
  [6, 9, 11].forEach((i) => (r.getCell(i).numFmt = PCT));
  return r;
}

async function assetsWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('자산 현황');
  ws.addRow([data.ongoing ? `자산 현황 (${data.year}년, 현재가 기준)` : `자산 현황 (${data.year}년 말 기준)`]).font = { bold: true, size: 14 };
  info(ws, [
    ['그룹', data.groupId ? (data.groups.find((g) => g.id === data.groupId) || {}).name : data.merged ? '전체 (통합: 그룹 구분 없이 종목별 합산)' : '전체'],
    ['기준 연도', data.ongoing ? `${data.year}년 (진행 중, 현재가·현재 환율)` : `${data.year}년 말 (연말 종가·연말 환율, ${data.year}년 말 보유 수량)`],
    ['내보낸 일시', fmtTime(data.basis.generatedAt)],
    ['시세 기준 시각', `${fmtTime(data.basis.priceTimeOldest)} ~ ${fmtTime(data.basis.priceTimeLatest)}`],
    ['적용 환율 (USD/KRW)', data.basis.fxRate],
    ['환율 기준 시각', fmtTime(data.basis.fxTime)],
    ['매입 기준', `평균 매입단가·매입금액은 ${data.year}년 1월 1일 기준: 전년 말까지 보유한 수량은 1월 1일 평가액(전년 마지막 종가), 그 해 매수분은 매수 단가`],
    ['계산 기준', '원화 평가금액 = 가격(올해는 현재가, 지난 연도는 연말 종가) × 그 해 말 보유 수량 × 환율(국내 1). 미국 종목 손익은 매입·평가 모두 같은 환율 적용(환차손익 미반영).'],
    ['금년 손익', '평가금액(원화) − 손익 기준액(금년). 손익 기준액(금년) = 이월 금액이 있으면 이월 금액, 없으면 매입금액. 금년 수익률 = 금년 손익 ÷ 손익 기준액(금년)'],
    ['전체기간 손익', '원화 평가금액 − 원래 매입금액(실제 평균 매입단가 × 수량) + 누적 실현손익. 전체 수익률 = 전체기간 손익 ÷ 원래 매입금액'],
    ['안내', '시세는 지연되거나 부정확할 수 있으며, 투자 권유가 아닌 참고용입니다.'],
  ]);
  header(ws, ['그룹', '종목코드', '종목명', '구분', '시장', '통화', '보유 수량', '매입단가(평균)', data.ongoing ? '현재가' : '연말 종가', '평가금액(거래통화)', '적용 환율', '원화 평가금액', '금년 손익(원화)', '금년 수익률', '시세 기준 시각', '분류', '손익 기준액(금년, 원화)', '실제 평균 매입단가', '원래 매입금액(원화)', '전체 손익(원화)', '전체 수익률', '올해 실현손익(원화)']);
  for (const r of data.rows) {
    if (r.error) {
      ws.addRow([r.groupName, r.code, `조회 실패: ${r.error}`, '', '', '', r.quantity, r.avgPrice]);
      continue;
    }
    const cur = r.instrument.currency === 'USD' ? USD : KRW;
    const row = ws.addRow([
      r.groupName, r.code, r.instrument.name, r.instrument.type, r.instrument.market, r.instrument.currency, r.quantity, r.origAvgPrice, r.price,
      r.value, r.fxRate, r.valueKrw, r.pnlKrw, r.returnPct, fmtTime(r.priceTime), r.categoryLabel, r.costKrw, r.origAvgPrice,
      r.origCostKrw, r.totalPnlKrw, r.totalPct, r.realizedYearKrw || null,
    ]);
    [19, 20, 22].forEach((i) => (row.getCell(i).numFmt = KRW));
    row.getCell(21).numFmt = PCT;
    row.getCell(17).numFmt = KRW;
    row.getCell(18).numFmt = cur;
    row.getCell(7).numFmt = QTY;
    [8, 9, 10].forEach((i) => (row.getCell(i).numFmt = cur));
    row.getCell(11).numFmt = USD;
    [12, 13].forEach((i) => (row.getCell(i).numFmt = KRW));
    row.getCell(14).numFmt = PCT;
  }
  // 그 해 전량 매도 종목: 손익만
  for (const r of data.soldRows || []) {
    const row = ws.addRow([r.groupName, r.code, r.instrument.name, r.instrument.type, r.instrument.market, r.instrument.currency, 0, '', '', '', r.fxRate, 0, r.pnlKrw, null,
      `${data.year}년 전량 매도${r.hasRealized ? '' : ' (실현손익 미입력)'}`, r.categoryLabel, null, null, null, r.totalPnlKrw, null, r.realizedYearKrw || null]);
    [12, 13, 20, 22].forEach((i) => (row.getCell(i).numFmt = KRW));
    row.getCell(11).numFmt = USD;
  }
  const T = data.total;
  const t = ws.addRow(['합계', '', '', '', '', '', '', '', '', '', '', T.valueKrw, T.pnlKrw, T.returnPct, '', '', T.costKrw, '', T.origCostKrw, T.totalPnlKrw, T.totalPct]);
  t.font = { bold: true };
  [12, 13, 17, 19, 20].forEach((i) => (t.getCell(i).numFmt = KRW));
  [14, 21].forEach((i) => (t.getCell(i).numFmt = PCT));
  // 그룹별 합계
  if ((data.groupTotals || []).length > 1) {
    ws.addRow([]);
    header(ws, ['그룹', '종목 수', '원화 평가금액', '손익 기준액(금년)', '금년 손익', '금년 수익률', '매입금액', '전체 손익', '전체 수익률', ...(data.ongoing ? ['오늘 손익', '오늘 손익률'] : [])]);
    for (const g of data.groupTotals) totalsRow(ws, g.name, g, data.ongoing);
  }
  // 분류(종류)별 합계 (v0.30.57)
  if ((data.typeTotals || []).length) {
    ws.addRow([]);
    header(ws, ['분류', '종목 수', '원화 평가금액', '손익 기준액(금년)', '금년 손익', '금년 수익률', '매입금액', '전체 손익', '전체 수익률', ...(data.ongoing ? ['오늘 손익', '오늘 손익률'] : [])]);
    for (const c of data.typeTotals) totalsRow(ws, c.label, c, data.ongoing);
  }
  // 투자 지역별 합계
  if ((data.categoryTotals || []).length) {
    ws.addRow([]);
    header(ws, ['투자 지역', '종목 수', '원화 평가금액', '손익 기준액(금년)', '금년 손익', '금년 수익률', '매입금액', '전체 손익', '전체 수익률', ...(data.ongoing ? ['오늘 손익', '오늘 손익률'] : [])]);
    for (const c of data.categoryTotals) totalsRow(ws, c.label, c, data.ongoing);
  }
  ws.columns.forEach((c, i) => (c.width = [10, 10, 30, 8, 12, 7, 12, 14, 12, 18, 10, 16, 16, 9, 22][i] || 12));
  return wb.xlsx.writeBuffer();
}

async function yearlyWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('연도별 자산');
  ws.addRow([`연도별 자산 (${data.fromYear}~${data.toYear})`]).font = { bold: true, size: 14 };
  info(ws, [
    ['내보낸 일시', fmtTime(data.basis.generatedAt)],
    ['현재 환율 (USD/KRW)', data.basis.fxRate],
    ['환율 기준 시각', fmtTime(data.basis.fxTime)],
    ['계산 기준', data.basis.formula],
    ['주의', data.basis.note],
  ]);
  header(ws, ['연도', '상태', '연말 환율', '자산금액(원)', '전년 대비(원)', '전년 대비(%)', '제외 종목 수', '실제 수령 배당(원, 자산금액 미포함)']);
  for (const y of data.years) {
    const r = ws.addRow([y.year, y.ongoing ? '진행 중' : '', y.fxRate, y.valueKrw, y.diffKrw, y.diffPct, y.excludedCount, y.dividendKrw]);
    r.getCell(3).numFmt = USD;
    [4, 5, 8].forEach((i) => (r.getCell(i).numFmt = KRW));
    r.getCell(6).numFmt = PCT;
  }
  ws.columns.forEach((c, i) => (c.width = [24, 10, 12, 18, 16, 12, 12, 30][i] || 12));

  const ws2 = wb.addWorksheet('종목별 내역');
  header(ws2, ['연도', '종목코드', '종목명', '구분', '통화', '그 해 말 보유 수량', '연말 종가', '종가 기준일', '적용 환율', '원화 금액', '비고']);
  for (const y of data.years) {
    for (const i of y.items) {
      const r = ws2.addRow([
        y.year, i.code, i.name, i.type, i.currency, i.quantity, i.close ?? '-', i.closeDate ? String(i.closeDate).slice(0, 10) : '-',
        i.fxRate ?? '-', i.excluded ? '-' : i.valueKrw, i.excluded ? `합계 제외: ${i.reason}` : y.ongoing ? '진행 중(최신 시세)' : '',
      ]);
      r.getCell(6).numFmt = QTY;
      if (typeof i.close === 'number') r.getCell(7).numFmt = i.currency === 'USD' ? USD : KRW;
      if (typeof i.fxRate === 'number') r.getCell(9).numFmt = USD;
      if (!i.excluded) r.getCell(10).numFmt = KRW;
    }
  }
  ws2.columns.forEach((c, i) => (c.width = [8, 10, 30, 8, 7, 14, 12, 12, 10, 16, 26][i] || 12));
  return wb.xlsx.writeBuffer();
}

module.exports = { assetsWorkbook, yearlyWorkbook };
