import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * 네이버 증권 / 와이즈리포트(네이버 기업정보) 데이터 조회 모음
 * - m.stock.naver.com/api : 시세, 재무 요약, 컨센서스, 투자자 동향, 업종·테마, 순위
 * - fchart.stock.naver.com : 기간별 주가
 * - ac.stock.naver.com : 종목 검색
 * - navercomp.wisereport.co.kr : 재무제표 상세, EBITDA, 주요주주
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MOBILE_API = 'https://m.stock.naver.com/api';
const MOBILE_REFERER = 'https://m.stock.naver.com/';
const WISE_BASE = 'https://navercomp.wisereport.co.kr/v2/company';

export class NaverApiError extends Error {}

// ---------------------------------------------------------------------------
// 공통 헬퍼
// ---------------------------------------------------------------------------

async function getJson<T = any>(url: string, referer = MOBILE_REFERER): Promise<T> {
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Referer: referer },
      timeout: 15000,
    });
    return response.data as T;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      throw new NaverApiError(`요청 실패${status ? ` (HTTP ${status})` : ''}: ${url}`);
    }
    throw error;
  }
}

async function getText(
  url: string,
  referer: string,
  cookie?: string,
): Promise<{ text: string; cookie: string }> {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: referer,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      responseType: 'text',
      timeout: 15000,
    });
    const setCookie = response.headers['set-cookie'];
    const newCookie = Array.isArray(setCookie)
      ? setCookie.map((item) => item.split(';')[0]).join('; ')
      : cookie || '';
    return { text: String(response.data), cookie: newCookie };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      throw new NaverApiError(`요청 실패${status ? ` (HTTP ${status})` : ''}: ${url}`);
    }
    throw error;
  }
}

/** "1,234", "+5.2%", "9.49배", "22,292원" 같은 문자열을 숫자로 변환 */
export function toNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[,%+배원\s]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === 'N/A') return null;
  const num = parseFloat(cleaned);
  return Number.isNaN(num) ? null : num;
}

/** 한국 시간 기준 오늘 날짜 (YYYYMMDD) */
export function todayKst(offsetDays = 0): string {
  const date = new Date(Date.now() + 9 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function normalizeDate(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 8) {
    throw new NaverApiError(`날짜 형식이 올바르지 않습니다: ${value} (예: 20261014)`);
  }
  return digits;
}

const STOCK_CODE_PATTERN = /^[0-9][0-9A-Z]{5}$/;
const INDEX_CODES = ['KOSPI', 'KOSDAQ', 'KPI200'];

// ---------------------------------------------------------------------------
// 종목 검색
// ---------------------------------------------------------------------------

export interface StockSearchItem {
  code: string;
  name: string;
  market: string;
  marketName: string;
  nation: string;
}

export async function searchStocks(query: string, limit = 10): Promise<StockSearchItem[]> {
  const url = `https://ac.stock.naver.com/ac?q=${encodeURIComponent(query)}&target=stock`;
  const data = await getJson<any>(url, 'https://stock.naver.com/');
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  return items.slice(0, limit).map((item) => ({
    code: item.code,
    name: item.name,
    market: item.typeCode,
    marketName: item.typeName,
    nation: item.nationCode,
  }));
}

/** 종목명 또는 종목코드를 받아 6자리 국내 종목코드로 변환 */
export async function resolveStockCode(stock: string): Promise<{ code: string; name: string | null }> {
  const input = stock.trim();
  if (STOCK_CODE_PATTERN.test(input.toUpperCase())) {
    return { code: input.toUpperCase(), name: null };
  }
  const items = await searchStocks(input, 20);
  const domestic = items.filter((item) => item.nation === 'KOR' && STOCK_CODE_PATTERN.test(item.code));
  const exact = domestic.find((item) => item.name === input);
  const match = exact || domestic[0];
  if (!match) {
    throw new NaverApiError(`'${input}'에 해당하는 국내 종목을 찾지 못했습니다.`);
  }
  return { code: match.code, name: match.name };
}

// ---------------------------------------------------------------------------
// 기간별 주가
// ---------------------------------------------------------------------------

export interface PriceBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  foreignRate: number | null;
}

