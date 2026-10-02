import type {
  ExternalCatalogCapability,
  ExternalCatalogContext,
  ExternalCatalogProvider,
  ExternalCatalogReference,
  ExternalCatalogResolution,
  ExternalCatalogSearchRequest,
  ExternalCatalogSearchResult,
  FederatedSkillCandidate,
} from "../../scripts/modules/application/ports/external-catalog-provider.ts";

export type FakeCatalogProviderConfig = Readonly<{
  id?: string;
  capabilities?: readonly ExternalCatalogCapability[];
  candidates?: readonly FederatedSkillCandidate[];
  failure?: Error;
}>;

/**
 * In-memory `ExternalCatalogProvider` used to prove that federated search
 * depends only on the port contract, never on a concrete integration.
 */
export class FakeCatalogProvider implements ExternalCatalogProvider {
  readonly id: string;
  readonly capabilities: readonly ExternalCatalogCapability[];
  readonly searchCalls: ExternalCatalogSearchRequest[] = [];

  readonly #candidates: readonly FederatedSkillCandidate[];
  readonly #failure: Error | undefined;

  constructor(config: FakeCatalogProviderConfig = {}) {
    this.id = config.id ?? "fake";
    this.capabilities = config.capabilities ?? ["search"];
    this.#candidates = config.candidates ?? [];
    this.#failure = config.failure;
  }

  async search(
    request: ExternalCatalogSearchRequest,
    _context: ExternalCatalogContext,
  ): Promise<ExternalCatalogSearchResult> {
    this.searchCalls.push(request);
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    return { candidates: this.#candidates };
  }

  async resolve(
    reference: ExternalCatalogReference,
    _context: ExternalCatalogContext,
  ): Promise<ExternalCatalogResolution> {
    return { reference, sourceType: "github", installable: false };
  }
}
