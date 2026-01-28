import { z } from "zod";

// Option Contract Schema
export const optionContractSchema = z.object({
  contractID: z.string(),
  symbol: z.string(),
  expiration: z.string(),
  strike: z.number(),
  type: z.enum(["call", "put"]),
  last: z.number(),
  mark: z.number(),
  bid: z.number(),
  ask: z.number(),
  volume: z.number(),
  openInterest: z.number(),
  impliedVolatility: z.number(),
  delta: z.number().optional(),
  gamma: z.number().optional(),
  theta: z.number().optional(),
  vega: z.number().optional(),
});

export type OptionContract = z.infer<typeof optionContractSchema>;

// Options Chain Schema
export const optionsChainSchema = z.object({
  symbol: z.string(),
  underlyingPrice: z.number(),
  expirationDates: z.array(z.string()),
  calls: z.array(optionContractSchema),
  puts: z.array(optionContractSchema),
});

export type OptionsChain = z.infer<typeof optionsChainSchema>;

// Stock Quote Schema
export const stockQuoteSchema = z.object({
  symbol: z.string(),
  price: z.number(),
  change: z.number(),
  changePercent: z.number(),
  volume: z.number(),
  high: z.number(),
  low: z.number(),
  open: z.number(),
  previousClose: z.number(),
});

export type StockQuote = z.infer<typeof stockQuoteSchema>;

// Historical Price Data
export const priceDataPointSchema = z.object({
  date: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

export type PriceDataPoint = z.infer<typeof priceDataPointSchema>;

// Open Interest Analysis Point
export const openInterestAnalysisSchema = z.object({
  date: z.string(),
  strike: z.number(),
  callOI: z.number(),
  putOI: z.number(),
  callOIChange: z.number(),
  putOIChange: z.number(),
  callOISlope: z.number(),
  putOISlope: z.number(),
  stockPrice: z.number(),
});

export type OpenInterestAnalysis = z.infer<typeof openInterestAnalysisSchema>;

// API Response Types
export const searchSymbolResultSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  type: z.string(),
  region: z.string(),
  currency: z.string(),
});

export type SearchSymbolResult = z.infer<typeof searchSymbolResultSchema>;

// Keep existing user schema for template compatibility
import { sql } from "drizzle-orm";
import { pgTable, text, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
