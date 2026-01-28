import type { Express } from "express";
import { createServer, type Server } from "http";
import type {
  StockQuote,
  OptionsChain,
  OptionContract,
  PriceDataPoint,
  OpenInterestAnalysis,
  SearchSymbolResult
} from "@shared/schema";
import { saveOptionsSnapshot, getHistoricalOpenInterest, getHistoricalDataStats, getLatestSnapshotsForContracts } from "./db";

const BASE_URL = "https://www.alphavantage.co/query";
const POLYGON_BASE_URL = "https://api.polygon.io";

// Get API keys - must be functions to ensure they're read after dotenv loads
const getAlphaVantageKey = () => process.env.ALPHA_VANTAGE_API_KEY || "demo";
const getPolygonKey = () => process.env.POLYGON_API_KEY;

// Cache for API responses (to avoid hitting rate limits)
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function fetchWithCache(url: string): Promise<any> {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const data = await response.json();

    // Check for API error messages
    if (data["Error Message"]) {
      throw new Error(data["Error Message"]);
    }
    if (data["Note"]) {
      throw new Error("API rate limit reached. Please wait a few seconds and try again.");
    }
    // Check for rate limit information message
    if (data["Information"] && data["Information"].includes("rate limit")) {
      throw new Error("API rate limit reached. The free tier allows 5 requests per minute. Please wait a few seconds and try again.");
    }

    cache.set(url, { data, timestamp: Date.now() });
    return data;
  } catch (error) {
    console.warn("API fetch failed:", (error as Error).message);
    throw error;
  }
}


// Fetch options data from Polygon.io
async function fetchPolygonOptionsChain(symbol: string, currentPrice: number): Promise<OptionsChain | null> {
  if (!getPolygonKey()) {
    console.log("No Polygon API key available");
    return null;
  }

  try {
    // Get options contracts for this underlying
    const today = new Date();
    const expirationGte = today.toISOString().split("T")[0];
    const expiration60Days = new Date(today);
    expiration60Days.setDate(today.getDate() + 60);
    const expirationLte = expiration60Days.toISOString().split("T")[0];

    const contractsUrl = `${POLYGON_BASE_URL}/v3/reference/options/contracts?underlying_ticker=${symbol}&expiration_date.gte=${expirationGte}&expiration_date.lte=${expirationLte}&limit=250&apiKey=${getPolygonKey()}`;
    
    const response = await fetch(contractsUrl);
    if (!response.ok) {
      console.warn("Polygon API request failed:", response.status, response.statusText);
      return null;
    }

    const data = await response.json();
    
    if (data.status === "ERROR" || !data.results || data.results.length === 0) {
      console.warn("Polygon returned no options contracts:", data.message || "No results");
      return null;
    }

    const calls: OptionContract[] = [];
    const puts: OptionContract[] = [];
    const expirationSet = new Set<string>();

    // Process contracts
    for (const contract of data.results) {
      const expDate = contract.expiration_date;
      expirationSet.add(expDate);

      const optionContract: OptionContract = {
        contractID: contract.ticker,
        symbol: symbol,
        expiration: expDate,
        strike: contract.strike_price,
        type: contract.contract_type === "call" ? "call" : "put",
        last: 0,
        mark: 0,
        bid: 0,
        ask: 0,
        volume: 0,
        openInterest: 0,
        impliedVolatility: 0,
        delta: 0,
        gamma: 0,
        theta: 0,
        vega: 0,
      };

      if (contract.contract_type === "call") {
        calls.push(optionContract);
      } else {
        puts.push(optionContract);
      }
    }

    // Fetch snapshot data for pricing and open interest (batch by first expiration)
    const expirationDates = Array.from(expirationSet).sort();
    const firstExpiration = expirationDates[0];
    
    // Get snapshot for all options of this underlying
    const snapshotUrl = `${POLYGON_BASE_URL}/v3/snapshot/options/${symbol}?limit=250&apiKey=${getPolygonKey()}`;
    
    try {
      const snapshotResponse = await fetch(snapshotUrl);
      if (snapshotResponse.ok) {
        const snapshotData = await snapshotResponse.json();
        
        if (snapshotData.results) {
          const snapshotMap = new Map<string, any>();
          for (const snap of snapshotData.results) {
            snapshotMap.set(snap.details?.ticker, snap);
          }

          // Update contracts with snapshot data
          for (const contract of [...calls, ...puts]) {
            const snap = snapshotMap.get(contract.contractID);
            if (snap) {
              contract.last = snap.day?.close || snap.last_trade?.price || 0;
              contract.bid = snap.last_quote?.bid || 0;
              contract.ask = snap.last_quote?.ask || 0;
              contract.mark = (contract.bid + contract.ask) / 2 || contract.last;
              contract.volume = snap.day?.volume || 0;
              contract.openInterest = snap.open_interest || 0;
              contract.impliedVolatility = snap.implied_volatility || 0;
              
              if (snap.greeks) {
                contract.delta = snap.greeks.delta || 0;
                contract.gamma = snap.greeks.gamma || 0;
                contract.theta = snap.greeks.theta || 0;
                contract.vega = snap.greeks.vega || 0;
              }
            }
          }
        }
      }
    } catch (snapshotError) {
      console.warn("Failed to fetch options snapshot:", snapshotError);
    }

    console.log(`Polygon: Found ${calls.length} calls and ${puts.length} puts for ${symbol}`);

    return {
      symbol,
      underlyingPrice: currentPrice,
      expirationDates,
      calls: calls.sort((a, b) => a.strike - b.strike),
      puts: puts.sort((a, b) => a.strike - b.strike),
    };
  } catch (error) {
    console.error("Polygon options fetch error:", error);
    return null;
  }
}

