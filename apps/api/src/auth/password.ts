import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended Argon2id parameters
const OPTS = { algorithm: 2 /* Argon2id */, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (pw: string) => hash(pw, OPTS);

export async function verifyPassword(hashStr: string, pw: string): Promise<boolean> {
  try {
    return await verify(hashStr, pw);
  } catch {
    return false;
  }
}

// Used to equalize timing when the username does not exist
let dummy: string | undefined;
export async function dummyVerify(pw: string): Promise<void> {
  dummy ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(dummy, pw);
}

export function passwordProblems(pw: string): string | null {
  if (pw.length < 8) return 'Password must be at least 8 characters';
  if (pw.length > 256) return 'Password too long';
  return null;
}
