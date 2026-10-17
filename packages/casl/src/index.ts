export type { AbilityBuilder, MongoAbility, RawRuleOf } from '@casl/ability';
// The package's own CASL copy: a ForbiddenError thrown with this one is the one
// CaslForbiddenFilter and mapCaslError recognise with instanceof.
export { ForbiddenError, subject } from '@casl/ability';
export {
  type AppAbility,
  asSubject,
  createAppAbility,
  grantRules,
  intersectRules,
} from './ability.js';
export { CaslConfigError } from './errors.js';
export { PermittedFields, pickPermitted } from './fields.js';
export { CaslForbiddenFilter, mapCaslError } from './filter.js';
export { type Grant, MAX_SCOPE_LENGTH, parseGrant } from './grant.js';
export { AbilitySubject, FieldAbilityGuard, SUBJECT } from './graphql.js';
export { AbilityGuard } from './guard.js';
export {
  CAN,
  Can,
  type CanRequirement,
  canMeta,
  createCan,
  SKIP,
  SkipAbility,
  skipAbilityMeta,
} from './metadata.js';
export { CaslModule } from './module.js';
export {
  type AbilityCtx,
  CASL_OPTIONS,
  type CaslModuleOptions,
  type GraphQLLikeCtx,
  type Identity,
} from './options.js';
export {
  type AreaDefinition,
  type Catalog,
  type CatalogRule,
  definePermissions,
  fullGrant,
  type PermissionCatalogJson,
  type Permissions,
} from './permissions.js';
export { AbilityService, type GrantProblem, type GrantValidation } from './service.js';
