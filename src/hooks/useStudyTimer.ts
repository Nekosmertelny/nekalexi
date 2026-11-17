import { useCallback, useEffect, useRef, useState } from 'react';

export interface StudyTimerState {
  durationSeconds: number;
  remainingMs: number;
  isRunning: boolean;
  progress: number; // 1 -> 0 smoothly
  formattedTime: string;
  start: () => void;
  pause: () => void;
  reset: () => void;
  setDurationMinutes: (minutes: number) => void;
}

function playGentleChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.16);
      gain.gain.setValueAtTime(0.001, now + i * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.16 + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.16 + 0.7);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.16);
      osc.stop(now + i * 0.16 + 0.75);
    });
  } catch {
    // Ignore audio context restrictions
  }
}

export function formatTimerClock(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function useStudyTimer(defaultMinutes = 60, onComplete?: () => void): StudyTimerState {
  const [durationSeconds, setDurationSeconds] = useState(defaultMinutes * 60);
  const [remainingMs, setRemainingMs] = useState(defaultMinutes * 60 * 1000);
  const [isRunning, setIsRunning] = useState(false);

  const endTimestampRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (!isRunning) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    endTimestampRef.current = performance.now() + remainingMs;

    const tick = () => {
      if (!endTimestampRef.current) return;
      const left = Math.max(0, endTimestampRef.current - performance.now());
      setRemainingMs(left);
      if (left <= 0) {
        setIsRunning(false);
        endTimestampRef.current = null;
        playGentleChime();
        onCompleteRef.current?.();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isRunning]);

  const start = useCallback(() => {
    if (remainingMs <= 0) {
      setRemainingMs(durationSeconds * 1000);
    }
    setIsRunning(true);
  }, [remainingMs, durationSeconds]);

  const pause = useCallback(() => {
    setIsRunning(false);
  }, []);

  const reset = useCallback(() => {
    setIsRunning(false);
    setRemainingMs(durationSeconds * 1000);
  }, [durationSeconds]);

  const setDurationMinutes = useCallback((minutes: number) => {
    const clamped = Math.max(1, Math.min(180, Math.round(minutes)));
    setIsRunning(false);
    setDurationSeconds(clamped * 60);
    setRemainingMs(clamped * 60 * 1000);
  }, []);

  const totalMs = Math.max(1, durationSeconds * 1000);
  const progress = Math.max(0, Math.min(1, remainingMs / totalMs));

  return {
    durationSeconds,
    remainingMs,
    isRunning,
    progress,
    formattedTime: formatTimerClock(remainingMs),
    start,
    pause,
    reset,
    setDurationMinutes,
  };
}
