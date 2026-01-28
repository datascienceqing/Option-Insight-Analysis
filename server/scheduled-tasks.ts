import { log } from "./index";
import { saveOptionsSnapshot } from "./db";

const POLYGON_BASE_URL = "https://api.polygon.io";
const getPolygonKey = () => process.env.POLYGON_API_KEY;

// Popular symbols to fetch daily - matches frontend list
export const POPULAR_SYMBOLS = [
  // Major Indices & ETFs
  "SPY", "QQQ", "IWM", "DIA",
  // Mega Cap Tech
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA",
  // Tech & Semiconductors
  "AMD", "INTC", "CRM", "ORCL", "ADBE", "CSCO", "AVGO", "QCOM", "TXN",
  // Financial
  "JPM", "BAC", "WFC", "GS", "MS", "C", "V", "MA",
  // Healthcare & Biotech
  "JNJ", "UNH", "PFE", "ABBV", "MRK", "LLY", "TMO",
  // Consumer & Retail
  "WMT", "HD", "MCD", "NKE", "SBUX", "DIS", "NFLX",
  // Energy
  "XOM", "CVX", "COP",
  // Industrial
  "BA", "CAT", "GE",
  // Communication
  "T", "VZ"
];

// Fetch current price from Polygon (rate limited)
async function fetchCurrentPrice(symbol: string): Promise<number | null> {
  try {
    const prevCloseUrl = `${POLYGON_BASE_URL}/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${getPolygonKey()}`;
    const response = await fetch(prevCloseUrl);

    if (!response.ok) {
      log(`Failed to fetch price for ${symbol}: ${response.statusText}`, "scheduled-task");
      return null;
    }

    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      log(`No price data for ${symbol}`, "scheduled-task");
      return null;
    }

    return data.results[0].c;
  } catch (error) {
    log(`Error fetching price for ${symbol}: ${(error as Error).message}`, "scheduled-task");
    return null;
  }
}

// Fetch all prices with rate limiting (5 requests per minute = 12 second delay)
async function fetchAllPrices(symbols: string[]): Promise<Map<string, number>> {
  const priceMap = new Map<string, number>();
  const DELAY_MS = 12000; // 12 seconds between price requests

  log(`Fetching prices for ${symbols.length} symbols (rate limited)...`, "scheduled-task");

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const price = await fetchCurrentPrice(symbol);

    if (price) {
      priceMap.set(symbol, price);
    }

    // Add delay between requests (except for the last one)
    if (i < symbols.length - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }

    // Log progress every 10 symbols
    if ((i + 1) % 10 === 0 || i === symbols.length - 1) {
      log(`Price fetch progress: ${i + 1}/${symbols.length} completed`, "scheduled-task");
    }
  }

  log(`Fetched ${priceMap.size}/${symbols.length} prices successfully`, "scheduled-task");
  return priceMap;
}

// Fetch options chain for a single symbol (unlimited API calls)
async function fetchOptionsChainForSymbol(symbol: string, currentPrice: number): Promise<boolean> {
  try {
    log(`Fetching options for ${symbol}...`, "scheduled-task");

    // Get options contracts for next 60 days
    const today = new Date();
    const expirationGte = today.toISOString().split("T")[0];
    const expiration60Days = new Date(today);
    expiration60Days.setDate(today.getDate() + 60);
    const expirationLte = expiration60Days.toISOString().split("T")[0];

    const contractsUrl = `${POLYGON_BASE_URL}/v3/reference/options/contracts?underlying_ticker=${symbol}&expiration_date.gte=${expirationGte}&expiration_date.lte=${expirationLte}&limit=250&apiKey=${getPolygonKey()}`;

    const response = await fetch(contractsUrl);
    if (!response.ok) {
      log(`Failed to fetch contracts for ${symbol}: ${response.statusText}`, "scheduled-task");
      return false;
    }

    const data = await response.json();

    if (data.status === "ERROR" || !data.results || data.results.length === 0) {
      log(`No options contracts for ${symbol}`, "scheduled-task");
      return false;
    }

    // Fetch snapshot data for pricing and open interest
    const snapshotUrl = `${POLYGON_BASE_URL}/v3/snapshot/options/${symbol}?limit=250&apiKey=${getPolygonKey()}`;

    const snapshotResponse = await fetch(snapshotUrl);
    if (!snapshotResponse.ok) {
      log(`Failed to fetch snapshot for ${symbol}: ${snapshotResponse.statusText}`, "scheduled-task");
      return false;
    }

    const snapshotData = await snapshotResponse.json();

    if (!snapshotData.results) {
      log(`No snapshot data for ${symbol}`, "scheduled-task");
      return false;
    }

    // Create a map of contract ticker to snapshot data
    const snapshotMap = new Map<string, any>();
    for (const snap of snapshotData.results) {
      snapshotMap.set(snap.details?.ticker, snap);
    }

    // Save all contracts to database
    const today_str = today.toISOString().split('T')[0];
    let savedCount = 0;

    for (const contract of data.results) {
      const snap = snapshotMap.get(contract.ticker);
      if (!snap) continue; // Skip if no snapshot data

      await saveOptionsSnapshot({
        symbol: symbol,
        contractID: contract.ticker,
        strike: contract.strike_price,
        expiration: contract.expiration_date,
        type: contract.contract_type === "call" ? "call" : "put",
        snapshotDate: today_str,
        last: snap.day?.close || snap.last_trade?.price || 0,
        bid: snap.last_quote?.bid || 0,
        ask: snap.last_quote?.ask || 0,
        mark: ((snap.last_quote?.bid || 0) + (snap.last_quote?.ask || 0)) / 2 || snap.day?.close || 0,
        volume: snap.day?.volume || 0,
        openInterest: snap.open_interest || 0,
        impliedVolatility: snap.implied_volatility || 0,
        delta: snap.greeks?.delta || 0,
        gamma: snap.greeks?.gamma || 0,
        theta: snap.greeks?.theta || 0,
        vega: snap.greeks?.vega || 0,
      });

      savedCount++;
    }

    log(`Saved ${savedCount} contracts for ${symbol}`, "scheduled-task");
    return true;
  } catch (error) {
    log(`Error fetching options for ${symbol}: ${(error as Error).message}`, "scheduled-task");
    return false;
  }
}

