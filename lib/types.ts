import type postgres from "postgres";

/** The Postgres client (postgres.js) shared by every module. */
export type Sql = postgres.Sql;

/** A memory as tools read and print it. The vector and the full-text column never leave the database. */
export interface MemoryRow {
  id: string;
  content: string;
  category: string;
  tags: string[];
  source_agent: string;
  created_at: Date;
  updated_at: Date;
}

export interface SimilarRow extends MemoryRow {
  similarity: number;
}

export interface SearchRow extends MemoryRow {
  score: number;
  similarity: number | null;
}

export interface Stats {
  total: number;
  withoutEmbedding: number;
  byAgent: [string, number][];
  byCategory: [string, number][];
}
