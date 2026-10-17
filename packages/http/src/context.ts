import type { BunRequest, Server } from 'bun';
import { type CompiledTrust, resolveClientIp, resolveSecure } from './net.js';
import { headersToObject, parseBody, parseQuery, requestUrl } from './request.js';
import type { Ctx, ResponseDraft, RouteInfo, UpgradeInfo } from './types.js';

export interface NetConfig {
  trust: CompiledTrust;
  /** True when the listener terminates TLS itself. */
  tls: boolean;
  /** Most query, urlencoded or multipart parameters accepted. Default 1000. */
  maxParams?: number;
}

const EMPTY_META: Readonly<Record<PropertyKey, unknown>> = Object.freeze({});

export class RequestContext implements Ctx<any> {
  params: any;
  body: unknown = undefined;
  readonly state: Ctx['state'] = {};
  readonly res: ResponseDraft = { status: undefined, headers: new Headers() };
  #query: any;
  #headers: any;
  #ip: string | undefined;
  #ipResolved = false;
  #secure: boolean | undefined;
  #body: Promise<unknown> | undefined;

  constructor(
    readonly req: Request,
    readonly server: Server<any>,
    readonly route: RouteInfo | null,
    private readonly net: NetConfig,
    readonly upgrade: UpgradeInfo | null = null,
    /** An upgrade's meta: the endpoint's `meta`, merged over the GET route's meta if any. */
    private readonly upgradeMeta?: Readonly<Record<PropertyKey, unknown>>,
  ) {
    this.params = (req as BunRequest).params ?? {};
  }

  get meta(): Readonly<Record<PropertyKey, unknown>> {
    return this.upgradeMeta ?? this.route?.meta ?? EMPTY_META;
  }

  get query(): any {
    this.#query ??= parseQuery(requestUrl(this.req).search, this.net.maxParams);
    return this.#query;
  }
  set query(value: any) {
    this.#query = value;
  }

  get headers(): any {
    this.#headers ??= headersToObject(this.req.headers);
    return this.#headers;
  }
  set headers(value: any) {
    this.#headers = value;
  }

  get ip(): string | undefined {
    if (!this.#ipResolved) {
      this.#ip = resolveClientIp(
        this.#remote(),
        this.req.headers.get('x-forwarded-for'),
        this.net.trust,
      );
      this.#ipResolved = true;
    }
    return this.#ip;
  }

  get secure(): boolean {
    this.#secure ??= resolveSecure(
      this.net.tls,
      this.#remote(),
      this.req.headers.get('x-forwarded-for'),
      this.req.headers.get('x-forwarded-proto'),
      this.net.trust,
    );
    return this.#secure;
  }

  /** @internal After body validation, ctx.json() resolves to the validated value. */
  setValidatedBody(value: unknown): void {
    this.#body = Promise.resolve(value);
  }

  json<T = unknown>(): Promise<T> {
    this.#body ??= parseBody(this.req, this.net.maxParams);
    return this.#body as Promise<T>;
  }

  #remote(): string | undefined {
    return this.server.requestIP(this.req)?.address;
  }
}