// Generate analysis from real historical database data
function generateRealAnalysisData(
  historicalOI: any[],
  strikes: { strike: number; type: "call" | "put" }[],
  priceHistory: PriceDataPoint[]
): OpenInterestAnalysis[] {
  const data: OpenInterestAnalysis[] = [];

  // Create a map of dates to prices
  const priceMap = new Map(priceHistory.map(p => [p.date, p.close]));

  // Group historical OI by date
  const dateGroups = new Map<string, any[]>();
  for (const row of historicalOI) {
    const date = row.snapshot_date;
    if (!dateGroups.has(date)) {
      dateGroups.set(date, []);
    }
    dateGroups.get(date)!.push(row);
  }

  // Sort dates
  const sortedDates = Array.from(dateGroups.keys()).sort();

  // Calculate analysis for each date
  let prevCallOI = 0;
  let prevPutOI = 0;

  for (const date of sortedDates) {
    const dayData = dateGroups.get(date)!;

    // Sum up OI for all selected strikes
    const callOI = dayData
      .filter(d => d.option_type === 'call')
      .reduce((sum, d) => sum + (parseInt(d.total_open_interest) || 0), 0);

    const putOI = dayData
      .filter(d => d.option_type === 'put')
      .reduce((sum, d) => sum + (parseInt(d.total_open_interest) || 0), 0);

    const callOIChange = prevCallOI > 0 ? callOI - prevCallOI : 0;
    const putOIChange = prevPutOI > 0 ? putOI - prevPutOI : 0;

    const callOISlope = prevCallOI > 0 ? callOIChange / prevCallOI : 0;
    const putOISlope = prevPutOI > 0 ? putOIChange / prevPutOI : 0;

    const avgStrike = strikes.reduce((sum, s) => sum + s.strike, 0) / strikes.length;
    const stockPrice = priceMap.get(date) || avgStrike;

    data.push({
      date,
      strike: avgStrike,
      callOI,
      putOI,
      callOIChange,
      putOIChange,
      callOISlope,
      putOISlope,
      stockPrice,
    });

    prevCallOI = callOI;
    prevPutOI = putOI;
  }

  return data;
}

