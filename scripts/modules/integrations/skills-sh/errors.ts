/**
 * Error codes for external catalog integrations.
 *
 * Integration failures must never break offline local commands. Callers catch
 * `CatalogIntegrationError` (or generic errors) and degrade to warnings; the
 * local catalog, validation, doctor, sync, and rollback flows stay functional
 * when any external catalog is unavailable.
 */

export type CatalogIntegrationErrorCode =
  | "CATALOG_AUTH_REQUIRED"
  | "CATALOG_RATE_LIMITED"
  | "CATALOG_UNAVAILABLE"
  | "CATALOG_RESPONSE_INVALID"
  | "CATALOG_RESULT_STALE"
  | "CATALOG_SOURCE_UNRESOLVED"
  | "CATALOG_SOURCE_TYPE_UNSUPPORTED"
  | "CATALOG_CAPABILITY_MISSING";

export class CatalogIntegrationError extends Error {
  override readonly name = "CatalogIntegrationError";

  constructor(
    readonly code: CatalogIntegrationErrorCode,
    message: string,
  ) {
    super(message);
  }
}