export async function getPriceHistory(
  symbol: string,
  options: { startDate?: string; endDate?: string; timeframe?: 'day' | 'week' | 'month' } = {},
): Promise<{ symbol: string; timeframe: string; startDate: string; endDate: string; bars: PriceBar[] }> {
  const endDate = normalizeDate(options.endDate, todayKst());
  const startDate = normalizeDate(options.startDate, todayKst(-90));
  const timeframe = options.timeframe || 'day';
  const url =
    `https://fchart.stock.naver.com/siseJson.naver?symbol=${encodeURIComponent(symbol)}` +
    `&requestType=1&startTime=${startDate}&endTime=${endDate}&timeframe=${timeframe}`;
  const { text } = await getText(url, 'https://finance.naver.com/');

  let rows: unknown[][];
  try {
    rows = JSON.parse(text.replace(/'/g, '"').trim());
  } catch {
    throw new NaverApiError('기간별 주가 응답을 해석하지 못했습니다.');
  }

  const bars: PriceBar[] = rows.slice(1).map((row) => ({
    date: String(row[0]).trim(),
    open: toNumber(row[1]),
    high: toNumber(row[2]),
    low: toNumber(row[3]),
    close: toNumber(row[4]),
    volume: toNumber(row[5]),
    foreignRate: toNumber(row[6]),
  }));

  return { symbol, timeframe, startDate, endDate, bars };
}

// ---------------------------------------------------------------------------
// 재무 (네이버 요약 + 와이즈리포트 상세)
// ---------------------------------------------------------------------------

export interface FinanceTable {
  periods: { key: string; title: string; isEstimate: boolean }[];
  rows: { name: string; values: Record<string, number | null> }[];
}

/** 네이버 재무 요약 (매출액, 영업이익, 순이익, ROE, EPS, PER 등. 금액 단위 억원) */
export async function getFinanceSummary(code: string, period: 'annual' | 'quarter'): Promise<FinanceTable> {
  const data = await getJson<any>(`${MOBILE_API}/stock/${code}/finance/${period}`);
  const info = data?.financeInfo;
  if (!info) throw new NaverApiError('재무 요약 데이터가 없습니다.');

  const periods = (info.trTitleList || []).map((item: any) => ({
    key: item.key,
    title: item.title,
    isEstimate: item.isConsensus === 'Y',
  }));
  const rows = (info.rowList || []).map((row: any) => {
    const values: Record<string, number | null> = {};
    for (const p of periods) {
      values[p.title] = toNumber(row.columns?.[p.key]?.value);
    }
    return { name: row.title, values };
  });
  return { periods, rows };
}

let wiseCache: { code: string; encparam: string; cookie: string; at: number } | null = null;

async function getWiseSession(code: string): Promise<{ encparam: string; cookie: string }> {
  if (wiseCache && wiseCache.code === code && Date.now() - wiseCache.at < 10 * 60 * 1000) {
    return wiseCache;
  }
  const { text, cookie } = await getText(
    `${WISE_BASE}/c1030001.aspx?cmp_cd=${code}`,
    'https://navercomp.wisereport.co.kr/',
  );
  const match = text.match(/encparam:\s*'([^']+)'/);
  if (!match) throw new NaverApiError('와이즈리포트 재무 페이지를 불러오지 못했습니다.');
  wiseCache = { code, encparam: match[1], cookie, at: Date.now() };
  return wiseCache;
}

/**
 * 와이즈리포트 재무 표
 * page: cF3002(재무제표) / cF4002(투자지표)
 * rpt: cF3002 → 0 손익계산서, 1 재무상태표, 2 현금흐름표 / cF4002 → 1 수익성, 2 성장성, 3 안정성, 4 활동성, 5 가치지표
 */
async function getWiseTable(
  code: string,
  page: 'cF3002' | 'cF4002',
  rpt: number,
  period: 'annual' | 'quarter',
): Promise<{ periods: string[]; rows: { name: string; level: number; values: Record<string, number | null> }[] }> {
  const { encparam, cookie } = await getWiseSession(code);
  const frq = period === 'annual' ? 0 : 1;
  const url =
    `${WISE_BASE}/${page}.aspx?cmp_cd=${code}&frq=${frq}&rpt=${rpt}` +
    `&finGubun=MAIN&frqTyp=${frq}&cn=&encparam=${encodeURIComponent(encparam)}`;
  const { text } = await getText(url, `${WISE_BASE}/c1030001.aspx?cmp_cd=${code}`, cookie);

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new NaverApiError('와이즈리포트 재무 데이터를 해석하지 못했습니다.');
  }

  const labels: string[] = (data.YYMM || []).map((label: string) =>
    String(label).replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim(),
  );
  // 전년대비/전분기대비 증감률 열은 제외
  const columnIndexes = labels
    .map((label, index) => ({ label, index }))
    .filter((item) => !item.label.includes('대비'));

  const rows = (data.DATA || []).map((row: any) => {
    const values: Record<string, number | null> = {};
    for (const { label, index } of columnIndexes) {
      const raw = toNumber(row[`DATA${index + 1}`]);
      values[label] = raw === null ? null : Math.round(raw * 100) / 100;
    }
    return {
      name: String(row.ACC_NM || '').replace(/^[.\s]+/, '').trim(),
      level: Number(row.LVL) || 1,
      values,
    };
  });

  return { periods: columnIndexes.map((item) => item.label), rows };
}

