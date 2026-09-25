/**
 * Business-rule errors of the Demand-to-PO workflow (plan v5). Services throw
 * DomainError with a stable code; the tRPC layer turns it into a TRPCError
 * whose data carries `domainCode` and `details` for the UI.
 */
import { TRPCError } from '@trpc/server';

export type DomainStatus = 403 | 404 | 409 | 422;

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: DomainStatus = 422,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Stale RowVer: somebody saved the object after the user loaded it. */
export class ConcurrencyError extends DomainError {
  constructor(entity: string, id: string | number) {
    super('STALE_WRITE', `${entity} ${id} was changed by someone else. Reload and try again.`, 409);
  }
}

export class ForbiddenError extends DomainError {
  constructor(action: string) {
    super('FORBIDDEN', `Not allowed: ${action}`, 403);
  }
}

/** Same answer as "does not exist", so nothing is disclosed about other companies' data. */
export class NotFoundError extends DomainError {
  constructor(what: string) {
    super('NOT_FOUND', `${what} not found`, 404);
  }
}

const TRPC_CODE = { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 422: 'UNPROCESSABLE_CONTENT' } as const;

export function toTrpcError(err: DomainError): TRPCError {
  return new TRPCError({ code: TRPC_CODE[err.status], message: err.message, cause: err });
}
