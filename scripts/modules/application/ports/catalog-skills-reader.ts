import type {
  CatalogSelectedProfileRecord,
  CatalogSkillRecord,
} from "../../catalog/query-skills.ts";

export type CatalogSkillsReadFailure = Readonly<{
  code: "CATALOG_SKILLS_READ_FAILED";
}>;

export type CatalogSkillsReadResult =
  | Readonly<{
      ok: true;
      skills: readonly CatalogSkillRecord[];
      selectedProfiles: readonly CatalogSelectedProfileRecord[];
    }>
  | Readonly<{
      ok: false;
      error: CatalogSkillsReadFailure;
    }>;

export interface CatalogSkillsReader {
  read(): CatalogSkillsReadResult;
}
