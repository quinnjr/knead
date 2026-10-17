import { InjectionToken, inject, Module } from '@knead-js/core';

// #region global
export interface FeatureFlags {
  isEnabled(flag: string): boolean;
}

export const FEATURE_FLAGS = new InjectionToken<FeatureFlags>('FEATURE_FLAGS');

@Module({
  global: true,
  providers: [
    {
      provide: FEATURE_FLAGS,
      useValue: { isEnabled: (flag: string) => flag === 'new-checkout' },
    },
  ],
  exports: [FEATURE_FLAGS],
})
export class FeatureFlagsModule {}

// No import of FeatureFlagsModule needed here.
export class CheckoutService {
  readonly flags = inject(FEATURE_FLAGS);
}

@Module({ providers: [CheckoutService], exports: [CheckoutService] })
export class CheckoutModule {}

// A global module is still imported once, usually by the root module.
@Module({ imports: [FeatureFlagsModule, CheckoutModule] })
export class AppModule {}
// #endregion global
