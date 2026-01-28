# Option Insight Analysis

Open-interest analytics and options chain viewer for equities. It fetches Polygon.io data, persists daily snapshots in Postgres, and renders charts and tables in a React + Vite client.

## Features

- Options Chain table that shows the latest snapshot values per contract.
- Open Interest Analysis with OI trend, daily change, and slope tabs.
- Real OI when sufficient historical snapshots exist; otherwise mock OI is simulated.
- Daily background job to fetch and store popular symbols.

## Tech Stack

- Server: Node.js, Express, Drizzle ORM, Postgres
- Client: React, Vite, Tailwind CSS, Recharts
- Data: Polygon.io (prices and options chain)

## Requirements

- Node.js 20+
- PostgreSQL 14+ (locally or hosted)
- Polygon.io API key

## Quick Start

1. Clone and install:

   ```bash
   git clone <your-repo-url>
   cd Option-Insight-Analysis
   npm install
   ```

2. Configure environment:

   Create `.env` in the project root with:

   ```bash
   DATABASE_URL=postgres://<user>:<pass>@localhost:5432/<db>
   POLYGON_API_KEY=<your-polygon-key>
   NODE_ENV=development
   PORT=5000
   ```

3. Initialize the database schema:

   ```bash
   npm run db:push  (not tested)
   ```

4. Run the app in development:

   ```bash
   npm run dev
   ```

   The server hosts both API and client on `http://localhost:5000`.

## Build & Run (Production)

```bash
npm run build
npm start
```

## Notes

- If you see a PostCSS warning about missing `from`, it comes from plugins emitting virtual CSS during dev. It’s harmless for most setups.
- Mock OI appears until the background job accumulates daily snapshots for selected strikes.

## License

MIT