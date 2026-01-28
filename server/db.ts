import { Pool } from 'pg';

// Database configuration from environment variables
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'stock_insight_db',
  user: process.env.PGUSER || 'stock_user',
  password: process.env.PGPASSWORD,
});

// Test connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// Initialize database schema
export async function initializeDatabase() {
  const client = await pool.connect();
  try {
    // Create options_snapshots table to store historical option data
    await client.query(`
      CREATE TABLE IF NOT EXISTS options_snapshots (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(10) NOT NULL,
        contract_id VARCHAR(50) NOT NULL,
        strike DECIMAL(10, 2) NOT NULL,
        expiration_date DATE NOT NULL,
        option_type VARCHAR(4) NOT NULL CHECK (option_type IN ('call', 'put')),
        snapshot_date DATE NOT NULL,
        last_price DECIMAL(10, 4),
        bid DECIMAL(10, 4),
        ask DECIMAL(10, 4),
        mark DECIMAL(10, 4),
        volume INTEGER,
        open_interest INTEGER,
        implied_volatility DECIMAL(10, 6),
        delta DECIMAL(10, 6),
        gamma DECIMAL(10, 6),
        theta DECIMAL(10, 6),
        vega DECIMAL(10, 6),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(contract_id, snapshot_date)
      );
    `);

    // Create index for faster queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_options_symbol_date
      ON options_snapshots(symbol, snapshot_date);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_options_contract_date
      ON options_snapshots(contract_id, snapshot_date);
    `);

    console.log('Database schema initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Save options snapshot to database
export async function saveOptionsSnapshot(options: {
  symbol: string;
  contractID: string;
  strike: number;
  expiration: string;
  type: 'call' | 'put';
  snapshotDate: string;
  last: number;
  bid: number;
  ask: number;
  mark: number;
  volume: number;
  openInterest: number;
  impliedVolatility: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
}) {
  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO options_snapshots (
        symbol, contract_id, strike, expiration_date, option_type,
        snapshot_date, last_price, bid, ask, mark, volume,
        open_interest, implied_volatility, delta, gamma, theta, vega
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (contract_id, snapshot_date) DO UPDATE SET
        last_price = EXCLUDED.last_price,
        bid = EXCLUDED.bid,
        ask = EXCLUDED.ask,
        mark = EXCLUDED.mark,
        volume = EXCLUDED.volume,
        open_interest = EXCLUDED.open_interest,
        implied_volatility = EXCLUDED.implied_volatility,
        delta = EXCLUDED.delta,
        gamma = EXCLUDED.gamma,
        theta = EXCLUDED.theta,
        vega = EXCLUDED.vega
    `, [
      options.symbol,
      options.contractID,
      options.strike,
      options.expiration,
      options.type,
      options.snapshotDate,
      options.last,
      options.bid,
      options.ask,
      options.mark,
      options.volume,
      options.openInterest,
      options.impliedVolatility,
      options.delta || null,
      options.gamma || null,
      options.theta || null,
      options.vega || null,
    ]);
  } catch (error) {
    console.error('Error saving options snapshot:', error);
  } finally {
    client.release();
  }
}

// Get historical open interest for specific contracts
export async function getHistoricalOpenInterest(
  symbol: string,
  strikes: { strike: number; type: 'call' | 'put' }[],
  startDate: string,
  endDate: string
) {
  const client = await pool.connect();
  try {
    // Build query for multiple strikes
    // NOTE: Parameter indexing starts after $1 (symbol), $2 (startDate), $3 (endDate)
    const strikeConditions = strikes
      .map((_, idx) => `(strike = $${idx * 2 + 4} AND option_type = $${idx * 2 + 5})`)
      .join(' OR ');

    const values = [
      symbol,
      startDate,
      endDate,
      ...strikes.flatMap(s => [s.strike, s.type])
    ];

    // Select only the latest record per (contract_id, snapshot_date) to avoid duplicates
    const result = await client.query(`
      WITH latest AS (
        SELECT DISTINCT ON (contract_id, snapshot_date)
          symbol,
          contract_id,
          snapshot_date,
          strike,
          option_type,
          open_interest,
          implied_volatility,
          created_at
        FROM options_snapshots
        WHERE symbol = $1
          AND snapshot_date >= $2::date
          AND snapshot_date <= $3::date
          AND (${strikeConditions})
        ORDER BY contract_id, snapshot_date, created_at DESC
      )
      SELECT
        snapshot_date,
        strike,
        option_type,
        SUM(open_interest) AS total_open_interest,
        AVG(implied_volatility) AS avg_implied_volatility
      FROM latest
      GROUP BY snapshot_date, strike, option_type
      ORDER BY snapshot_date ASC
    `, values);

    return result.rows;
  } catch (error) {
    console.error('Error fetching historical open interest:', error);
    return [];
  } finally {
    client.release();
  }
}

// Get the latest snapshot per contract_id regardless of snapshot_date
export async function getLatestSnapshotsForContracts(contractIds: string[]) {
  if (!contractIds || contractIds.length === 0) return new Map<string, any>();

  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      SELECT DISTINCT ON (contract_id)
        contract_id,
        strike,
        option_type,
        expiration_date,
        snapshot_date,
        last_price,
        bid,
        ask,
        mark,
        volume,
        open_interest,
        implied_volatility,
        delta,
        gamma,
        theta,
        vega,
        created_at
      FROM options_snapshots
      WHERE contract_id = ANY($1::text[])
      ORDER BY contract_id, created_at DESC
      `,
      [contractIds]
    );

    const map = new Map<string, any>();
    for (const row of result.rows) {
      map.set(row.contract_id, row);
    }
    return map;
  } catch (error) {
    console.error('Error fetching latest snapshots for contracts:', error);
    return new Map<string, any>();
  } finally {
    client.release();
  }
}

// Get historical data statistics for a symbol
export async function getHistoricalDataStats(symbol: string) {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT
        symbol,
        COUNT(*) as total_snapshots,
        COUNT(DISTINCT snapshot_date) as unique_dates,
        MIN(snapshot_date) as earliest_date,
        MAX(snapshot_date) as latest_date,
        ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT snapshot_date), 0), 2) as avg_contracts_per_day
      FROM options_snapshots
      WHERE symbol = $1
      GROUP BY symbol
    `, [symbol]);

    if (result.rows.length === 0) {
      return {
        symbol,
        totalSnapshots: 0,
        uniqueDates: 0,
        dateRange: { earliest: null, latest: null },
        avgContractsPerDay: 0,
      };
    }

    const row = result.rows[0];
    return {
      symbol: row.symbol,
      totalSnapshots: parseInt(row.total_snapshots),
      uniqueDates: parseInt(row.unique_dates),
      dateRange: {
        earliest: row.earliest_date,
        latest: row.latest_date,
      },
      avgContractsPerDay: parseFloat(row.avg_contracts_per_day) || 0,
    };
  } catch (error) {
    console.error('Error fetching historical data stats:', error);
    return {
      symbol,
      totalSnapshots: 0,
      uniqueDates: 0,
      dateRange: { earliest: null, latest: null },
      avgContractsPerDay: 0,
    };
  } finally {
    client.release();
  }
}

export { pool };
