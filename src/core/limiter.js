// In-memory sliding-window gate used for expensive user-triggered work.
export class SlidingWindowLimiter {
  constructor({ limit = 6, windowMs = 60_000, minIntervalMs = 2_000, maxKeys = 10_000 } = {}) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.windowMs = Math.max(1, Number(windowMs) || 1);
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0);
    this.maxKeys = Math.max(100, Number(maxKeys) || 100);
    this.entries = new Map();
  }

  consume(key, now = Date.now()) {
    const id = String(key || '');
    const recent = (this.entries.get(id) || []).filter((timestamp) => now - timestamp < this.windowMs);
    const last = recent.at(-1) || 0;
    if (last && now - last < this.minIntervalMs) {
      this.entries.delete(id);
      this.entries.set(id, recent);
      return { allowed: false, retryAfterMs: this.minIntervalMs - (now - last), reason: 'interval' };
    }
    if (recent.length >= this.limit) {
      const retryAfterMs = Math.max(1, this.windowMs - (now - recent[0]));
      this.entries.delete(id);
      this.entries.set(id, recent);
      return { allowed: false, retryAfterMs, reason: 'window' };
    }
    recent.push(now);
    this.entries.delete(id);
    this.entries.set(id, recent);
    while (this.entries.size > this.maxKeys) this.entries.delete(this.entries.keys().next().value);
    return { allowed: true, remaining: this.limit - recent.length };
  }

  prune(now = Date.now()) {
    for (const [key, timestamps] of this.entries) {
      const recent = timestamps.filter((timestamp) => now - timestamp < this.windowMs);
      if (recent.length) this.entries.set(key, recent);
      else this.entries.delete(key);
    }
  }
}
