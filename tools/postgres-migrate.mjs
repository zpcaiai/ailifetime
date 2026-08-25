#!/usr/bin/env node
import { main } from "../services/migrator/src/main.mjs";

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: "FAIL",
    code: typeof error?.code === "string" ? error.code : "POSTGRES_MIGRATION_FAILED",
    error: error instanceof Error ? error.name : "UnknownError",
  })}\n`);
  process.exitCode = 1;
});