// Generate mock historical analysis data
function generateMockAnalysisData(
  symbol: string,
  strikes: { strike: number; type: "call" | "put" }[],
  priceHistory: PriceDataPoint[]
): OpenInterestAnalysis[] {
  const data: OpenInterestAnalysis[] = [];

  // Count selected calls and puts
  const selectedCalls = strikes.filter(s => s.type === "call");
  const selectedPuts = strikes.filter(s => s.type === "put");
  const numCalls = Math.max(1, selectedCalls.length);
  const numPuts = Math.max(1, selectedPuts.length);

  // Generate historical data using last 30 days from price history
  let prevCallOI = Math.floor(Math.random() * 10000 + 5000) * numCalls;
  let prevPutOI = Math.floor(Math.random() * 8000 + 4000) * numPuts;

  // Use only the last 30 trading days from price history
  const recentPriceHistory = priceHistory.slice(-30);

  for (let i = 0; i < recentPriceHistory.length; i++) {
    const pricePoint = recentPriceHistory[i];
    const price = pricePoint.close;

    // Simulate OI changes with some trend - scale by number of selected strikes
    const oiTrend = Math.sin(i / 10) * 500;
    const callOIChange = Math.floor((Math.random() - 0.45) * 1000 * numCalls + oiTrend);
    const putOIChange = Math.floor((Math.random() - 0.55) * 800 * numPuts - oiTrend * 0.5);

    const callOI = Math.max(100, prevCallOI + callOIChange);
    const putOI = Math.max(100, prevPutOI + putOIChange);

    // Calculate slopes (rate of change)
    const callOISlope = callOIChange / (prevCallOI || 1);
    const putOISlope = putOIChange / (prevPutOI || 1);

    // Average strike of selected options
    const avgStrike = strikes.reduce((sum, s) => sum + s.strike, 0) / strikes.length || price;

    data.push({
      date: pricePoint.date,
      strike: avgStrike,
      callOI,
      putOI,
      callOIChange,
      putOIChange,
      callOISlope,
      putOISlope,
      stockPrice: price,
    });

    prevCallOI = callOI;
    prevPutOI = putOI;
  }

  return data;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // Search for symbols
  app.get("/api/search", async (req, res) => {
    try {
      const query = req.query.query as string;
      if (!query) {
        return res.json([]);
      }

      const url = `${BASE_URL}?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(query)}&apikey=${getAlphaVantageKey()}`;
      const data = await fetchWithCache(url);

      const results: SearchSymbolResult[] = (data.bestMatches || []).map((match: any) => ({
        symbol: match["1. symbol"],
        name: match["2. name"],
        type: match["3. type"],
        region: match["4. region"],
        currency: match["8. currency"],
      }));

      res.json(results.slice(0, 10));
    } catch (error) {
      console.error("Search error:", error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Get stock quote from Polygon.io
  app.get("/api/quote/:symbol", async (req, res) => {
    try {
      const { symbol } = req.params;

      if (!getPolygonKey()) {
        throw new Error("Polygon API key is not configured.");
      }

      // Get previous close for calculating change
      const prevCloseUrl = `${POLYGON_BASE_URL}/v2/aggs/ticker/${symbol.toUpperCase()}/prev?adjusted=true&apiKey=${getPolygonKey()}`;
      const prevCloseResponse = await fetch(prevCloseUrl);

      if (!prevCloseResponse.ok) {
        throw new Error(`Unable to fetch data for symbol ${symbol}. Please verify the symbol is valid.`);
      }

      const prevCloseData = await prevCloseResponse.json();

      if (!prevCloseData.results || prevCloseData.results.length === 0) {
        throw new Error(`No quote data available for symbol ${symbol}. Please verify the symbol is valid.`);
      }

      const prevBar = prevCloseData.results[0];
      const result: StockQuote = {
        symbol: symbol.toUpperCase(),
        price: prevBar.c,
        change: prevBar.c - prevBar.o,
        changePercent: ((prevBar.c - prevBar.o) / prevBar.o) * 100,
        volume: prevBar.v,
        high: prevBar.h,
        low: prevBar.l,
        open: prevBar.o,
        previousClose: prevBar.c,
      };

      res.json(result);
    } catch (error) {
      console.error("Quote error:", error);
      res.status(404).json({ error: (error as Error).message });
    }
  });

  // Get options chain from Polygon.io
  app.get("/api/options/:symbol", async (req, res) => {
    try {
      const { symbol } = req.params;

      if (!getPolygonKey()) {
        throw new Error("Polygon API key is not configured. Options data is not available.");
      }

      // Get current price from Polygon.io
      const prevCloseUrl = `${POLYGON_BASE_URL}/v2/aggs/ticker/${symbol.toUpperCase()}/prev?adjusted=true&apiKey=${getPolygonKey()}`;
      const prevCloseResponse = await fetch(prevCloseUrl);

      if (!prevCloseResponse.ok) {
        throw new Error(`Unable to fetch current price for ${symbol}. Please verify the symbol is valid.`);
      }

      const prevCloseData = await prevCloseResponse.json();

      if (!prevCloseData.results || prevCloseData.results.length === 0) {
        throw new Error(`Unable to fetch current price for ${symbol}. Please verify the symbol is valid.`);
      }

  const currentPrice = prevCloseData.results[0].c;

  // Get options data from Polygon.io
  const polygonData = await fetchPolygonOptionsChain(symbol.toUpperCase(), currentPrice);
  if (polygonData && polygonData.calls.length > 0) {
    console.log(`Using real Polygon.io data for ${symbol}`);

    // Save options data to database for historical tracking
    const today = new Date().toISOString().split('T')[0];
    const allContracts = [...polygonData.calls, ...polygonData.puts];

    // Save in background, don't wait
    Promise.all(allContracts.map(contract =>
      saveOptionsSnapshot({
        symbol: polygonData.symbol,
        contractID: contract.contractID,
        strike: contract.strike,
        expiration: contract.expiration,
        type: contract.type,
        snapshotDate: today,
        last: contract.last,
        bid: contract.bid,
        ask: contract.ask,
        mark: contract.mark,
        volume: contract.volume,
        openInterest: contract.openInterest,
        impliedVolatility: contract.impliedVolatility,
        delta: contract.delta,
        gamma: contract.gamma,
        theta: contract.theta,
        vega: contract.vega,
      })
    )).catch(err => console.error('Error saving options to database:', err));

    // Overlay latest DB snapshot values onto the response without affecting saved data
    try {
      const ids = allContracts.map(c => c.contractID);
      const latestMap = await getLatestSnapshotsForContracts(ids);

      const toDisplay = (c: OptionContract): OptionContract => {
        const row = latestMap.get(c.contractID);
        if (!row) return c;
        return {
          ...c,
          last: Number(row.last_price) || c.last,
          bid: Number(row.bid) || c.bid,
          ask: Number(row.ask) || c.ask,
          mark: Number(row.mark) || ((Number(row.bid) + Number(row.ask)) / 2) || c.mark,
          volume: Number(row.volume) || c.volume,
          openInterest: Number(row.open_interest) || c.openInterest,
          impliedVolatility: Number(row.implied_volatility) || c.impliedVolatility,
          delta: row.delta !== null ? Number(row.delta) : c.delta,
          gamma: row.gamma !== null ? Number(row.gamma) : c.gamma,
          theta: row.theta !== null ? Number(row.theta) : c.theta,
          vega: row.vega !== null ? Number(row.vega) : c.vega,
        };
      };

      const displayData: OptionsChain = {
        symbol: polygonData.symbol,
        underlyingPrice: polygonData.underlyingPrice,
        expirationDates: polygonData.expirationDates,
        calls: polygonData.calls.map(toDisplay),
        puts: polygonData.puts.map(toDisplay),
      };

      return res.json(displayData);
    } catch (overlayError) {
      console.warn('Failed to overlay latest DB snapshots, returning Polygon data:', overlayError);
      return res.json(polygonData);
    }
  }

      // No options data available
      throw new Error(`No options data available for symbol ${symbol}. The symbol may not have listed options or the API returned no results.`);
    } catch (error) {
      console.error("Options error:", error);
      res.status(404).json({ error: (error as Error).message });
    }
  });

  // Get price history from Polygon.io
  app.get("/api/price-history/:symbol", async (req, res) => {
    try {
      const { symbol } = req.params;

      if (!getPolygonKey()) {
        throw new Error("Polygon API key is not configured.");
      }

      // Get last 60 days of data
      const to = new Date();
      const from = new Date();
      from.setDate(to.getDate() - 60);

      const fromStr = from.toISOString().split('T')[0];
      const toStr = to.toISOString().split('T')[0];

      const url = `${POLYGON_BASE_URL}/v2/aggs/ticker/${symbol.toUpperCase()}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=asc&apiKey=${getPolygonKey()}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Unable to fetch price history for ${symbol}. Please verify the symbol is valid.`);
      }

      const data = await response.json();

      if (!data.results || data.results.length === 0) {
        throw new Error(`No price history data available for symbol ${symbol}. Please verify the symbol is valid.`);
      }

      const result: PriceDataPoint[] = data.results.map((bar: any) => ({
        date: new Date(bar.t).toISOString().split('T')[0],
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
        volume: bar.v,
      }));

      res.json(result);
    } catch (error) {
      console.error("Price history error:", error);
      res.status(404).json({ error: (error as Error).message });
    }
  });

  // Get open interest analysis for selected strikes
  app.get("/api/analysis/:symbol", async (req, res) => {
    try {
      const { symbol } = req.params;
      const strikesParam = req.query.strikes as string;

      if (!strikesParam) {
        return res.json([]);
      }

      // Parse strikes from query param
      const strikes = strikesParam.split(",").map((s) => {
        const [strike, type] = s.split("-");
        return { strike: parseFloat(strike), type: type as "call" | "put" };
      });

      if (!getPolygonKey()) {
        throw new Error("Polygon API key is not configured.");
      }

      // Get price history from Polygon.io (last 60 days)
      const to = new Date();
      const from = new Date();
      from.setDate(to.getDate() - 60);

      const fromStr = from.toISOString().split('T')[0];
      const toStr = to.toISOString().split('T')[0];

      const url = `${POLYGON_BASE_URL}/v2/aggs/ticker/${symbol.toUpperCase()}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=asc&apiKey=${getPolygonKey()}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Unable to fetch price history for ${symbol} to generate analysis.`);
      }

      const data = await response.json();

      if (!data.results || data.results.length === 0) {
        throw new Error(`No price history data available for ${symbol} to generate analysis.`);
      }

      const priceHistory: PriceDataPoint[] = data.results.map((bar: any) => ({
        date: new Date(bar.t).toISOString().split('T')[0],
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
        volume: bar.v,
      }));

      // Try to get historical open interest data from database
      const historicalOI = await getHistoricalOpenInterest(
        symbol.toUpperCase(),
        strikes,
        fromStr,
        toStr
      );

      let analysisData: OpenInterestAnalysis[];

      // Use real data if we have at least 5 days of historical data
      if (historicalOI.length >= 5) {
        console.log(`Using real historical OI data for ${symbol} (${historicalOI.length} data points)`);
        analysisData = generateRealAnalysisData(historicalOI, strikes, priceHistory);
      } else {
        console.log(`Not enough historical data for ${symbol}, using simulated data (${historicalOI.length} data points in DB)`);
        analysisData = generateMockAnalysisData(symbol.toUpperCase(), strikes, priceHistory);
      }

      res.json(analysisData);
    } catch (error) {
      console.error("Analysis error:", error);
      res.status(404).json({ error: (error as Error).message });
    }
  });

  // Get historical data statistics
  app.get("/api/historical-stats/:symbol", async (req, res) => {
    try {
      const { symbol } = req.params;
      const stats = await getHistoricalDataStats(symbol.toUpperCase());
      res.json(stats);
    } catch (error) {
      console.error("Historical stats error:", error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  return httpServer;
}