export type StatementType = 'income' | 'balance' | 'cashflow';

const STATEMENT_RPT: Record<StatementType, number> = { income: 0, balance: 1, cashflow: 2 };

/** 재무제표 (금액 단위 억원). detail=false 면 대분류 항목만 */
export async function getFinancialStatement(
  code: string,
  statement: StatementType,
  period: 'annual' | 'quarter',
  detail = false,
) {
  const table = await getWiseTable(code, 'cF3002', STATEMENT_RPT[statement], period);
  const rows = table.rows
    .filter((row) => (detail ? row.level <= 2 : row.level === 1))
    .filter((row) => Object.values(row.values).some((value) => value !== null))
    .map((row) => ({ name: row.name, values: row.values }));
  return { periods: table.periods, rows };
}

/** 가치지표 (EPS, BPS, PER, PBR, EV/EBITDA, EBITDA, EV, 배당 등) */
export async function getValuationMetrics(code: string, period: 'annual' | 'quarter') {
  const table = await getWiseTable(code, 'cF4002', 5, period);
  const seen = new Set<string>();
  const rows: { name: string; values: Record<string, number | null> }[] = [];
  for (const row of table.rows) {
    let name = row.name;
    if (name.includes('＜')) {
      // EV/EBITDA 계산에 쓰이는 EBITDA, EV 는 별도 항목으로 노출하고 나머지 구성요소는 생략
      const base = name.split('＜')[0].trim();
      if (base !== 'EBITDA' && base !== 'EV') continue;
      name = base;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    rows.push({ name, values: row.values });
  }
  return { periods: table.periods, rows };
}

// ---------------------------------------------------------------------------
// 컨센서스 · 리포트
// ---------------------------------------------------------------------------

export async function getStockIntegration(code: string): Promise<any> {
  return getJson<any>(`${MOBILE_API}/stock/${code}/integration`);
}

export async function getStockBasic(code: string): Promise<any> {
  return getJson<any>(`${MOBILE_API}/stock/${code}/basic`);
}

export async function getResearchReports(code: string, limit = 10) {
  const data = await getJson<any[]>(`${MOBILE_API}/research/stock/${code}?pageSize=${limit}`);
  return (Array.isArray(data) ? data : []).map((item) => ({
    date: item.writeDate,
    broker: item.brokerName,
    title: item.title,
    summary: item.previewContent,
    url: item.researchId
      ? `https://m.stock.naver.com/research/stock/${item.researchId}`
      : null,
  }));
}

// ---------------------------------------------------------------------------
// 투자자별 매매동향
// ---------------------------------------------------------------------------

export async function getInvestorTrend(code: string, days = 20) {
  const result: any[] = [];
  let bizdate: string | undefined;
  while (result.length < days) {
    const pageSize = Math.min(30, days - result.length);
    const url =
      `${MOBILE_API}/stock/${code}/trend?pageSize=${pageSize}` + (bizdate ? `&bizdate=${bizdate}` : '');
    const page = await getJson<any[]>(url);
    if (!Array.isArray(page) || page.length === 0) break;
    result.push(...page);
    const last = page[page.length - 1]?.bizdate;
    if (!last || last === bizdate || page.length < pageSize) break;
    bizdate = last;
  }
  return result.slice(0, days).map((item) => ({
    date: item.bizdate,
    close: toNumber(item.closePrice),
    volume: toNumber(item.accumulatedTradingVolume),
    foreignNetBuy: toNumber(item.foreignerPureBuyQuant),
    institutionNetBuy: toNumber(item.organPureBuyQuant),
    individualNetBuy: toNumber(item.individualPureBuyQuant),
    foreignHoldRatio: toNumber(item.foreignerHoldRatio),
  }));
}

// ---------------------------------------------------------------------------
// 업종 · 테마
// ---------------------------------------------------------------------------

export type GroupType = 'industry' | 'theme';

export interface SectorGroup {
  no: number;
  name: string;
  changeRate: number | null;
  stockCount: number;
  riseCount: number;
  fallCount: number;
  steadyCount: number;
}

export async function getSectorGroups(type: GroupType): Promise<SectorGroup[]> {
  const groups: SectorGroup[] = [];
  for (let page = 1; page <= 10; page++) {
    const data = await getJson<any>(`${MOBILE_API}/stocks/${type}?page=${page}&pageSize=100`);
    const items: any[] = Array.isArray(data?.groups) ? data.groups : [];
    for (const item of items) {
      groups.push({
        no: item.no,
        name: item.name,
        changeRate: toNumber(item.changeRate),
        stockCount: item.totalCount,
        riseCount: item.riseCount,
        fallCount: item.fallCount,
        steadyCount: item.steadyCount,
      });
    }
    if (items.length < 100) break;
  }
  return groups;
}

export function mapStockListItem(item: any, index: number) {
  return {
    rank: index + 1,
    code: item.itemCode,
    name: item.stockName,
    market: item.stockExchangeType?.name ?? null,
    close: toNumber(item.closePriceRaw ?? item.closePrice),
    change: toNumber(item.compareToPreviousClosePriceRaw ?? item.compareToPreviousClosePrice),
    changeRate: toNumber(item.fluctuationsRatio),
    volume: toNumber(item.accumulatedTradingVolumeRaw ?? item.accumulatedTradingVolume),
    tradingValue: item.accumulatedTradingValueKrwHangeul ?? null,
    marketCap: item.marketValueHangeul ?? null,
    marketCapRaw: toNumber(item.marketValueRaw),
  };
}

export async function getSectorStocks(type: GroupType, groupNo: number, limit = 30) {
  const data = await getJson<any>(`${MOBILE_API}/stocks/${type}/${groupNo}?page=1&pageSize=${limit}`);
  const stocks: any[] = Array.isArray(data?.stocks) ? data.stocks : [];
  return stocks.map(mapStockListItem);
}

// ---------------------------------------------------------------------------
// 지수 · 순위
// ---------------------------------------------------------------------------

export async function getIndexSummary(indexCode: string) {
  const data = await getJson<any>(`${MOBILE_API}/index/${indexCode}/basic`);
  return {
    code: data?.itemCode ?? indexCode,
    name: data?.stockName ?? indexCode,
    close: toNumber(data?.closePrice),
    change: toNumber(data?.compareToPreviousClosePrice),
    changeRate: toNumber(data?.fluctuationsRatio),
    marketStatus: data?.marketStatus ?? null,
    tradedAt: data?.localTradedAt ?? null,
  };
}

export const RANKING_TYPES = {
  marketValue: '시가총액 상위',
  up: '상승률 상위',
  down: '하락률 상위',
  quantTop: '거래량 상위',
  priceTop: '거래대금 상위',
  searchTop: '검색 상위',
} as const;

export type RankingType = keyof typeof RANKING_TYPES;

export async function getRanking(market: 'KOSPI' | 'KOSDAQ', type: RankingType, limit = 20) {
  const data = await getJson<any>(`${MOBILE_API}/stocks/${type}/${market}?page=1&pageSize=${limit}`);
  const stocks: any[] = Array.isArray(data?.stocks) ? data.stocks : [];
  return stocks.map(mapStockListItem);
}

// ---------------------------------------------------------------------------
// 지분현황 (주요주주)
// ---------------------------------------------------------------------------

export async function getShareholders(code: string) {
  const { text } = await getText(
    `${WISE_BASE}/c1010001.aspx?cmp_cd=${code}`,
    'https://navercomp.wisereport.co.kr/',
  );
  const $ = cheerio.load(text);
  const holders: { name: string; shares: number | null; ratio: number | null }[] = [];
  $('#cTB13 tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;
    const name = ($(cells[0]).attr('title') || $(cells[0]).text()).replace(/\s+/g, ' ').trim();
    if (!name) return;
    holders.push({
      name,
      shares: toNumber($(cells[1]).text()),
      ratio: toNumber($(cells[2]).text()),
    });
  });
  if (holders.length === 0) {
    throw new NaverApiError('주요주주 정보를 찾지 못했습니다. (ETF·리츠 등은 제공되지 않을 수 있습니다)');
  }
  return holders;
}

