import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
      git: "src/backends/git.ts",
      blob: "src/backends/blob.ts",
      azure: "src/stores/azure.ts",
      sqlite: "src/stores/sqlite.ts",
      postgres: "src/stores/postgres.ts",
      s3: "src/stores/s3.ts",
      pi: "src/pi.ts",
      doctor: "src/doctor.ts",
      cloudflare: "src/cloudflare-artifacts.ts",
    },
    dts: {
      tsgo: true,
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
