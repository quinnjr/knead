export interface OnModuleInit {
  onModuleInit(): void | Promise<void>;
}

export interface OnApplicationBootstrap {
  onApplicationBootstrap(): void | Promise<void>;
}

export interface BeforeApplicationShutdown {
  beforeApplicationShutdown(signal?: string): void | Promise<void>;
}

export interface OnModuleDestroy {
  onModuleDestroy(): void | Promise<void>;
}
