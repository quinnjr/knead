export {
  buildHeaders,
  generateNonce,
  type NonceTargets,
  nonceTargets,
  serializeCsp,
} from './csp.js';
export {
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
} from './options.js';

declare module '@hpmws/http' {
  interface CtxState {
    /** Set by SecurityHeadersModule when CSP nonces are enabled. */
    cspNonce?: string;
  }
}
