import assert from "node:assert/strict";
import test from "node:test";
import { FinanceOperationsEngine } from "./finance-engine.js";
import { COMMERCIAL_REQUIREMENT_TRACE } from "./requirement-trace.js";
import { SqliteCommercialOperationsRepository } from "./store.js";
import { SupplyOperationsEngine } from "./supply-engine.js";

test("B87-B102 trace has exactly 80 executable mandatory requirement bindings", () => {
  const entries = Object.entries(COMMERCIAL_REQUIREMENT_TRACE);
  assert.equal(entries.length, 80);
  const expected = Array.from({ length: 16 }, (_, batchIndex) =>
    Array.from({ length: 5 }, (_, requirementIndex) => `B${batchIndex + 87}-R0${requirementIndex + 1}`),
  ).flat().sort();
  assert.deepEqual(entries.map(([requirement]) => requirement).sort(), expected);
  for (const [requirement, binding] of entries) {
    const [owner, symbol] = binding.split(".");
    assert.ok(symbol, `${requirement} must name a concrete symbol`);
    const prototype = owner === "FinanceOperationsEngine" ? FinanceOperationsEngine.prototype :
      owner === "SupplyOperationsEngine" ? SupplyOperationsEngine.prototype :
        owner === "SqliteCommercialOperationsRepository" ? SqliteCommercialOperationsRepository.prototype : undefined;
    assert.ok(prototype !== undefined && typeof Reflect.get(prototype, symbol) === "function", `${requirement} binding ${binding} must be executable`);
  }
});
