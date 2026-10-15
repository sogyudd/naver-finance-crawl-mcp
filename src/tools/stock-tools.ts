import { z } from 'zod';
import {
  NaverApiError,
  RANKING_TYPES,
  RankingType,
  INDEX_CODES,
  getFinanceSummary,
  getFinancialStatement,
  getIndexSummary,
  getInvestorTrend,
  getPriceHistory,
  getRanking,
  getResearchReports,
  getSectorGroups,
  getSectorStocks,
  getShareholders,
  getStockBasic,
  getStockIntegration,
  getValuationMetrics,
  resolveStockCode,
  searchStocks,
  toNumber,
} from '../crawlers/naverStockApi.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...(data as object) }, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  const message =
    error instanceof NaverApiError || error instanceof Error ? error.message : 'Unknown error occurred';
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: false, error: message }, null, 2) }],
    isError: true,
  };
}

function wrap<T>(handler: (args: T) => Promise<unknown>) {
  return async (args: T): Promise<ToolResult> => {
    try {
      return ok(await handler(args));
    } catch (error) {
      return fail(error);
    }
  };
}

const stockParam = z
  .string()
  .min(1)
  .describe('종목명 또는 6자리 종목코드 (예: "삼성전자", "005930")');
const periodParam = z
  .enum(['annual', 'quarter'])
  .optional()
  .describe('annual(연간, 기본값) 또는 quarter(분기)');

// ---------------------------------------------------------------------------

const searchStockTool = {
  name: 'search_stock',
  title: 'Search Stock',
  description: '종목명(일부)으로 종목코드를 검색합니다. 다른 도구에 넣을 6자리 코드를 찾을 때 사용하세요.',
  inputSchema: z.object({
    query: z.string().min(1).describe('검색어 (예: "두산퓨얼")'),
    limit: z.number().int().min(1).max(20).optional().describe('최대 결과 수 (기본 10)'),
  }),
  handler: wrap(async ({ query, limit }: { query: string; limit?: number }) => {
    const items = await searchStocks(query, limit ?? 10);
    return { query, count: items.length, items };
  }),
};

const priceHistoryTool = {
  name: 'get_price_history',
  title: 'Get Price History',
  description:
    '종목 또는 지수의 기간별 주가(일/주/월봉: 시가, 고가, 저가, 종가, 거래량, 외국인소진율)를 조회합니다. 수정주가 기준입니다.',
  inputSchema: z.object({
    stock: z
      .string()
      .min(1)
      .describe('종목명, 6자리 종목코드 또는 지수코드(KOSPI, KOSDAQ, KPI200)'),
    startDate: z.string().optional().describe('시작일 YYYYMMDD (기본: 90일 전)'),
    endDate: z.string().optional().describe('종료일 YYYYMMDD (기본: 오늘)'),
    timeframe: z.enum(['day', 'week', 'month']).optional().describe('day(기본), week, month'),
  }),
  handler: wrap(
    async ({
      stock,
      startDate,
      endDate,
      timeframe,
    }: {
      stock: string;
      startDate?: string;
      endDate?: string;
      timeframe?: 'day' | 'week' | 'month';
    }) => {
      const upper = stock.trim().toUpperCase();
      const target = INDEX_CODES.includes(upper)
        ? { code: upper, name: upper }
        : await resolveStockCode(stock);
      const history = await getPriceHistory(target.code, { startDate, endDate, timeframe });
      const bars = history.bars;
      const maxBars = 1000;
      const closes = bars.map((bar) => bar.close).filter((value): value is number => value !== null);
      const first = closes[0];
      const last = closes[closes.length - 1];
      return {
        code: target.code,
        name: target.name,
        timeframe: history.timeframe,
        startDate: history.startDate,
        endDate: history.endDate,
        summary: {
          count: bars.length,
          firstClose: first ?? null,
          lastClose: last ?? null,
          returnPct: first && last ? Math.round(((last - first) / first) * 10000) / 100 : null,
          highest: bars.length ? Math.max(...bars.map((bar) => bar.high ?? -Infinity)) : null,
          lowest: bars.length ? Math.min(...bars.map((bar) => bar.low ?? Infinity)) : null,
        },
        truncated: bars.length > maxBars,
        bars: bars.slice(-maxBars),
      };
    },
  ),
};

