import type { PrismaClient } from './generated/prisma/client.js';

declare module '@knead-js/prisma' {
  interface PrismaClientRegistry {
    client: PrismaClient;
  }
}
