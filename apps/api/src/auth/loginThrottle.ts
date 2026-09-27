/**
 * Sign-in throttle (security review 2026-09-26, F11): at most 10 attempts a minute from one address and 5 a minute for
 * one username (however it is typed: "Name", "DOMAIN\name", "name@domain"). The buckets live in memory, are swept every
 * minute and are bounded in size, so a flood of made-up usernames or addresses cannot grow them without limit.
 */
export const WINDOW_MS = 60_000;
export const LIMITS = { ip: 10, username: 5 } as const;
const MAX_KEYS = 20_000;

/** "SHARBATLY\Mohamed.Tag", "mohamed.tag@x.com" → "mohamed.tag". */
export const usernameKey = (input: string) => {
  let name = input.trim().toLowerCase();
  if (name.includes('\\')) name = name.slice(name.lastIndexOf('\\') + 1);
  if (name.includes('@')) name = name.slice(0, name.indexOf('@'));
  return name.trim();
};

export type ThrottleHit = { by: 'ip' | 'username'; /** true only for the first refused attempt in the window (audit it once). */ first: boolean };

export class LoginThrottle {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts one attempt; returns null when allowed, or which limit refused it. */
  hit(ip: string, username: string): ThrottleHit | null {
    const t = this.now();
    const byIp = this.count(`ip:${ip}`, t);
    const byUser = this.count(`u:${usernameKey(username)}`, t);
    if (byIp > LIMITS.ip) return { by: 'ip', first: byIp === LIMITS.ip + 1 };
    if (byUser > LIMITS.username) return { by: 'username', first: byUser === LIMITS.username + 1 };
    return null;
  }

  /** Drops attempts older than the window, and keys with none left. */
  sweep(): void {
    const t = this.now();
    for (const [k, times] of this.buckets) {
      const recent = times.filter((x) => t - x < WINDOW_MS);
      if (recent.length) this.buckets.set(k, recent);
      else this.buckets.delete(k);
    }
  }

  get size(): number {
    return this.buckets.size;
  }

  private count(key: string, t: number): number {
    const recent = (this.buckets.get(key) ?? []).filter((x) => t - x < WINDOW_MS);
    recent.push(t);
    this.buckets.delete(key); // re-inserted last: the Map stays in least-recently-used order
    this.buckets.set(key, recent.slice(-50)); // more than the limit is never needed
    // A flood of new keys between two sweeps: forget the least recently used one (the Map's first key).
    if (this.buckets.size > MAX_KEYS) this.buckets.delete(this.buckets.keys().next().value!);
    return recent.length;
  }
}