// ---------------------------------------------------------------------------
// 뉴스 · 공시
// ---------------------------------------------------------------------------

/** "202610151428" → "2026-10-15 14:28" */
function formatCompactDateTime(value: unknown): string | null {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 12) return value ? String(value) : null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)} ${digits.slice(8, 10)}:${digits.slice(10, 12)}`;
}

/** 뉴스 제목·요약의 &quot; 같은 HTML 엔티티 해제 */
function decodeEntities(value: unknown): string {
  return cheerio.load(`<p>${String(value ?? '')}</p>`)('p').text();
}

export async function getStockNews(code: string, limit = 10) {
  const data = await getJson<any[]>(`${MOBILE_API}/news/stock/${code}?pageSize=${limit}`);
  // 응답은 [{ total, items: [...] }] 형태의 묶음 배열 (관련 기사끼리 묶임)
  const items = (Array.isArray(data) ? data : []).flatMap((group) =>
    Array.isArray(group?.items) ? group.items : [],
  );
  return items.slice(0, limit).map((item: any) => ({
    datetime: formatCompactDateTime(item.datetime),
    press: item.officeName ?? null,
    title: decodeEntities(item.titleFull ?? item.title),
    summary: item.body ? decodeEntities(item.body).trim() : null,
    url: item.mobileNewsUrl ?? null,
  }));
}

export async function getDisclosures(code: string, limit = 10) {
  const data = await getJson<any[]>(`${MOBILE_API}/stock/${code}/disclosure?pageSize=${limit}`);
  return (Array.isArray(data) ? data : []).slice(0, limit).map((item) => ({
    id: item.disclosureId,
    datetime: item.datetime ? String(item.datetime).replace('T', ' ') : null,
    title: item.title,
    source: item.author ?? null,
  }));
}

/** 공시 본문 (HTML 을 텍스트로 변환, maxLength 자까지) */
export async function getDisclosureDetail(code: string, disclosureId: number, maxLength = 8000) {
  const data = await getJson<any>(`${MOBILE_API}/stock/${code}/disclosure/${disclosureId}`);
  const disclosure = data?.disclosure;
  if (!disclosure) throw new NaverApiError(`공시(${disclosureId})를 찾지 못했습니다.`);
  const $ = cheerio.load(String(disclosure.contents ?? ''));
  $('script, style, .noprint').remove();
  const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
  // 표는 행 단위로 "셀 | 셀 | 셀" 한 줄로 만든다 (안쪽 표부터 처리)
  $('table')
    .toArray()
    .reverse()
    .forEach((table) => {
      const lines = $(table)
        .find('tr')
        .toArray()
        .map((row) =>
          $(row)
            .children('td, th')
            .toArray()
            .map((cell) => clean($(cell).text()))
            .join(' | '),
        )
        .filter((line) => line.replace(/[\s|-]/g, ''));
      $(table).replaceWith(`\n${lines.join('\n')}\n`);
    });
  $('br').replaceWith('\n');
  $('p, div').append('\n');
  const text = $.root()
    .text()
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return {
    id: disclosure.disclosureId,
    datetime: disclosure.datetime ? String(disclosure.datetime).replace('T', ' ') : null,
    truncated: text.length > maxLength,
    text: text.slice(0, maxLength),
  };
}

// ---------------------------------------------------------------------------
// 현재가 스냅샷 · 호가
// ---------------------------------------------------------------------------

/** integration/basic 의 totalInfos 배열을 { 전일: ..., 시가: ... } 로 변환 (숫자로 바꿀 수 있으면 숫자) */
function mapTotalInfos(infos: any[] | undefined) {
  const result: Record<string, number | string | null> = {};
  for (const info of infos || []) {
    if (!info?.key) continue;
    const raw = info.value;
    // "1,210조 1,797억", "2026.08.13." 처럼 단위가 섞였거나 날짜인 값은 문자열 그대로 둔다
    const isPlain = typeof raw === 'string' && /^[+-]?\d[\d,]*(\.\d+)?(%|배|원)?$/.test(raw.trim());
    result[info.key] = isPlain ? toNumber(raw) : raw ?? null;
  }
  return result;
}

export async function getStockQuote(code: string) {
  const [basic, integration] = await Promise.all([getStockBasic(code), getStockIntegration(code)]);
  return {
    code,
    name: basic?.stockName ?? integration?.stockName ?? null,
    market: basic?.stockExchangeName ?? null,
    price: toNumber(basic?.closePrice),
    change: toNumber(basic?.compareToPreviousClosePrice),
    changeRate: toNumber(basic?.fluctuationsRatio),
    marketStatus: basic?.marketStatus ?? null,
    tradedAt: basic?.localTradedAt ?? null,
    details: mapTotalInfos(integration?.totalInfos),
  };
}

export async function getOrderBook(code: string) {
  const data = await getJson<any>(`${MOBILE_API}/stock/${code}/askingPrice`);
  const mapLevels = (levels: any[] | undefined) =>
    (levels || []).map((level) => ({ price: toNumber(level.price), quantity: toNumber(level.count) }));
  return {
    previousClose: toNumber(data?.lastClosePrice),
    // 매도호가는 높은 가격부터, 매수호가는 높은 가격부터 정렬되어 온다
    asks: mapLevels(data?.sellInfo),
    bids: mapLevels(data?.buyInfos),
    totalAskQuantity: toNumber(data?.totalSell),
    totalBidQuantity: toNumber(data?.totalBuy),
  };
}

// ---------------------------------------------------------------------------
// ETF
// ---------------------------------------------------------------------------

export async function getEtfAnalysis(code: string) {
  const data = await getJson<any>(`${MOBILE_API}/stock/${code}/etfAnalysis`);
  if (!data?.itemCode) {
    throw new NaverApiError(`${code} 는 ETF 분석 정보가 없습니다. (ETF 종목코드인지 확인하세요)`);
  }
  const returns = data.themeReturns ?? {};
  const inflowRaw = data.cumulativeNetInflowList;
  const inflow = (Array.isArray(inflowRaw) ? inflowRaw[0] : inflowRaw) ?? {};
  return {
    code: data.itemCode,
    name: data.itemName,
    summary: data.etfSummary ?? null,
    issuer: data.issuerName ?? null,
    baseIndex: data.etfBaseIndex ?? null,
    listedDate: data.listedDate ?? null,
    marketCap: data.marketValue ?? null,
    totalNav: data.totalNav ?? null,
    nav: toNumber(data.nav),
    deviationRatePct: data.deviationRate === undefined ? null : toNumber(`${data.deviationSign ?? ''}${data.deviationRate}`),
    totalFeePct: toNumber(data.totalFee),
    trackingErrorPct: toNumber(data.chaseErrorRate),
    returnsPct: {
      '1일': toNumber(returns.returnRate1d),
      '1주': toNumber(returns.returnRate1w),
      '1개월': toNumber(returns.returnRate1m),
      '3개월': toNumber(returns.returnRate3m),
      '6개월': toNumber(returns.returnRate6m),
      YTD: toNumber(returns.returnRateYtd),
      '1년': toNumber(returns.returnRate1y),
      '3년': toNumber(returns.returnRate3y),
      '5년': toNumber(returns.returnRate5y),
    },
    netInflow: inflow.referenceDate
      ? {
          referenceDate: inflow.referenceDate,
          '1일': inflow.cumulativeNetInflow1d ?? null,
          '1주': inflow.cumulativeNetInflow1w ?? null,
          '1개월': inflow.cumulativeNetInflow1m ?? null,
          '3개월': inflow.cumulativeNetInflow3m ?? null,
          YTD: inflow.cumulativeNetInflowYtd ?? null,
          '1년': inflow.cumulativeNetInflow1y ?? null,
        }
      : null,
    dividend: data.dividend
      ? {
          yieldTtmPct: toNumber(data.dividend.dividendYieldTtm),
          perShareTtm: toNumber(data.dividend.dividendPerShareTtm),
          countThisYear: data.dividend.dividendCountThisYear ?? null,
          monthsThisYear: data.dividend.dividendMonthThisYear ?? null,
        }
      : null,
    topHoldings: (data.etfTop10MajorConstituentAssets || []).map((item: any) => ({
      rank: item.seq,
      code: item.itemCode ?? null,
      name: item.itemName,
      shares: toNumber(item.stockCount),
      weightPct: toNumber(item.etfWeight),
    })),
    assetAllocation: (data.assetPortfolioList || []).map((item: any) => ({
      type: item.detailTypeCode,
      weightPct: toNumber(item.weight),
    })),
    sectorAllocation: (data.sectorPortfolioList || [])
      .map((item: any) => ({ sector: item.detailTypeCode, weightPct: toNumber(item.weight) }))
      .filter((item: { weightPct: number | null }) => item.weightPct),
  };
}

// ---------------------------------------------------------------------------
// 해외주식 · 해외지수 · 환율/원자재/금리
// ---------------------------------------------------------------------------

const WORLD_API = 'https://api.stock.naver.com';

/** 해외 종목명/티커/로이터코드(AAPL.O) → 로이터코드 */
export async function resolveWorldStock(query: string): Promise<{ reutersCode: string; name: string | null }> {
  const input = query.trim();
  if (/^[A-Z0-9-]+\.[A-Z]+$/i.test(input)) return { reutersCode: input.toUpperCase(), name: null };
  const data = await getJson<any>(
    `https://ac.stock.naver.com/ac?q=${encodeURIComponent(input)}&target=stock`,
    'https://stock.naver.com/',
  );
  const items: any[] = (Array.isArray(data?.items) ? data.items : []).filter(
    (item: any) => item.nationCode !== 'KOR' && item.reutersCode,
  );
  const upper = input.toUpperCase();
  const match =
    items.find((item) => String(item.code).toUpperCase() === upper) ||
    items.find((item) => item.name === input) ||
    items[0];
  if (!match) throw new NaverApiError(`'${input}'에 해당하는 해외 종목을 찾지 못했습니다.`);
  return { reutersCode: match.reutersCode, name: match.name };
}