const financialsTool = {
  name: 'get_financials',
  title: 'Get Financials',
  description:
    '연도별/분기별 핵심 재무(매출액, 영업이익, 순이익, 이익률, ROE, 부채비율, EPS, PER, BPS, PBR, 배당)와 가치지표(EBITDA, EV, EV/EBITDA, PCR, PSR 등)를 조회합니다. (E) 표시 기간은 컨센서스 추정치입니다. 금액 단위 억원.',
  inputSchema: z.object({ stock: stockParam, period: periodParam }),
  handler: wrap(async ({ stock, period }: { stock: string; period?: 'annual' | 'quarter' }) => {
    const target = await resolveStockCode(stock);
    const p = period ?? 'annual';
    const [summary, valuation] = await Promise.allSettled([
      getFinanceSummary(target.code, p),
      getValuationMetrics(target.code, p),
    ]);
    if (summary.status === 'rejected' && valuation.status === 'rejected') {
      throw summary.reason;
    }
    return {
      code: target.code,
      name: target.name,
      period: p,
      unit: '금액 억원, 비율 %, 주당 원',
      summary:
        summary.status === 'fulfilled'
          ? summary.value
          : { error: String((summary.reason as Error)?.message ?? summary.reason) },
      valuation:
        valuation.status === 'fulfilled'
          ? valuation.value
          : { error: String((valuation.reason as Error)?.message ?? valuation.reason) },
    };
  }),
};

const statementTool = {
  name: 'get_financial_statement',
  title: 'Get Financial Statement',
  description:
    '재무제표(손익계산서, 재무상태표, 현금흐름표)를 연도별/분기별로 조회합니다. IFRS 연결 기준, 최근 5개 기간 + 추정치. 금액 단위 억원.',
  inputSchema: z.object({
    stock: stockParam,
    statement: z.enum(['income', 'balance', 'cashflow']).describe('income(손익), balance(재무상태), cashflow(현금흐름)'),
    period: periodParam,
    detail: z.boolean().optional().describe('true 면 세부 항목까지 포함 (기본 false)'),
  }),
  handler: wrap(
    async ({
      stock,
      statement,
      period,
      detail,
    }: {
      stock: string;
      statement: 'income' | 'balance' | 'cashflow';
      period?: 'annual' | 'quarter';
      detail?: boolean;
    }) => {
      const target = await resolveStockCode(stock);
      const table = await getFinancialStatement(target.code, statement, period ?? 'annual', detail ?? false);
      return { code: target.code, name: target.name, statement, period: period ?? 'annual', unit: '억원', ...table };
    },
  ),
};

const consensusTool = {
  name: 'get_consensus',
  title: 'Get Analyst Consensus',
  description:
    '증권사 컨센서스: 평균 목표주가, 투자의견 평균(1~5, 높을수록 매수), 현재가 대비 상승여력, 연간·분기 실적 추정치, 최근 증권사 리포트 목록을 조회합니다.',
  inputSchema: z.object({
    stock: stockParam,
    reportCount: z.number().int().min(0).max(30).optional().describe('가져올 리포트 수 (기본 10)'),
  }),
  handler: wrap(async ({ stock, reportCount }: { stock: string; reportCount?: number }) => {
    const target = await resolveStockCode(stock);
    const [integration, basic, annual, quarter, reports] = await Promise.all([
      getStockIntegration(target.code),
      getStockBasic(target.code),
      getFinanceSummary(target.code, 'annual').catch(() => null),
      getFinanceSummary(target.code, 'quarter').catch(() => null),
      (reportCount ?? 10) > 0 ? getResearchReports(target.code, reportCount ?? 10).catch(() => []) : [],
    ]);
    const consensus = integration?.consensusInfo;
    const currentPrice = toNumber(basic?.closePrice);
    const targetPrice = toNumber(consensus?.priceTargetMean);
    const pickEstimates = (table: typeof annual) =>
      table
        ? {
            periods: table.periods.filter((p) => p.isEstimate).map((p) => p.title),
            rows: table.rows
              .map((row) => ({
                name: row.name,
                values: Object.fromEntries(
                  table.periods.filter((p) => p.isEstimate).map((p) => [p.title, row.values[p.title]]),
                ),
              }))
              .filter((row) => Object.values(row.values).some((value) => value !== null)),
          }
        : null;
    return {
      code: target.code,
      name: target.name ?? basic?.stockName ?? null,
      currentPrice,
      consensus: consensus
        ? {
            date: consensus.createDate,
            targetPriceMean: targetPrice,
            upsidePct:
              currentPrice && targetPrice ? Math.round(((targetPrice - currentPrice) / currentPrice) * 10000) / 100 : null,
            recommendationMean: toNumber(consensus.recommMean),
            recommendationScale: '1 매도 · 2 비중축소 · 3 중립 · 4 매수 · 5 적극매수',
          }
        : null,
      earningsEstimates: { annual: pickEstimates(annual), quarter: pickEstimates(quarter), unit: '억원' },
      reports,
    };
  }),
};

