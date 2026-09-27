import { randomBytes } from 'node:crypto';

/** A short reference for an unexpected error: shown to the user, and logged with the full error. */
export const newErrorId = () => `E-${randomBytes(5).toString('hex').toUpperCase()}`;