export async function getWorldStockQuote(reutersCode: string) {
  const [basic, integration] = await Promise.all([
    getJson<any>(`${WORLD_API}/stock/${encodeURIComponent(reutersCode)}/basic`),
    getJson<any>(`${WORLD_API}/stock/${encodeURIComponent(reutersCode)}/integration`).catch(() => null),
  ]);
  const consensus = integration?.consensusInfo;
  const price = toNumber(basic?.closePrice);
  const targetMean = toNumber(consensus?.priceTargetMean);
  return {
    reutersCode,
    ticker: basic?.symbolCode ?? null,
    name: basic?.stockName ?? null,
    nameEng: basic?.stockNameEng ?? null,
    exchange: basic?.stockExchangeName ?? null,
    currency: basic?.currencyType?.code ?? null,
    price,
    change: toNumber(basic?.compareToPreviousClosePrice),
    changeRate: toNumber(basic?.fluctuationsRatio),
    marketStatus: basic?.marketStatus ?? null,
    tradedAt: basic?.localTradedAt ?? null,
    details: mapTotalInfos(basic?.stockItemTotalInfos),
    consensus: consensus
      ? {
          date: consensus.createDate,
          targetPriceMean: targetMean,
          targetPriceHigh: toNumber(consensus.priceTargetHigh),
          targetPriceLow: toNumber(consensus.priceTargetLow),
          upsidePct: price && targetMean ? Math.round(((targetMean - price) / price) * 10000) / 100 : null,
          recommendationMean: toNumber(consensus.recommMean),
          recommendationScale: '1 매도 · 2 비중축소 · 3 중립 · 4 매수 · 5 적극매수',
        }
      : null,
    companySummary: integration?.summaries?.summary ?? integration?.summaries?.[0]?.summary ?? null,
  };
}

