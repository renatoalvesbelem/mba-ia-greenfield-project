import { randomBytes } from 'crypto';

export const PUBLIC_ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

export const PUBLIC_ID_LENGTH = 11;

export function generatePublicId(): string {
  const bytes = randomBytes(PUBLIC_ID_LENGTH);
  let publicId = '';

  for (let i = 0; i < PUBLIC_ID_LENGTH; i++) {
    publicId += PUBLIC_ID_ALPHABET[bytes[i] & 63];
  }

  return publicId;
}
