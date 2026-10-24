import {
  PUBLIC_ID_ALPHABET,
  PUBLIC_ID_LENGTH,
  generatePublicId,
} from './public-id.util';

describe('generatePublicId', () => {
  it('always returns a string of exactly PUBLIC_ID_LENGTH characters', () => {
    for (let i = 0; i < 1000; i++) {
      expect(generatePublicId()).toHaveLength(PUBLIC_ID_LENGTH);
    }
  });

  it('only uses characters from PUBLIC_ID_ALPHABET', () => {
    const allowed = new Set(PUBLIC_ID_ALPHABET.split(''));

    for (let i = 0; i < 1000; i++) {
      const publicId = generatePublicId();

      for (const char of publicId) {
        expect(allowed.has(char)).toBe(true);
      }
    }
  });

  it('produces no repetitions across 10,000 generations', () => {
    const ids = new Set<string>();

    for (let i = 0; i < 10_000; i++) {
      ids.add(generatePublicId());
    }

    expect(ids.size).toBe(10_000);
  });

  it('eventually generates ids containing "_" and "-" over 50,000 generations', () => {
    let sawUnderscore = false;
    let sawHyphen = false;

    for (let i = 0; i < 50_000 && !(sawUnderscore && sawHyphen); i++) {
      const publicId = generatePublicId();

      if (publicId.includes('_')) {
        sawUnderscore = true;
      }

      if (publicId.includes('-')) {
        sawHyphen = true;
      }
    }

    expect(sawUnderscore).toBe(true);
    expect(sawHyphen).toBe(true);
  });
});
