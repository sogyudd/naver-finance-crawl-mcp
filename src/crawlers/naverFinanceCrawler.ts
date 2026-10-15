import axios from 'axios';
import { BaseCrawler } from './baseCrawler.js';
import { CrawlResult, StockData, CrawlerOptions } from '../types/index.js';

/**
 * 네이버 증권 모바일 API
 * finance.naver.com 의 옛 HTML 페이지는 stock.naver.com 으로 리다이렉트되므로
 * 새 사이트가 사용하는 JSON API에서 데이터를 가져온다.
 */
const API_BASE = 'https://m.stock.naver.com/api/stock';
const API_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://m.stock.naver.com/',
};

interface TotalInfo {
  code: string;
  key: string;
  value: string;
}

/**
 * 네이버 증권 크롤러
 * URL: https://finance.naver.com/item/coinfo.naver?code=XXXXXX (종목 코드 식별용)
 */
export class NaverFinanceCrawler extends BaseCrawler {
  constructor(options?: CrawlerOptions) {
    super(options);
  }

  /**
   * 주식 코드에서 크롤링 수행
   */
  async crawl(url: string): Promise<CrawlResult> {
    try {
      const codeMatch = url.match(/code=(\d{6})/);
      if (!codeMatch) {
        throw new Error('Stock code not found in URL');
      }
      const stockCode = codeMatch[1];

      const [basic, integration] = await Promise.all([
        this.fetchJson(`${API_BASE}/${stockCode}/basic`),
        this.fetchJson(`${API_BASE}/${stockCode}/integration`),
      ]);

      const stockData = this.extractStockData(basic, integration);

      return {
        url,
        data: stockData,
        timestamp: new Date(),
        statusCode: 200,
      };
    } catch (error) {
      throw new Error(
        `Failed to crawl ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * JSON API 호출 (재시도 포함)
   */
  private async fetchJson(url: string): Promise<any> {
    const retries = this.options.retries || 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await axios.get(url, {
          headers: API_HEADERS,
          timeout: this.options.timeout || 10000,
        });
        return response.data;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < retries - 1) {
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
      }
    }

    throw lastError || new Error(`Failed to fetch ${url}`);
  }

  /**
   * 주식 데이터 추출
   */
  private extractStockData(basic: any, integration: any): StockData {
    const infos: TotalInfo[] = Array.isArray(integration?.totalInfos)
      ? integration.totalInfos
      : [];
    const info = (code: string): string =>
      infos.find((item) => item.code === code)?.value ?? '';

    return {
      company: {
        name: basic?.stockName ?? null,
        code: basic?.itemCode ?? null,
        market: basic?.stockExchangeName ?? basic?.stockExchangeType?.name ?? null,
      },
      quote: {
        date: basic?.localTradedAt ?? null,
        currentPrice: this.parseNumber(basic?.closePrice),
        changeValue: this.parseNumber(basic?.compareToPreviousClosePrice),
        changeRate: this.parseNumber(basic?.fluctuationsRatio),
        prevClose: this.parseNumber(info('lastClosePrice')),
        open: this.parseNumber(info('openPrice')),
        high: this.parseNumber(info('highPrice')),
        low: this.parseNumber(info('lowPrice')),
        volume: this.parseNumber(info('accumulatedTradingVolume')),
        tradeValueMillion: this.parseKoreanAmountToMillion(info('accumulatedTradingValue')),
      },
      investment: {
        marketCap: info('marketValue') || null,
        marketCapRank: null,
        listedShares: null,
        foreignerRatio: this.parseNumber(info('foreignRate')),
        high52w: this.parseNumber(info('highPriceOf52Weeks')),
        low52w: this.parseNumber(info('lowPriceOf52Weeks')),
        per: this.parseNumber(info('per')) ?? (info('per') || null),
        eps: this.parseNumber(info('eps')),
        pbr: this.parseNumber(info('pbr')) ?? (info('pbr') || null),
        bps: this.parseNumber(info('bps')),
        dividendYield: info('dividendYieldRatio') || null,
        industryPer: null,
      },
    };
  }

  /**
   * 헬퍼: "7조 6,240억" 형태의 금액을 백만원 단위 숫자로 변환
   */
  private parseKoreanAmountToMillion(text: string): number | null {
    if (!text) return null;
    const jo = text.match(/([\d,.]+)\s*조/);
    const eok = text.match(/([\d,.]+)\s*억/);
    if (!jo && !eok) return this.parseNumber(text);

    const joValue = jo ? parseFloat(jo[1].replace(/,/g, '')) : 0;
    const eokValue = eok ? parseFloat(eok[1].replace(/,/g, '')) : 0;
    // 1조 = 1,000,000 백만원, 1억 = 100 백만원
    return joValue * 1_000_000 + eokValue * 100;
  }

  /**
   * 헬퍼: 숫자 파싱 (null 반환으로 안정성 확보)
   */
  private parseNumber(text: string | undefined | null): number | null {
    if (!text) return null;
    const cleaned = String(text).replace(/[^0-9.-]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }

  /**
   * URL 유효성 검증
   */
  static validateUrl(url: string): boolean {
    const pattern = /^https:\/\/finance\.naver\.com\/item\/coinfo\.naver\?code=\d{6}$/;
    return pattern.test(url);
  }

  /**
   * 주식 코드로 URL 생성
   */
  static buildUrl(stockCode: string): string {
    if (!/^\d{6}$/.test(stockCode)) {
      throw new Error('Stock code must be 6 digits');
    }
    return `https://finance.naver.com/item/coinfo.naver?code=${stockCode}`;
  }
}
