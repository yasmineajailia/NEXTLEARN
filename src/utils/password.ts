import bcrypt from "bcryptjs";

const DEFAULT_SALT_ROUNDS = 12;

function resolveSaltRounds(): number {
  const raw = Number(process.env.BCRYPT_SALT_ROUNDS || DEFAULT_SALT_ROUNDS);

  if (!Number.isFinite(raw)) {
    return DEFAULT_SALT_ROUNDS;
  }

  // Keep rounds in a safe range to avoid weak or excessively slow hashing.
  return Math.min(15, Math.max(10, Math.trunc(raw)));
}

export function hashPassword(plainPassword: string): Promise<string> {
  return bcrypt.hash(plainPassword, resolveSaltRounds());
}

export function comparePassword(plainPassword: string, hashedPassword: string): Promise<boolean> {
  return bcrypt.compare(plainPassword, hashedPassword);
}
