export interface User {
  id: number;
  email: string;
  name: string;
  role: 'user' | 'admin';
  oauth_provider?: string | null;
  avatar_url?: string | null;
  xp: number;
  level: number;
  streak_days: number;
  last_study_date?: string | null;
  daily_goal: number;
  reminder_enabled: number;
  reminder_time: string;
  cefr_level?: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | string;
  is_active: number;
  created_at: string;
}

export interface Deck {
  id: number;
  user_id: number | null;
  title: string;
  description: string;
  category: string;
  cefr_level: string;
  is_curated: number;
  word_count: number;
  due_count: number;
  total_deck_words: number;
  created_at: string;
}

export type WordStatus = 'new' | 'learning' | 'review' | 'mastered';

export interface WordItem {
  id: number;
  user_id: number;
  deck_id: number | null;
  deck_title?: string | null;
  word: string;
  phonetic: string;
  part_of_speech: string;
  translation: string;
  example_en: string;
  example_ru: string;
  secondary_example_en: string;
  secondary_example_ru: string;
  cefr_level: string;
  audio_url: string;
  image_url?: string;
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  fsrs_stability?: number;
  fsrs_difficulty?: number;
  fsrs_state?: number;
  fsrs_lapses?: number;
  status: WordStatus;
  next_review_at: string;
  last_reviewed_at: string | null;
  created_at: string;
  intervalPreviews?: Record<1 | 2 | 3 | 4, string>;
}

export interface ContextWritingFeedback {
  isCorrect: boolean;
  grammarScore: number;
  naturalnessScore: number;
  usedTargetWordsCorrectly: boolean;
  correctedSentence: string;
  feedbackRu: string;
  grammarNotes: string[];
  improvedVariants: Array<{
    en: string;
    ru: string;
    tone: string;
  }>;
  aiGenerated: boolean;
}

export interface WritingSubmissionRecord {
  id: number;
  target_words: string;
  user_sentence: string;
  corrected_sentence: string;
  grammar_score: number;
  naturalness_score: number;
  is_correct: number;
  feedback_ru: string;
  grammarNotes: string[];
  improvedVariants: Array<{ en: string; ru: string; tone: string }>;
  xp_earned: number;
  created_at: string;
}

export interface AnalyticsOverview {
  summary: {
    totalWords: number;
    newWords: number;
    learningWords: number;
    reviewWords: number;
    masteredWords: number;
    dueWords: number;
    todayReviews: number;
    dailyGoal: number;
    streakDays: number;
    xp: number;
    level: number;
    accuracyPercent: number;
    totalReviews: number;
    avgGrammarScore: number;
    writingCount: number;
  };
  velocity14d: Array<{
    day: string;
    label: string;
    reviews: number;
    correct: number;
    xp: number;
  }>;
  heatmap84d: Array<{
    day: string;
    count: number;
  }>;
  hardestWords: Array<{
    id: number;
    word: string;
    translation: string;
    ease_factor: number;
    fsrs_difficulty?: number;
    fsrs_stability?: number;
    fsrs_lapses?: number;
    repetitions: number;
    status: WordStatus;
  }>;
}

export interface AiReport {
  id: number;
  title: string;
  summaryRu: string;
  strengths: string[];
  focusAreas: string[];
  actionPlan: string[];
  predictedMilestone: string;
  createdAt: string;
}

export interface LeaderboardEntry {
  id: number;
  name: string;
  xp: number;
  level: number;
  streak_days: number;
  avatar_url?: string | null;
  mastered_count: number;
  achievements_count: number;
}

export interface AchievementItem {
  id: number;
  code: string;
  title: string;
  description: string;
  icon: string;
  xp_reward: number;
  threshold: number;
  category: string;
  unlocked_at: string | null;
}

export interface AppNotification {
  id: number;
  user_id: number | null;
  type: 'info' | 'reminder' | 'achievement' | 'system';
  title: string;
  message: string;
  is_read: number;
  created_at: string;
}

export interface AdminOverviewStats {
  totalUsers: number;
  activeUsers: number;
  totalWords: number;
  totalReviews: number;
  totalWritings: number;
  totalDecks: number;
  queryLatencyMs: number;
  onlineWsClients: number;
}

export interface AdminUserRow {
  id: number;
  email: string;
  name: string;
  role: 'user' | 'admin';
  oauth_provider?: string | null;
  xp: number;
  level: number;
  streak_days: number;
  is_active: number;
  created_at: string;
  words_count: number;
  reviews_count: number;
}