// Main function to fetch all popular symbols (no rate limiting needed)
export async function fetchAllPopularSymbolsData() {
  if (!getPolygonKey()) {
    log("No Polygon API key configured, skipping scheduled data fetch", "scheduled-task");
    return;
  }

  log(`Starting daily options data fetch for ${POPULAR_SYMBOLS.length} popular symbols...`, "scheduled-task");
  const startTime = Date.now();

  // Process symbols with concurrency limit to avoid overwhelming the system
  const CONCURRENT_LIMIT = 5; // Process 5 symbols at a time
  let successCount = 0;
  let failCount = 0;

  // Process in batches
  for (let i = 0; i < POPULAR_SYMBOLS.length; i += CONCURRENT_LIMIT) {
    const batch = POPULAR_SYMBOLS.slice(i, i + CONCURRENT_LIMIT);

    log(`Processing batch ${Math.floor(i / CONCURRENT_LIMIT) + 1}/${Math.ceil(POPULAR_SYMBOLS.length / CONCURRENT_LIMIT)}: ${batch.join(', ')}`, "scheduled-task");

    const results = await Promise.allSettled(
      batch.map(symbol => fetchOptionsChainForSymbol(symbol))
    );

    results.forEach((result, idx) => {
      if (result.status === 'fulfilled' && result.value) {
        successCount++;
      } else {
        failCount++;
        if (result.status === 'rejected') {
          log(`Failed to process ${batch[idx]}: ${result.reason}`, "scheduled-task");
        }
      }
    });

    log(`Completed ${Math.min(i + CONCURRENT_LIMIT, POPULAR_SYMBOLS.length)}/${POPULAR_SYMBOLS.length} symbols`, "scheduled-task");
  }

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
  log(`Daily options fetch completed in ${duration} minutes. Success: ${successCount}, Failed: ${failCount}`, "scheduled-task");
}

// Schedule daily fetch at a specific time (default: 6 PM ET / 18:00 ET)
export function scheduleDailyFetch() {
  const FETCH_HOUR = parseInt(process.env.DAILY_FETCH_HOUR || "18", 10); // 6 PM ET by default

  function getNextFetchTime(): Date {
    const now = new Date();
    const next = new Date();
    next.setHours(FETCH_HOUR, 0, 0, 0);

    // If the scheduled time has passed today, schedule for tomorrow
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    return next;
  }

  function scheduleNext() {
    const nextRun = getNextFetchTime();
    const msUntilNext = nextRun.getTime() - Date.now();

    log(`Next daily fetch scheduled for ${nextRun.toLocaleString()}`, "scheduled-task");

    setTimeout(async () => {
      await fetchAllPopularSymbolsData();
      scheduleNext(); // Schedule the next run
    }, msUntilNext);
  }

  scheduleNext();
}

// Run fetch immediately on startup if it hasn't run today
export async function runStartupFetch() {
  // Check if we should run on startup based on environment variable
  const RUN_ON_STARTUP = process.env.FETCH_ON_STARTUP !== "false"; // Default to true

  if (!RUN_ON_STARTUP) {
    log("Startup fetch disabled by FETCH_ON_STARTUP env variable", "scheduled-task");
    return;
  }

  log("Running startup options data fetch...", "scheduled-task");
  await fetchAllPopularSymbolsData();
}
