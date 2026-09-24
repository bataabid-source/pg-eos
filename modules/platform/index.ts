// M00 platform — package shell created by WBS 0.4 (monorepo skeleton).
// The module's own surface is built by WBS 0.9–0.10 and 0.15–0.16; its hexagonal file tree is
// copied from the golden slice (WBS 2.9) by scripts/new-slice.sh — never hand-made (CLAUDE.md).
//
// WBS 5.13 part 1 (alert evaluation mechanism, doc 40 §B6 / doc 25 §1-§2): the two application
// commands and their typed domain errors — same public-surface pattern as
// modules/wms/index.ts's own golden-slice re-export.
export * from './application/evaluate-alerts/index.js';
export * from './domain/evaluate-alerts/errors.js';

// WBS 5.5a part 1 (lane 2, SCR-HR-SHIFT-01 §2.4): platform.sites — the single sites table.
// Named re-exports (not `export *`): ./domain/evaluate-alerts/errors.js already exports
// RoleRequiredError / StaleVersionError / MissingActorError — a wildcard re-export from both use
// cases would collide. maintain-site's own error names are aliased with a `Site` prefix here so
// both use cases' typed errors stay reachable from this one module barrel.
export {
  createSite,
  updateSite,
  type CreateSiteInput,
  type CreateSiteResult,
  type UpdateSiteInput,
  type UpdateSiteResult,
  type MaintainSiteDeps,
  type SiteRepository,
  type SiteRow,
} from './application/maintain-site/index.js';
export {
  SiteAccountRequiredError,
  SiteKindInvalidError,
  SiteRadiusInvalidError,
  SiteNotFoundError,
  EntityScopeAmbiguousError as MaintainSiteEntityScopeAmbiguousError,
  RoleRequiredError as MaintainSiteRoleRequiredError,
  StaleVersionError as MaintainSiteStaleVersionError,
  MissingActorError as MaintainSiteMissingActorError,
} from './domain/maintain-site/errors.js';
