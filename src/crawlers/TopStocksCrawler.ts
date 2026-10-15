import axios from 'axios';

// finance.naver.com/sise/lastsearch2.naver 는 stock.naver.com 으로 리다이렉트되므로
// 새 사이트가 사용하는 검색 상위 종목 JSON API를 사용한다.
const CRAWL_CONFIG = {
  URL: 'https://m.stock.naver.com/api/stocks/searchTop',
  MARKETS: ['KOSPI', 'KOSDAQ'] as const,
  PAGE_SIZE: 15,
  HEADERS: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'application/json',
    Referer: 'https://m.stock.naver.com/',
  },
};

// 데이터 구조 정의
export interface TopStockData {
  rank: number;
  code: string; // 종목 코드
  name: string;
  market: string; // KOSPI / KOSDAQ
  searchRatio: string;
  currentPrice: number;
  priceChange: number;
  changeRate: string;
  volume: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  per: number | null;
  roe: number | null;
}

/**
 * 주어진 문자열을 파싱하여 숫자로 변환합니다.
 * 변환 실패 시 null을 반환하여 데이터의 신뢰성을 높입니다.
 */
function safeParseFloat(text: string | number | undefined | null): number | null {
  if (text === undefined || text === null) return null;
  const cleanedText = String(text).trim().replace(/,/g, '');
  if (cleanedText === 'N/A' || cleanedText === '') return null;
  const num = parseFloat(cleanedText);
  return isNaN(num) ? null : num;
}

/**
 * 네이버 증권의 검색 상위 종목 데이터를 크롤링하는 함수
 * 코스피, 코스닥 각각의 검색 상위 종목을 순위대로 반환한다.
 */
export async function crawlTopSearchedStocksRobust(): Promise<TopStockData[]> {
  const stockList: TopStockData[] = [];

  for (const market of CRAWL_CONFIG.MARKETS) {
    const url = `${CRAWL_CONFIG.URL}/${market}?page=1&pageSize=${CRAWL_CONFIG.PAGE_SIZE}`;
    try {
      console.log(`[Request] ${url} 요청 시작`);
      const response = await axios.get(url, {
        headers: CRAWL_CONFIG.HEADERS,
        timeout: 10000,
      });

      const stocks: any[] = Array.isArray(response.data?.stocks) ? response.data.stocks : [];
      console.log(`[Parsing] ${market} ${stocks.length}개의 종목 데이터를 찾았습니다.`);

      stocks.forEach((stock, index) => {
        if (!stock?.itemCode || !stock?.stockName) return;

        stockList.push({
          rank: index + 1,
          code: stock.itemCode,
          name: stock.stockName,
          market,
          searchRatio: '',
          currentPrice: safeParseFloat(stock.closePriceRaw ?? stock.closePrice) ?? 0,
          priceChange:
            safeParseFloat(stock.compareToPreviousClosePriceRaw ?? stock.compareToPreviousClosePrice) ?? 0,
          changeRate: stock.fluctuationsRatio != null ? `${stock.fluctuationsRatio}%` : '',
          volume: safeParseFloat(stock.accumulatedTradingVolumeRaw ?? stock.accumulatedTradingVolume) ?? 0,
          openPrice: 0,
          highPrice: 0,
          lowPrice: 0,
          per: null,
          roe: null,
        });
      });
    } catch (error) {
      // 한 시장에서 오류가 나도 다른 시장 데이터는 반환
      if (axios.isAxiosError(error)) {
        console.error(`[Network Error] ${market} 크롤링 중 네트워크 오류 발생: ${error.message}`);
      } else {
        console.error(`[Unknown Error] ${market} 크롤링 중 알 수 없는 오류 발생:`, error);
      }
    }
  }

  console.log(`[Success] 총 ${stockList.length}개 종목 크롤링 완료`);
  return stockList;
}
