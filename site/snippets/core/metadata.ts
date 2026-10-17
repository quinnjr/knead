import {
  getMethodMetadata,
  getOwnMetadata,
  MetadataKey,
  setMetadata,
  setMethodMetadata,
} from '@knead-js/core';

// #region keys
/** Marks a method as audited, with the action name to record. */
export const AUDITED = new MetadataKey<string>('app:audited');
/** Marks a class with the resource name its audit entries use. */
export const AUDIT_RESOURCE = new MetadataKey<string>('app:audit-resource');

export function AuditResource(name: string) {
  return (_target: Function, context: ClassDecoratorContext): void => {
    setMetadata(context.metadata, AUDIT_RESOURCE, name);
  };
}

export function Audited(action: string) {
  return (_method: Function, context: ClassMethodDecoratorContext): void => {
    setMethodMetadata(context.metadata, context.name, AUDITED, action);
  };
}
// #endregion keys

// #region use
@AuditResource('invoice')
export class InvoiceController {
  @Audited('invoice.void')
  void(id: string): string {
    return `voided ${id}`;
  }
}

export function auditAction(cls: Function, method: string): string | undefined {
  const resource = getOwnMetadata(cls, AUDIT_RESOURCE);
  const action = getMethodMetadata(cls, method, AUDITED);
  return resource && action ? `${resource}:${action}` : undefined;
}
// #endregion use
