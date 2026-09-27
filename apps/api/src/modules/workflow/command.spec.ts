import { describe, expect, it } from 'vitest';
import { assertSameCommand, canonicalJson, inputHash } from './command.js';

describe('runCommand: a reused command id must be the same command (F17)', () => {
  it('canonical JSON ignores key order and undefined fields', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'x' }, u: undefined })).toBe('{"a":{"c":"x","d":[1,{"x":1,"y":2}]},"b":1}');
    expect(inputHash({ a: 1, b: 2 })).toBe(inputHash({ b: 2, a: 1 }));
    expect(inputHash({ a: 1 })).not.toBe(inputHash({ a: 2 }));
    expect(inputHash(undefined)).toBeNull();
    expect(inputHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('replays only for the same user, name and input; old rows (no hash) compare by name', () => {
    const h = inputHash({ draftId: '7' });
    const row = { UserId: 5, CommandName: 'po.submit', InputHash: h };
    expect(() => assertSameCommand(row, 5, 'po.submit', h)).not.toThrow();
    expect(() => assertSameCommand(row, 6, 'po.submit', h)).toThrow(expect.objectContaining({ code: 'BAD_COMMAND', status: 409 }));
    expect(() => assertSameCommand(row, 5, 'po.validate', h)).toThrow(expect.objectContaining({ code: 'COMMAND_KEY_REUSED', status: 409 }));
    expect(() => assertSameCommand(row, 5, 'po.submit', inputHash({ draftId: '8' }))).toThrow(expect.objectContaining({ code: 'COMMAND_KEY_REUSED' }));
    expect(() => assertSameCommand({ ...row, InputHash: null }, 5, 'po.submit', h)).not.toThrow(); // stored before migration 0031
    expect(() => assertSameCommand(row, 5, 'po.submit', null)).not.toThrow(); // a caller that passes no input
    expect(() => assertSameCommand({ ...row, InputHash: `${h} ` }, 5, 'po.submit', h)).not.toThrow(); // char(64) padding
  });
});
