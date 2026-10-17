import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@knead-js/http';

/** The structural shape of a Prisma error; `@prisma/client` is never imported. */
export interface PrismaErrorLike {
  name: string;
  code?: string;
  meta?: Record<string, unknown>;
}

export type PrismaErrorMapper = (error: PrismaErrorLike) => HttpException;

export interface ToHttpExceptionOptions {
  /** Overrides and additions, keyed by error code (`P2002`) or error name. */
  map?: Record<string, PrismaErrorMapper>;
  development?: boolean;
}

const UNAVAILABLE = 'The database is temporarily unavailable.';

const PRISMA_ERROR_NAMES: ReadonlySet<string> = new Set([
  'PrismaClientKnownRequestError',
  'PrismaClientValidationError',
  'PrismaClientInitializationError',
  'PrismaClientRustPanicError',
  'PrismaClientUnknownRequestError',
]);

/** Duck-typed by exact name, so errors from another copy or realm of the client still match. */
export function isPrismaError(e: unknown): e is PrismaErrorLike {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { name?: unknown }).name === 'string' &&
    PRISMA_ERROR_NAMES.has((e as { name: string }).name)
  );
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? [...value] : undefined;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The constraint's field names. Prisma 7 driver adapters put them at
 * `meta.driverAdapterError.cause.constraint.fields`; the native engine used `meta.target`.
 */
function constraintFields(meta: Record<string, unknown> | undefined): string[] | undefined {
  const adapter = field(field(field(meta?.driverAdapterError, 'cause'), 'constraint'), 'fields');
  return stringArray(adapter) ?? stringArray(meta?.target);
}

function devExtensions(error: PrismaErrorLike, development: boolean | undefined) {
  if (!development) return undefined;
  const extensions: Record<string, unknown> = {};
  if (error.code !== undefined) extensions.prismaCode = error.code;
  // Field names only: never values, and never `message`.
  const fields = constraintFields(error.meta);
  if (fields) extensions.fields = fields;
  return extensions;
}

/** Maps a Prisma error to an HttpException, or returns `undefined` when it is not a Prisma error. */
export function toHttpException(
  error: unknown,
  options: ToHttpExceptionOptions = {},
): HttpException | undefined {
  if (!isPrismaError(error)) return undefined;
  const { code, name } = error;
  // `toHttpException` is public API: anything that is not an object is treated as no map.
  const map = typeof options.map === 'object' && options.map !== null ? options.map : undefined;
  // Own keys only, so an inherited `constructor` or `toString` is never called as a mapper.
  const own = (key: string | undefined) =>
    map !== undefined && key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;
  const mapper = own(code) ?? own(name);
  if (mapper) {
    try {
      const mapped: unknown = mapper(error);
      if (mapped instanceof HttpException) return mapped;
    } catch {
      // A broken mapper becomes a masked 500.
    }
    return new InternalServerErrorException(undefined, { cause: error });
  }
  const init = { cause: error, extensions: devExtensions(error, options.development) };
  switch (code) {
    case 'P2002':
      return new ConflictException('A record with these values already exists.', init);
    case 'P2003':
      return new ConflictException('The operation conflicts with a related record.', init);
    case 'P2025':
      return new NotFoundException('The requested record was not found.', init);
    case 'P2000':
      return new BadRequestException('A value is too long for its field.', init);
    case 'P1001':
    case 'P1002':
    case 'P2024':
      return new ServiceUnavailableException(UNAVAILABLE, init);
  }
  if (name === 'PrismaClientValidationError') {
    return new BadRequestException('The request could not be processed.', init);
  }
  if (name === 'PrismaClientInitializationError') {
    return new ServiceUnavailableException(UNAVAILABLE, init);
  }
  return new InternalServerErrorException(undefined, init);
}
