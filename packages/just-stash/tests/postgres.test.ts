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

  it("rejects table prefixes that would exceed Postgres identifier length", () => {
    expect(
      () => new PostgresMetadataStore({ pool: {} as any, tablePrefix: "a".repeat(57) }),
    ).toThrow("Generated identifier names must be 63 characters or fewer");
  });

  it("rejects empty namespaces", () => {
    expect(() => new PostgresMetadataStore({ pool: {} as any, namespace: "" })).toThrow(
      "Invalid Postgres namespace",
    );
  });

  it("allows namespaces that are not SQL identifiers", () => {
    expect(
      () => new PostgresMetadataStore({ pool: {} as any, namespace: "tenant/repo:main" }),
    ).not.toThrow();
  });
});
