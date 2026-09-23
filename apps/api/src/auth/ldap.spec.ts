import { describe, expect, it } from 'vitest';
import { escapeFilter, normalizeUsername } from './ldap.js';

describe('normalizeUsername', () => {
  const suffix = 'sharbatlyfruit.com';
  it.each([
    ['mohamed.tag', 'mohamed.tag@sharbatlyfruit.com'],
    ['  Mohamed.Tag ', 'mohamed.tag@sharbatlyfruit.com'],
    ['mohamed.tag@sharbatlyfruit.com', 'mohamed.tag@sharbatlyfruit.com'],
    ['MOHAMED.TAG@SharbatlyFruit.com', 'mohamed.tag@sharbatlyfruit.com'],
    ['SHARBATLY\\mohamed.tag', 'mohamed.tag@sharbatlyfruit.com'],
  ])('%s → %s', (input, upn) => expect(normalizeUsername(input, suffix)).toBe(upn));
});

describe('escapeFilter', () => {
  it('neutralises filter injection', () => {
    expect(escapeFilter('*)(uid=*')).toBe('\\2a\\29\\28uid=\\2a');
    expect(escapeFilter('a\\b')).toBe('a\\5cb');
  });
  it('leaves normal names alone', () => expect(escapeFilter('mohamed.tag')).toBe('mohamed.tag'));
});
