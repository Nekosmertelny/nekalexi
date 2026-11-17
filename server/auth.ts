import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { Request, Response, NextFunction } from 'express';

const JWT_SECRET = process.env.JWT_SECRET || 'lexiforge-dev-jwt-secret-change-in-prod';
const JWT_EXPIRES_IN = '7d';

export interface JwtPayload {
  userId: number;
  email: string;
  role: 'user' | 'admin';
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

export function getCanonicalEmail(raw: string): string {
  const norm = normalizeEmail(raw);
  const atIndex = norm.lastIndexOf('@');
  if (atIndex === -1) return norm;
  let local = norm.slice(0, atIndex);
  let domain = norm.slice(atIndex + 1);

  const plusIdx = local.indexOf('+');
  if (plusIdx !== -1) {
    local = local.slice(0, plusIdx);
  }

  if (domain === 'googlemail.com') {
    domain = 'gmail.com';
  }
  if (domain === 'gmail.com') {
    local = local.replace(/\./g, '');
  }
  if (domain === 'ya.ru' || domain === 'yandex.com') {
    domain = 'yandex.ru';
  }

  return `${local}@${domain}`;
}

export function signJwt(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyJwt(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    if (!decoded || typeof decoded.userId !== 'number') return null;
    return decoded;
  } catch {
    return null;
  }
}

export function extractTokenFromRequest(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const cookies = cookieHeader.split(';');
    for (const c of cookies) {
      const [key, ...rest] = c.trim().split('=');
      if (key === 'lexiforge_token') {
        return decodeURIComponent(rest.join('='));
      }
    }
  }
  return null;
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = extractTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: 'Требуется авторизация (отсутствует JWT-токен)' });
    return;
  }
  const payload = verifyJwt(token);
  if (!payload) {
    res.status(401).json({ error: 'Недействительный или истекший JWT-токен' });
    return;
  }
  req.user = payload;
  next();
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Требуется авторизация' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Доступ запрещен: требуются права администратора' });
    return;
  }
  next();
}