const investorTrendTool = {
  name: 'get_investor_trend',
  title: 'Get Investor Trend',
  description: '외국인·기관·개인의 일별 순매수 수량과 외국인 보유율을 조회합니다.',
  inputSchema: z.object({
    stock: stockParam,
    days: z.number().int().min(1).max(120).optional().describe('조회할 영업일 수 (기본 20)'),
  }),
  handler: wrap(async ({ stock, days }: { stock: string; days?: number }) => {
    const target = await resolveStockCode(stock);
    const rows = await getInvestorTrend(target.code, days ?? 20);
    const sum = (key: 'foreignNetBuy' | 'institutionNetBuy' | 'individualNetBuy') =>
      rows.reduce((total, row) => total + (row[key] ?? 0), 0);
    return {
      code: target.code,
      name: target.name,
      unit: '주',
      total: {
        days: rows.length,
        foreignNetBuy: sum('foreignNetBuy'),
        institutionNetBuy: sum('institutionNetBuy'),
        individualNetBuy: sum('individualNetBuy'),
      },
      daily: rows,
    };
  }),
};

const industryAnalysisTool = {
  name: 'get_industry_analysis',
  title: 'Get Industry Analysis',
  description:
    '종목이 속한 업종의 등락 현황과 동종업계 경쟁사 비교(주가, 등락률, 시가총액, 최근 연도 매출액·영업이익률·ROE·PER·PBR)를 조회합니다.',
  inputSchema: z.object({
    stock: stockParam,
    peerCount: z.number().int().min(1).max(10).optional().describe('비교할 경쟁사 수 (기본 5)'),
  }),
  handler: wrap(async ({ stock, peerCount }: { stock: string; peerCount?: number }) => {
    const target = await resolveStockCode(stock);
    const [integration, basic, groups] = await Promise.all([
      getStockIntegration(target.code),
      getStockBasic(target.code),
      getSectorGroups('industry'),
    ]);
    const industryNo = Number(integration?.industryCode);
    const industry = groups.find((group) => group.no === industryNo) ?? null;
    const industryRank = industry ? groups.findIndex((group) => group.no === industryNo) + 1 : null;

    const peers: any[] = (integration?.industryCompareInfo || []).slice(0, peerCount ?? 5);
    const companies = [
      { code: target.code, name: basic?.stockName ?? target.name, isTarget: true, close: toNumber(basic?.closePrice), changeRate: toNumber(basic?.fluctuationsRatio), marketCap: null as string | null },
      ...peers.map((peer) => ({
        code: peer.itemCode,
        name: peer.stockName,
        isTarget: false,
        close: toNumber(peer.closePrice),
        changeRate: toNumber(peer.fluctuationsRatio),
        marketCap: peer.marketValue ? `${peer.marketValue}백만원` : null,
      })),
    ];

    const metricNames = ['매출액', '영업이익률', 'ROE', 'PER', 'PBR'];
    const withMetrics = await Promise.all(
      companies.map(async (company) => {
        try {
          const summary = await getFinanceSummary(company.code, 'annual');
          const latest = [...summary.periods].reverse().find((p) => !p.isEstimate);
          const metrics: Record<string, number | null> = {};
          for (const name of metricNames) {
            const row = summary.rows.find((r) => r.name === name);
            metrics[name] = latest && row ? row.values[latest.title] : null;
          }
          return { ...company, fiscalYear: latest?.title ?? null, metrics };
        } catch {
          return { ...company, fiscalYear: null, metrics: null };
        }
      }),
    );

    return {
      code: target.code,
      name: basic?.stockName ?? target.name,
      industry: industry
        ? { ...industry, rankByChangeRate: industryRank, totalIndustries: groups.length }
        : { no: industryNo || null, note: '업종 정보를 찾지 못했습니다.' },
      unit: '매출액 억원, 비율 %',
      companies: withMetrics,
    };
  }),
};

