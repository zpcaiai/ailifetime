import { Pool } from "pg";
import {
  PostgresCommerceFinanceRepository,
  type CommerceFinanceRepository,
} from "@ltm/commerce-platform";
import {
  PostgresGrowthOperationsRepository,
  type GrowthOperationsRepository,
} from "@ltm/growth-operations-platform";
import {
  PostgresPartnerSettlementRepository,
  type PartnerSettlementRepository,
} from "@ltm/partner-channel-platform";
import {
  PostgresMessageJournalStore,
  PostgresProviderExecutionStore,
  PostgresTransactionExecutor,
  type MessageJournalStore,
  type ProviderExecutionStore,
} from "@ltm/orchestration-platform";
import {
  PostgresTrackingQueueRepository,
  PostgresWarehouseStateRepository,
} from "@ltm/data-intelligence";

export interface ProductionDomainStores {
  readonly commerce: CommerceFinanceRepository;
  readonly growth: GrowthOperationsRepository;
  readonly partner: PartnerSettlementRepository;
  readonly orchestration: {
    readonly journal: MessageJournalStore;
    readonly providerExecutions: ProviderExecutionStore;
  };
  readonly data: {
    readonly trackingQueue: PostgresTrackingQueueRepository;
    readonly warehouse: PostgresWarehouseStateRepository;
  };
}

/** Shared production composition root for bounded-context durable stores. */
export class ProductionDomainRuntime {
  readonly #pool: Pool;
  readonly #sql: PostgresTransactionExecutor;

  constructor(connectionString: string, options: { readonly applicationName?: string; readonly poolMax?: number } = {}) {
    if (!/^postgres(?:ql):\/\//u.test(connectionString) || !connectionString.includes("sslmode=verify-full")) {
      throw new Error("production domain runtime requires a verify-full PostgreSQL connection");
    }
    this.#pool = new Pool({ connectionString, application_name: options.applicationName ?? "ltm-api-domain-runtime", max: options.poolMax ?? 10 });
    this.#sql = new PostgresTransactionExecutor(this.#pool);
  }

  forTenant(tenantId: string): ProductionDomainStores {
    if (tenantId.trim() === "") throw new Error("tenantId is required for production domain stores");
    return Object.freeze({
      commerce: new PostgresCommerceFinanceRepository(this.#pool),
      growth: new PostgresGrowthOperationsRepository(this.#pool),
      partner: new PostgresPartnerSettlementRepository(this.#pool),
      orchestration: {
        journal: new PostgresMessageJournalStore(this.#sql, tenantId),
        providerExecutions: new PostgresProviderExecutionStore(this.#sql, tenantId),
      },
      data: {
        trackingQueue: new PostgresTrackingQueueRepository(this.#pool),
        warehouse: new PostgresWarehouseStateRepository(this.#pool, tenantId),
      },
    });
  }

  async readiness(): Promise<{ readonly ready: boolean; readonly database: string; readonly schemaVersion: string | null }> {
    try {
      const result = await this.#pool.query<{ value: string }>("SELECT value FROM ltm.schema_metadata WHERE key='runtime_schema_version'");
      const schemaVersion = result.rows[0]?.value ?? null;
      return Object.freeze({ ready: schemaVersion === "7", database: "postgresql", schemaVersion });
    } catch {
      return Object.freeze({ ready: false, database: "postgresql", schemaVersion: null });
    }
  }

  async close(): Promise<void> { await this.#pool.end(); }
}
