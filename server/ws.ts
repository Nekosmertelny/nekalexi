import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type Database from 'better-sqlite3';
import { verifyJwt } from './auth.ts';

export interface WsEvent {
  type:
    | 'connected'
    | 'notification:new'
    | 'achievement:unlocked'
    | 'leaderboard:updated'
    | 'reminder:due'
    | 'admin:broadcast';
  payload: unknown;
  timestamp: string;
}

export class WsNotificationHub {
  private wss: WebSocketServer;
  private clientsByUser = new Map<number, Set<WebSocket>>();
  private reminderTimer: NodeJS.Timeout | null = null;

  private upgradeListener: ((req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void) | null = null;

  constructor(private server: HttpServer, private db: Database.Database) {
    this.wss = new WebSocketServer({ noServer: true });

    this.upgradeListener = (req, socket, head) => {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    };
    this.server.on('upgrade', this.upgradeListener);

    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '/ws', 'http://localhost');
      const token = url.searchParams.get('token');
      const payload = token ? verifyJwt(token) : null;

      if (!payload) {
        ws.close(4001, 'Unauthorized');
        return;
      }

      const userId = payload.userId;
      if (!this.clientsByUser.has(userId)) {
        this.clientsByUser.set(userId, new Set());
      }
      this.clientsByUser.get(userId)!.add(ws);

      this.sendSocket(ws, {
        type: 'connected',
        payload: { userId, onlineUsers: this.clientsByUser.size },
        timestamp: new Date().toISOString(),
      });

      ws.on('close', () => {
        const set = this.clientsByUser.get(userId);
        if (set) {
          set.delete(ws);
          if (set.size === 0) {
            this.clientsByUser.delete(userId);
          }
        }
      });

      ws.on('error', () => {
        // Ignore transient socket errors
      });
    });

    // Check daily reminders every 60 seconds for connected users
    this.reminderTimer = setInterval(() => {
      this.checkDailyReminders();
    }, 60_000);
  }

  private sendSocket(ws: WebSocket, event: WsEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  public sendToUser(userId: number, event: Omit<WsEvent, 'timestamp'>): void {
    const sockets = this.clientsByUser.get(userId);
    if (!sockets) return;
    const fullEvent: WsEvent = { ...event, timestamp: new Date().toISOString() };
    for (const ws of sockets) {
      this.sendSocket(ws, fullEvent);
    }
  }

  public broadcastAll(event: Omit<WsEvent, 'timestamp'>): void {
    const fullEvent: WsEvent = { ...event, timestamp: new Date().toISOString() };
    for (const sockets of this.clientsByUser.values()) {
      for (const ws of sockets) {
        this.sendSocket(ws, fullEvent);
      }
    }
  }

  public getOnlineCount(): number {
    return this.clientsByUser.size;
  }

  private checkDailyReminders(): void {
    if (this.clientsByUser.size === 0) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const todayStr = now.toISOString().slice(0, 10);

    for (const userId of this.clientsByUser.keys()) {
      const user = this.db
        .prepare('SELECT id, reminder_enabled, reminder_time, daily_goal FROM users WHERE id = ? AND is_active = 1')
        .get(userId) as
        | { id: number; reminder_enabled: number; reminder_time: string; daily_goal: number }
        | undefined;

      if (!user || !user.reminder_enabled || user.reminder_time !== hhmm) continue;

      const todayCount = (
        this.db
          .prepare("SELECT COUNT(*) as cnt FROM review_logs WHERE user_id = ? AND date(reviewed_at) = ?")
          .get(userId, todayStr) as { cnt: number }
      ).cnt;

      if (todayCount < user.daily_goal) {
        const alreadySentToday = this.db
          .prepare(
            "SELECT 1 FROM notifications WHERE user_id = ? AND type = 'reminder' AND title = 'Время ежедневной практики' AND date(created_at) = ?"
          )
          .get(userId, todayStr);
        if (alreadySentToday) continue;

        const remaining = user.daily_goal - todayCount;
        const title = 'Время ежедневной практики';
        const message = `До вашей дневной цели осталось повторить ${remaining} слов.`;
        const res = this.db
          .prepare('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)')
          .run(userId, 'reminder', title, message);

        this.sendToUser(userId, {
          type: 'reminder:due',
          payload: {
            id: Number(res.lastInsertRowid),
            type: 'reminder',
            title,
            message,
            is_read: 0,
            created_at: new Date().toISOString(),
          },
        });
      }
    }
  }

  public close(): void {
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
    }
    if (this.upgradeListener) {
      this.server.off('upgrade', this.upgradeListener);
      this.upgradeListener = null;
    }
    this.wss.close();
  }
}
