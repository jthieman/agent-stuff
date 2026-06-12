import { describe, it, expect } from "vite-plus/test";
import { PostgresMetadataStore } from "../src/stores/postgres.ts";

describe("PostgresMetadataStore", () => {
  it("rejects unsafe table prefixes", () => {
    expect(
      () => new PostgresMetadataStore({ pool: {} as any, tablePrefix: 'bad"; DROP TABLE x; --' }),
    ).toThrow("Invalid Postgres tablePrefix");
  });

  it("allows safe table prefixes", () => {
    expect(
      () => new PostgresMetadataStore({ pool: {} as any, tablePrefix: "safe_123_" }),
    ).not.toThrow();
  });
});
