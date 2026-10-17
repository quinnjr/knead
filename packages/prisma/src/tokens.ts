import { InjectionToken } from '@knead-js/core';
import type { PrismaModuleOptions, RegisteredClient } from './types.js';

export const PRISMA_OPTIONS = new InjectionToken<PrismaModuleOptions>('knead:prisma:options');
export const PRISMA_CLIENT = new InjectionToken<RegisteredClient>('knead:prisma:client');