const sectorOverviewTool = {
  name: 'get_sector_overview',
  title: 'Get Sector Overview',
  description:
    '업종(industry) 또는 테마(theme)별 오늘 등락률 순위를 조회합니다. name 이나 groupNo 를 주면 해당 업종·테마의 구성 종목을 함께 돌려줍니다.',
  inputSchema: z.object({
    type: z.enum(['industry', 'theme']).optional().describe('industry(업종, 기본) 또는 theme(테마)'),
    name: z.string().optional().describe('업종·테마 이름 일부 (예: "반도체", "2차전지")'),
    groupNo: z.number().int().optional().describe('업종·테마 번호'),
    limit: z.number().int().min(1).max(100).optional().describe('목록/구성종목 최대 수 (기본 20)'),
  }),
  handler: wrap(
    async ({
      type,
      name,
      groupNo,
      limit,
    }: {
      type?: 'industry' | 'theme';
      name?: string;
      groupNo?: number;
      limit?: number;
    }) => {
      const groupType = type ?? 'industry';
      const max = limit ?? 20;
      const groups = await getSectorGroups(groupType);

      if (!name && groupNo === undefined) {
        return {
          type: groupType,
          totalGroups: groups.length,
          top: groups.slice(0, max),
          bottom: groups.slice(-max).reverse(),
        };
      }

      const keyword = name?.replace(/\s+/g, '').toLowerCase();
      const matches = groups.filter((group) =>
        groupNo !== undefined
          ? group.no === groupNo
          : group.name.replace(/\s+/g, '').toLowerCase().includes(keyword ?? ''),
      );
      if (matches.length === 0) {
        throw new NaverApiError(`'${name ?? groupNo}'에 해당하는 ${groupType === 'industry' ? '업종' : '테마'}을 찾지 못했습니다.`);
      }
      const group = matches[0];
      const stocks = await getSectorStocks(groupType, group.no, max);
      return {
        type: groupType,
        group,
        otherMatches: matches.slice(1, 10).map((item) => ({ no: item.no, name: item.name })),
        stocks,
      };
    },
  ),
};

const shareholdersTool = {
  name: 'get_shareholders',
  title: 'Get Shareholders',
  description: '주요주주 현황(주주명, 보유주식수, 보유지분 %)을 조회합니다. 자사주 포함.',
  inputSchema: z.object({ stock: stockParam }),
  handler: wrap(async ({ stock }: { stock: string }) => {
    const target = await resolveStockCode(stock);
    const holders = await getShareholders(target.code);
    return { code: target.code, name: target.name, unit: '주, %', holders };
  }),
};

const marketOverviewTool = {
  name: 'get_market_overview',
  title: 'Get Market Overview',
  description:
    '코스피·코스닥·코스피200 지수 현황과 시장별 순위(시가총액, 상승률, 하락률, 거래량, 거래대금, 검색 상위)를 조회합니다.',
  inputSchema: z.object({
    market: z.enum(['KOSPI', 'KOSDAQ']).optional().describe('순위를 볼 시장 (기본 KOSPI)'),
    ranking: z
      .enum(['marketValue', 'up', 'down', 'quantTop', 'priceTop', 'searchTop'])
      .optional()
      .describe('marketValue(시총, 기본), up(상승률), down(하락률), quantTop(거래량), priceTop(거래대금), searchTop(검색)'),
    limit: z.number().int().min(1).max(100).optional().describe('순위 종목 수 (기본 20)'),
  }),
  handler: wrap(
    async ({
      market,
      ranking,
      limit,
    }: {
      market?: 'KOSPI' | 'KOSDAQ';
      ranking?: RankingType;
      limit?: number;
    }) => {
      const m = market ?? 'KOSPI';
      const r = ranking ?? 'marketValue';
      const [indices, stocks] = await Promise.all([
        Promise.all(INDEX_CODES.map((code) => getIndexSummary(code).catch(() => ({ code, error: true })))),
        getRanking(m, r, limit ?? 20),
      ]);
      return {
        indices,
        ranking: { market: m, type: r, label: RANKING_TYPES[r], stocks },
      };
    },
  ),
};

export const stockTools = [
  searchStockTool,
  priceHistoryTool,
  financialsTool,
  statementTool,
  consensusTool,
  investorTrendTool,
  industryAnalysisTool,
  sectorOverviewTool,
  shareholdersTool,
  marketOverviewTool,
];
