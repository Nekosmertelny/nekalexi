import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card,
  type Grade,
} from 'ts-fsrs';

export type ReviewQuality = 1 | 2 | 3 | 4; // 1: Again, 2: Hard, 3: Good, 4: Easy
export type WordStatus = 'new' | 'learning' | 'review' | 'mastered';

export interface FsrsCardState {
  dueAt?: string | null;
  stability?: number;
  difficulty?: number;
  state?: number; // 0: New, 1: Learning, 2: Review, 3: Relearning
  reps?: number;
  lapses?: number;
  learningSteps?: number;
  lastReviewedAt?: string | null;
  status?: WordStatus;
  intervalDays?: number;
}

export interface FsrsResult {
  stability: number;
  difficulty: number;
  state: number;
  lapses: number;
  learningSteps: number;
  repetitions: number;
  intervalDays: number;
  easeFactor: number;
  status: WordStatus;
  nextReviewAt: string;
  intervalLabelRu: string;
}

const scheduler = fsrs(
  generatorParameters({
    enable_fuzz: false,
    enable_short_term: true,
    request_retention: 0.9,
  })
);

function qualityToGrade(quality: ReviewQuality): Grade {
  switch (quality) {
    case 1:
      return Rating.Again;
    case 2:
      return Rating.Hard;
    case 3:
      return Rating.Good;
    case 4:
    default:
      return Rating.Easy;
  }
}

function toCard(input: FsrsCardState, now: Date): Card {
  const empty = createEmptyCard(now);
  const rawState = Number(input.state ?? 0);
  const reps = Math.max(0, Number(input.reps ?? 0));
  const stability = Number(input.stability ?? 0);
  const difficulty = Number(input.difficulty ?? 0);
  const lapses = Math.max(0, Number(input.lapses ?? 0));
  const learningSteps = Math.max(0, Number(input.learningSteps ?? 0));
  const intervalDays = Math.max(0, Number(input.intervalDays ?? 0));

  // If word had legacy SM-2 progress before FSRS migration, seed reasonable FSRS parameters
  if (rawState === State.New && reps > 0) {
    const inferredState =
      input.status === 'learning' ? State.Learning : State.Review;
    return {
      ...empty,
      due: input.dueAt ? new Date(input.dueAt) : now,
      stability: Math.max(1, intervalDays || 1),
      difficulty: 5.0,
      scheduled_days: Math.round(intervalDays),
      reps,
      lapses,
      learning_steps: learningSteps,
      state: inferredState,
      last_review: input.lastReviewedAt ? new Date(input.lastReviewedAt) : undefined,
    };
  }

  const validState: State =
    rawState === State.Learning || rawState === State.Review || rawState === State.Relearning
      ? rawState
      : State.New;

  return {
    ...empty,
    due: input.dueAt ? new Date(input.dueAt) : now,
    stability: Number.isFinite(stability) ? Math.max(0, stability) : 0,
    difficulty: Number.isFinite(difficulty) ? Math.max(0, difficulty) : 0,
    scheduled_days: Math.round(intervalDays),
    reps,
    lapses,
    learning_steps: learningSteps,
    state: validState,
    last_review: input.lastReviewedAt ? new Date(input.lastReviewedAt) : undefined,
  };
}

function mapCardStatus(card: Card, intervalDays: number): WordStatus {
  if (card.state === State.New) return 'new';
  if (card.state === State.Learning || card.state === State.Relearning) return 'learning';
  if (card.state === State.Review && card.stability >= 21 && intervalDays >= 21 && card.reps >= 3) {
    return 'mastered';
  }
  return 'review';
}

function difficultyToLegacyEase(difficulty: number): number {
  if (!Number.isFinite(difficulty) || difficulty <= 0) return 2.5;
  const mapped = 3.1 - (difficulty - 1) * 0.18;
  return Number(Math.max(1.3, Math.min(3.0, mapped)).toFixed(2));
}

export function formatIntervalMsRu(diffMs: number): string {
  const mins = Math.max(1, Math.round(diffMs / 60_000));
  if (mins < 60) {
    return `${mins} мин`;
  }
  const hours = Math.round(mins / 60);
  if (hours < 24) {
    return `${hours} ч`;
  }
  const days = Math.round(diffMs / 86_400_000);
  if (days < 30) {
    return `${Math.max(1, days)} дн`;
  }
  const months = Math.round(days / 30);
  return `${Math.max(1, months)} мес`;
}

export function calculateFsrs(
  current: FsrsCardState,
  quality: ReviewQuality,
  now: Date = new Date()
): FsrsResult {
  const card = toCard(current, now);
  const grade = qualityToGrade(quality);
  const outcomes = scheduler.repeat(card, now);
  const nextCard = outcomes[grade].card;

  const diffMs = Math.max(60_000, nextCard.due.getTime() - now.getTime());
  const exactDays = Number((diffMs / 86_400_000).toFixed(4));
  const intervalDays = nextCard.scheduled_days > 0 ? nextCard.scheduled_days : exactDays;

  return {
    stability: Number(nextCard.stability.toFixed(4)),
    difficulty: Number(nextCard.difficulty.toFixed(4)),
    state: nextCard.state,
    lapses: nextCard.lapses,
    learningSteps: nextCard.learning_steps,
    repetitions: nextCard.reps,
    intervalDays: Number(intervalDays.toFixed(4)),
    easeFactor: difficultyToLegacyEase(nextCard.difficulty),
    status: mapCardStatus(nextCard, intervalDays),
    nextReviewAt: nextCard.due.toISOString(),
    intervalLabelRu: formatIntervalMsRu(diffMs),
  };
}

export function previewAllFsrsIntervals(
  current: FsrsCardState,
  now: Date = new Date()
): Record<ReviewQuality, string> {
  const card = toCard(current, now);
  const outcomes = scheduler.repeat(card, now);

  const labelFor = (grade: Grade) => {
    const due = outcomes[grade].card.due.getTime();
    return formatIntervalMsRu(Math.max(60_000, due - now.getTime()));
  };

  return {
    1: labelFor(Rating.Again),
    2: labelFor(Rating.Hard),
    3: labelFor(Rating.Good),
    4: labelFor(Rating.Easy),
  };
}
