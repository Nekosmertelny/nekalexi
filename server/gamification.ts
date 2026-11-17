import type Database from 'better-sqlite3';
import type { WsNotificationHub } from './ws.ts';

export function calculateLevelFromXp(xp: number): number {
  return Math.max(1, Math.floor(xp / 100) + 1);
}

export function awardUserXp(
  db: Database.Database,
  userId: number,
  xpDelta: number,
  updateStudyStreak: boolean
): { xp: number; level: number; streak_days: number } {
  const user = db
    .prepare('SELECT xp, level, streak_days, last_study_date FROM users WHERE id = ?')
    .get(userId) as
    | { xp: number; level: number; streak_days: number; last_study_date: string | null }
    | undefined;

  if (!user) {
    throw new Error('Пользователь не найден');
  }

  const newXp = user.xp + xpDelta;
  const newLevel = calculateLevelFromXp(newXp);
  let newStreak = user.streak_days;
  let newLastStudyDate = user.last_study_date;

  if (updateStudyStreak) {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    if (user.last_study_date === today) {
      newStreak = Math.max(1, user.streak_days);
    } else if (user.last_study_date === yesterday) {
      newStreak = user.streak_days + 1;
    } else {
      newStreak = 1;
    }
    newLastStudyDate = today;
  }

  db.prepare(
    'UPDATE users SET xp = ?, level = ?, streak_days = ?, last_study_date = ? WHERE id = ?'
  ).run(newXp, newLevel, newStreak, newLastStudyDate, userId);

  return { xp: newXp, level: newLevel, streak_days: newStreak };
}

export interface UnlockedAchievement {
  code: string;
  title: string;
  description: string;
  xp_reward: number;
}

export function evaluateAndUnlockAchievements(
  db: Database.Database,
  userId: number,
  wsHub?: WsNotificationHub | null
): UnlockedAchievement[] {
  const user = db.prepare('SELECT streak_days FROM users WHERE id = ?').get(userId) as
    | { streak_days: number }
    | undefined;
  if (!user) return [];

  const wordsCount = (
    db.prepare('SELECT COUNT(*) as cnt FROM words WHERE user_id = ?').get(userId) as { cnt: number }
  ).cnt;
  const masteredCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM words WHERE user_id = ? AND status = 'mastered'").get(userId) as {
      cnt: number;
    }
  ).cnt;
  const reviewsCount = (
    db.prepare('SELECT COUNT(*) as cnt FROM review_logs WHERE user_id = ?').get(userId) as { cnt: number }
  ).cnt;
  const writingCount = (
    db.prepare('SELECT COUNT(*) as cnt FROM writing_submissions WHERE user_id = ?').get(userId) as {
      cnt: number;
    }
  ).cnt;
  const maxGrammarScore = (
    db.prepare('SELECT COALESCE(MAX(grammar_score), 0) as max_score FROM writing_submissions WHERE user_id = ?').get(
      userId
    ) as { max_score: number }
  ).max_score;

  const metricByCode: Record<string, number> = {
    first_word: wordsCount,
    vocab_20: wordsCount,
    first_review: reviewsCount,
    streak_7: user.streak_days,
    master_5: masteredCount,
    writer_5: writingCount,
    grammar_90: maxGrammarScore,
  };

  const locked = db
    .prepare(
      `SELECT a.* FROM achievements a
       WHERE a.id NOT IN (SELECT achievement_id FROM user_achievements WHERE user_id = ?)`
    )
    .all(userId) as Array<{
    id: number;
    code: string;
    title: string;
    description: string;
    xp_reward: number;
    threshold: number;
  }>;

  const unlockedNow: UnlockedAchievement[] = [];

  for (const ach of locked) {
    const val = metricByCode[ach.code] ?? 0;
    if (val >= ach.threshold) {
      db.prepare('INSERT OR IGNORE INTO user_achievements (user_id, achievement_id) VALUES (?, ?)').run(
        userId,
        ach.id
      );

      // Award XP reward
      awardUserXp(db, userId, ach.xp_reward, false);

      const title = `Достижение разблокировано: ${ach.title}`;
      const message = `${ach.description} (+${ach.xp_reward} XP)`;
      const notifRes = db
        .prepare('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)')
        .run(userId, 'achievement', title, message);

      unlockedNow.push({
        code: ach.code,
        title: ach.title,
        description: ach.description,
        xp_reward: ach.xp_reward,
      });

      if (wsHub) {
        wsHub.sendToUser(userId, {
          type: 'achievement:unlocked',
          payload: {
            id: Number(notifRes.lastInsertRowid),
            code: ach.code,
            title,
            message,
            xp_reward: ach.xp_reward,
            created_at: new Date().toISOString(),
          },
        });
      }
    }
  }

  return unlockedNow;
}
