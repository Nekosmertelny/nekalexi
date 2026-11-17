import { describe, it, expect } from 'vitest';
import {
  calculateFsrs,
  previewAllFsrsIntervals,
  formatIntervalMsRu,
  type FsrsCardState,
} from '../server/fsrs.ts';

describe('FSRS Spaced Repetition Engine (ts-fsrs)', () => {
  const freshCard: FsrsCardState = {
    stability: 0,
    difficulty: 0,
    state: 0,
    reps: 0,
    lapses: 0,
    learningSteps: 0,
    status: 'new',
  };

  it('schedules first Good (3) review into learning/review with valid stability and difficulty', () => {
    const now = new Date('2026-11-15T10:00:00.000Z');
    const res = calculateFsrs(freshCard, 3, now);
    expect(res.repetitions).toBe(1);
    expect(res.stability).toBeGreaterThan(0);
    expect(res.difficulty).toBeGreaterThan(0);
    expect(['learning', 'review']).toContain(res.status);
    expect(new Date(res.nextReviewAt).getTime()).toBeGreaterThan(now.getTime());
    expect(res.intervalLabelRu).toBeTruthy();
  });

  it('produces progressively longer intervals on repeated Good/Easy answers and reaches mastered', () => {
    let cursor = new Date('2026-11-15T10:00:00.000Z');
    let state: FsrsCardState = freshCard;

    for (let i = 0; i < 6; i++) {
      const res = calculateFsrs(state, i >= 2 ? 4 : 3, cursor);
      state = {
        dueAt: res.nextReviewAt,
        stability: res.stability,
        difficulty: res.difficulty,
        state: res.state,
        reps: res.repetitions,
        lapses: res.lapses,
        learningSteps: res.learningSteps,
        lastReviewedAt: cursor.toISOString(),
        status: res.status,
        intervalDays: res.intervalDays,
      };
      cursor = new Date(res.nextReviewAt);
    }

    expect(state.stability).toBeGreaterThanOrEqual(21);
    expect(state.intervalDays).toBeGreaterThanOrEqual(21);
    expect(state.status).toBe('mastered');
  });

  it('increments lapses and switches mature card to learning on Again (1)', () => {
    const now = new Date('2026-11-15T10:00:00.000Z');
    const reviewCard: FsrsCardState = {
      dueAt: now.toISOString(),
      stability: 14,
      difficulty: 5.5,
      state: 2, // Review
      reps: 4,
      lapses: 0,
      learningSteps: 0,
      lastReviewedAt: new Date(now.getTime() - 14 * 86_400_000).toISOString(),
      status: 'review',
      intervalDays: 14,
    };

    const res = calculateFsrs(reviewCard, 1, now);
    expect(res.lapses).toBe(1);
    expect(res.status).toBe('learning');
    expect(res.difficulty).toBeGreaterThan(5.5);
  });

  it('previews all 4 FSRS rating intervals cleanly', () => {
    const previews = previewAllFsrsIntervals(freshCard, new Date('2026-11-15T10:00:00.000Z'));
    expect(previews[1]).toBeTruthy();
    expect(previews[2]).toBeTruthy();
    expect(previews[3]).toBeTruthy();
    expect(previews[4]).toBeTruthy();
  });

  it('formats durations into readable Russian units', () => {
    expect(formatIntervalMsRu(60_000)).toBe('1 мин');
    expect(formatIntervalMsRu(10 * 60_000)).toBe('10 мин');
    expect(formatIntervalMsRu(6 * 3_600_000)).toBe('6 ч');
    expect(formatIntervalMsRu(3 * 86_400_000)).toBe('3 дн');
    expect(formatIntervalMsRu(60 * 86_400_000)).toBe('2 мес');
  });
});
