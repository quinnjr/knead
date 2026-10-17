import { InjectionToken } from '@knead-js/core';
import type { PrismaErrorMapper } from './to-http-exception.js';

export interface PrismaHttpOptions {
  map?: Record<string, PrismaErrorMapper>;
}

export const PRISMA_HTTP_OPTIONS = new InjectionToken<PrismaHttpOptions>(
  'knead:prisma:http-options',
);
