import { useEffect, useRef, useState } from 'react';

export interface WsIncomingEvent {
  type:
    | 'connected'
    | 'notification:new'
    | 'achievement:unlocked'
    | 'leaderboard:updated'
    | 'reminder:due'
    | 'admin:broadcast';
  payload: Record<string, unknown>;
  timestamp: string;
}

export function useWebSocketNotifications(
  token: string | null,
  onEvent: (event: WsIncomingEvent) => void
) {
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!token) {
      setConnected(false);
      return;
    }

    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;
    let attempt = 0;

    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };

      ws.onmessage = (msg) => {
        try {
          const parsed = JSON.parse(msg.data) as WsIncomingEvent;
          onEventRef.current(parsed);
        } catch {
          // Ignore malformed frame
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!disposed) {
          const delay = Math.min(15000, 1000 * Math.pow(2, attempt));
          attempt += 1;
          reconnectTimer = window.setTimeout(connect, delay);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [token]);

  return { connected };
}
