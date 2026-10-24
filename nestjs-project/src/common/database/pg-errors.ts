import { QueryFailedError } from 'typeorm';

export const PG_UNIQUE_VIOLATION = '23505';

type PgQueryFailedError = QueryFailedError & {
  code?: string;
  detail?: string;
};

export function isPgUniqueViolationOnColumn(
  err: unknown,
  column: string,
): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as PgQueryFailedError;
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(column)
  );
}
