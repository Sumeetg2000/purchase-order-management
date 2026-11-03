// The time the API's rules run on (research R2, Principle VIII): session lifetimes, the
// lockout, rate-limit windows and token expiry all read it, so tests can move time
// instead of waiting. Production uses the system clock.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
