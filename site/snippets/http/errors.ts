import { inject } from '@knead-js/core';
import {
  ConflictException,
  Controller,
  type Ctx,
  ErrorLog,
  Get,
  HttpException,
  type HttpExceptionOptions,
  Post,
  ServiceUnavailableException,
} from '@knead-js/http';

// #region subclass
export class PaymentRequiredException extends HttpException {
  constructor(detail?: string, options?: HttpExceptionOptions) {
    super(402, detail, { title: 'Payment Required', ...options });
  }
}
// #endregion subclass

export class InventoryClient {
  async reserve(_sku: string): Promise<void> {
    throw new Error('connect ECONNREFUSED postgres://app:hunter2@10.0.0.5:5432/inventory');
  }
}

// #region throwing
@Controller('/checkout')
export class CheckoutController {
  readonly #inventory = inject(InventoryClient);
  readonly #errors = inject(ErrorLog);

  @Post('/:sku')
  async buy({ params }: Ctx<{ params: { sku: string } }>) {
    if (params.sku === 'sold-out') {
      throw new ConflictException(`SKU ${params.sku} is sold out`, {
        type: 'https://example.com/problems/sold-out',
        extensions: { sku: params.sku },
      });
    }
    if (params.sku === 'unpaid') throw new PaymentRequiredException('Settle your balance first');
    try {
      await this.#inventory.reserve(params.sku);
    } catch (error) {
      // The 503 is logged with its own message only; record the underlying error as well.
      this.#errors.log(`Reserving ${params.sku} failed`, error, 'warn');
      throw new ServiceUnavailableException('Inventory is unavailable', {
        headers: { 'retry-after': '30' },
        cause: error,
      });
    }
    return { reserved: params.sku };
  }

  @Get('/crash')
  crash(): never {
    throw new Error('Lost connection to redis://default:s3cret@cache:6379');
  }
}
// #endregion throwing
