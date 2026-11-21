import type { z } from 'zod';

export class HttpProblem extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (m: string, d?: unknown) => new HttpProblem(400, m, d);
export const unauthorized = (m = 'Not signed in') => new HttpProblem(401, m);
export const forbidden = (m = 'Forbidden') => new HttpProblem(403, m);
export const notFound = (m = 'Not found') => new HttpProblem(404, m);
export const conflict = (m: string, d?: unknown) => new HttpProblem(409, m, d);

/** Validate untrusted input with zod; throws 400 with field issues. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw badRequest(
      'Validation failed',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}