export async function getWorldIndex(reutersCode: string) {
  const data = await getJson<any>(`${WORLD_API}/index/${encodeURIComponent(reutersCode)}/basic`);
  return {
    code: reutersCode,
    name: data?.indexName ?? reutersCode,
    close: toNumber(data?.closePrice),
    change: toNumber(data?.compareToPreviousClosePrice),
    changeRate: toNumber(data?.fluctuationsRatio),
    tradedAt: data?.localTradedAt ?? null,
  };
}

export type MarketIndexCategory = 'exchange' | 'energy' | 'metals' | 'bond';

export async function getMarketIndexItem(category: MarketIndexCategory, reutersCode: string) {
  const data = await getJson<any>(
    `https://m.stock.naver.com/front-api/marketIndex/productDetail?category=${category}&reutersCode=${encodeURIComponent(reutersCode)}`,
  );
  const item = data?.result;
  if (!data?.isSuccess || !item) throw new NaverApiError(`${reutersCode} 시세를 불러오지 못했습니다.`);
  return {
    code: reutersCode,
    name: item.name,
    price: toNumber(item.closePrice),
    change: toNumber(item.fluctuations),
    changeRate: toNumber(item.fluctuationsRatio),
    unit: item.unit ?? (category === 'bond' ? '%' : null),
    tradedAt: item.localTradedAt ?? null,
  };
}

export const WORLD_INDEX_CODES = ['.DJI', '.IXIC', '.INX', '.SOX', '.N225', '.SSEC', '.HSI'];

export const MARKET_INDEX_ITEMS: Record<MarketIndexCategory, string[]> = {
  exchange: ['FX_USDKRW', 'FX_JPYKRW', 'FX_EURKRW', 'FX_CNYKRW'],
  energy: ['CLcv1', 'LCOcv1'],
  metals: ['GCcv1', 'SIcv1', 'HGcv1'],
  bond: ['US10YT=RR', 'KR3YT=RR', 'KR10YT=RR'],
};

export { INDEX_CODES };
