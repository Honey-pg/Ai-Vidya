'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { io, Socket } from 'socket.io-client';
import type { GradingWSEvent } from '@vedaai/shared/types';

export type GradingSocketState = {
  status: 'idle' | 'started' | 'progress' | 'completed' | 'failed';
  progress: number;
  message: string;
  error?: string;
};

const INITIAL: GradingSocketState = {
  status: 'idle',
  progress: 0,
  message: '',
};

/**
 * Subscribe to AI grading progress for a single submission room.
 * Only the submitting student and assignment teacher may join (server-enforced).
 */
export function useGradingSocket(submissionId: string | null) {
  const { getToken, isSignedIn, isLoaded } = useAuth();
  const socketRef = useRef<Socket | null>(null);
  const [state, setState] = useState<GradingSocketState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    socketRef.current = null;
    setState(INITIAL);

    if (!isLoaded || !submissionId || !isSignedIn) {
      return;
    }

    (async () => {
      try {
        const token = await getToken();
        if (!token || cancelled) return;

        const wsUrl = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:4000';
        const socket = io(wsUrl, {
          transports: ['websocket', 'polling'],
          auth: { token },
        });
        if (cancelled) {
          socket.disconnect();
          return;
        }

        socketRef.current = socket;
        socket.emit('subscribe:submission', submissionId);

        socket.on('grading:started', (e: GradingWSEvent) => {
          if (e.submissionId !== submissionId) return;
          setState({
            status: 'started',
            progress: e.progress ?? 0,
            message: e.message || 'Starting AI grading…',
          });
        });

        socket.on('grading:progress', (e: GradingWSEvent) => {
          if (e.submissionId !== submissionId) return;
          setState({
            status: 'progress',
            progress: e.progress ?? 0,
            message: e.message || 'Grading…',
          });
        });

        socket.on('grading:completed', (e: GradingWSEvent) => {
          if (e.submissionId !== submissionId) return;
          setState({
            status: 'completed',
            progress: 100,
            message: e.message || 'Grading complete.',
          });
        });

        socket.on('grading:failed', (e: GradingWSEvent) => {
          if (e.submissionId !== submissionId) return;
          setState({
            status: 'failed',
            progress: 0,
            message: e.message || 'Grading failed.',
            error: e.error,
          });
        });
      } catch {
        /* REST polling fallback */
      }
    })();

    return () => {
      cancelled = true;
      const sock = socketRef.current;
      if (sock?.connected && submissionId) {
        sock.emit('unsubscribe:submission', submissionId);
      }
      sock?.disconnect();
      socketRef.current = null;
    };
  }, [submissionId, getToken, isLoaded, isSignedIn]);

  return state;
}
