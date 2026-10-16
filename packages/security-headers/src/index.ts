export {
  buildHeaders,
  generateNonce,
  type NonceTargets,
  nonceTargets,
  serializeCsp,
} from './csp.js';
export {
  MIN_RECOMMENDED_HSTS_MAX_AGE,
  SECURITY_HEADERS_META,
  SECURITY_HEADERS_OPTIONS,
  SecurityHeaders,
  SecurityHeadersMiddleware,
} from './middleware.js';
export { SecurityHeadersModule } from './module.js';
export {
  type CspDirectives,
  type CspOptions,
  DEFAULT_CSP_DIRECTIVES,
  DEFAULT_OPTIONS,
  type HstsOptions,
  mergeOptions,
  type SecurityHeadersOptions,
  validateSecurityHeadersOptions,
} from './options.js';

declare module '@knead/http' {
  interface CtxState {
    /** Set by SecurityHeadersModule when CSP nonces are enabled. */
    cspNonce?: string;
  }
}
