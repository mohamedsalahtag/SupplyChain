import { describe, expect, it } from 'vitest';
import { LIMITS, LoginThrottle, usernameKey, WINDOW_MS } from './loginThrottle.js';

describe('sign-in throttle (F11)', () => {
  it('normalizes the username however it is typed', () => {
    expect(['Mohamed.Tag', 'SHARBATLY\\mohamed.tag', 'mohamed.tag@sharbatlyfruit.com', ' MOHAMED.TAG '].map(usernameKey)).toEqual(Array(4).fill('mohamed.tag'));
  });

  it('refuses a sixth attempt a minute for one username, from any address; reports the first refusal once', () => {
    const t = new LoginThrottle(() => 1_000);
    for (let i = 0; i < LIMITS.username; i++) expect(t.hit(`10.0.0.${i}`, i % 2 ? 'Bob' : 'corp\\bob')).toBeNull();
    expect(t.hit('10.0.0.99', 'bob@x.com')).toEqual({ by: 'username', first: true });
    expect(t.hit('10.0.0.98', 'bob')).toEqual({ by: 'username', first: false });
    expect(t.hit('10.0.0.97', 'alice')).toBeNull(); // another user is not affected
  });

  it('refuses an eleventh attempt a minute from one address, whatever the usernames', () => {
    const t = new LoginThrottle(() => 1_000);
    for (let i = 0; i < LIMITS.ip; i++) expect(t.hit('10.0.0.1', `user${i}`)).toBeNull();
    expect(t.hit('10.0.0.1', 'someone')).toEqual({ by: 'ip', first: true });
  });

  it('forgets attempts after the window, and the sweep removes empty buckets', () => {
    let now = 0;
    const t = new LoginThrottle(() => now);
    for (let i = 0; i < LIMITS.username + 1; i++) t.hit('10.0.0.1', 'bob');
    now = WINDOW_MS + 1;
    expect(t.hit('10.0.0.2', 'bob')).toBeNull();
    now = 3 * WINDOW_MS;
    t.sweep();
    expect(t.size).toBe(0);
  });

  it('stays bounded under a flood of made-up usernames', () => {
    const t = new LoginThrottle(() => 1_000);
    for (let i = 0; i < 25_000; i++) t.hit(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, `fake${i}`);
    expect(t.size).toBeLessThanOrEqual(20_000);
  });
});
