type Bucket = { count: number; resetAt: number };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly maxRequests: number, private readonly windowMs: number) {}

  allow(key: string) {
    const now = Date.now();
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (current.count >= this.maxRequests) return false;
    current.count += 1;
    return true;
  }
}