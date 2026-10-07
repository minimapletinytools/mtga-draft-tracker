import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CARD_SCALE,
  MAX_CARD_SCALE,
  MIN_CARD_SCALE,
  clampCardScale,
  parseCardScale,
} from '../src/prefs';

describe('clampCardScale', () => {
  it('leaves a sensible value alone', () => {
    expect(clampCardScale(100)).toBe(100);
    expect(clampCardScale(150)).toBe(150);
  });

  it('holds the ends of the range', () => {
    expect(clampCardScale(0)).toBe(MIN_CARD_SCALE);
    expect(clampCardScale(-40)).toBe(MIN_CARD_SCALE);
    expect(clampCardScale(1000)).toBe(MAX_CARD_SCALE);
  });

  it('allows zooming in to 200', () => {
    expect(clampCardScale(MAX_CARD_SCALE)).toBe(200);
  });

  it('rounds to a whole number', () => {
    expect(clampCardScale(137.6)).toBe(138);
  });

  it('falls back for values that are not numbers', () => {
    expect(clampCardScale(Number.NaN)).toBe(DEFAULT_CARD_SCALE);
    expect(clampCardScale(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CARD_SCALE);
  });
});

describe('parseCardScale', () => {
  it('reads a stored value', () => {
    expect(parseCardScale('160')).toBe(160);
  });

  it('defaults to 100 when nothing is stored', () => {
    expect(parseCardScale(null)).toBe(100);
    expect(DEFAULT_CARD_SCALE).toBe(100);
  });

  it('survives a corrupted preference rather than breaking the grid', () => {
    expect(parseCardScale('')).toBe(DEFAULT_CARD_SCALE);
    expect(parseCardScale('huge')).toBe(DEFAULT_CARD_SCALE);
    expect(parseCardScale('{"a":1}')).toBe(DEFAULT_CARD_SCALE);
  });

  it('clamps a stored value that is out of range', () => {
    expect(parseCardScale('9999')).toBe(MAX_CARD_SCALE);
    expect(parseCardScale('-5')).toBe(MIN_CARD_SCALE);
  });
});
