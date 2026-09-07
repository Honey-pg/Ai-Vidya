import { Server } from 'socket.io';
import http from 'http';
import { verifyToken } from '@clerk/backend';
import { AssignmentModel } from '../models/Assignment';
import { SubmissionModel } from '../models/Submission';
import { UserModel } from '../models/User';
import { env } from '../config/env';
import { canAccessAssignment, normalizeUserEmail } from '../utils/studentAssignmentScope';

export let io: Server;

export function initSocket(server: http.Server): void {
  const socketCorsOrigin =
    process.env.NODE_ENV === 'production'
      ? process.env.FRONTEND_URL || 'http://localhost:3000'
      : true;

  io = new Server(server, {
    cors: {
      origin: socketCorsOrigin,
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const authHdr = socket.handshake.headers.authorization;
      const bearer =
        typeof authHdr === 'string' && /^Bearer\s+/i.test(authHdr)
          ? authHdr.replace(/^Bearer\s+/i, '').trim()
          : '';

      const bodyToken =
        typeof socket.handshake.auth === 'object' &&
        socket.handshake.auth !== null &&
        'token' in socket.handshake.auth
          ? String((socket.handshake.auth as { token?: unknown }).token ?? '').trim()
          : '';

      const token = bearer || bodyToken;
      if (!token) {
        next(new Error('Unauthorized'));
        return;
      }

      const verified = await verifyToken(token, {
        secretKey: env.CLERK_SECRET_KEY,
      });
      const sub = verified.sub;
      if (!sub) {
        next(new Error('Unauthorized'));
        return;
      }
      (socket.data as { clerkUserId: string }).clerkUserId = sub;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const clerkUserId = (socket.data as { clerkUserId?: string }).clerkUserId ?? '';

    socket.on('subscribe:assignment', async (assignmentId: string) => {
      if (!assignmentId || !clerkUserId) return;
      try {
        const doc = await AssignmentModel.findById(assignmentId).lean<{
          teacherId: string;
          studentIds?: string[];
          studentEmails?: string[];
        } | null>();
        if (!doc) return;

        const u = await UserModel.findOne({ clerkUserId }).lean<{
          email?: string | null;
          role?: 'teacher' | 'student';
        }>();
        const email = normalizeUserEmail({ email: u?.email });
        const role = u?.role === 'teacher' ? 'teacher' : 'student';

        if (!canAccessAssignment(clerkUserId, role, email, doc)) return;
        await socket.join(`assignment:${assignmentId}`);
      } catch (e) {
        console.error('subscribe:assignment', e);
      }
    });

    socket.on('unsubscribe:assignment', (assignmentId: string) => {
      if (assignmentId) socket.leave(`assignment:${assignmentId}`);
    });

    /**
     * Submission rooms are private: only the submitting student or the
     * assignment's teacher may join (avoids peer grading-event leakage).
     */
    socket.on('subscribe:submission', async (submissionId: string) => {
      if (!submissionId || !clerkUserId) return;
      try {
        const submission = await SubmissionModel.findById(submissionId).lean<{
          studentId: string;
          assignmentId: unknown;
        } | null>();
        if (!submission) return;

        if (submission.studentId === clerkUserId) {
          await socket.join(`submission:${submissionId}`);
          return;
        }

        const assignment = await AssignmentModel.findById(submission.assignmentId).lean<{
          teacherId: string;
        } | null>();
        if (!assignment || assignment.teacherId !== clerkUserId) return;

        await socket.join(`submission:${submissionId}`);
      } catch (e) {
        console.error('subscribe:submission', e);
      }
    });

    socket.on('unsubscribe:submission', (submissionId: string) => {
      if (submissionId) socket.leave(`submission:${submissionId}`);
    });
  });
}

export function emitToAssignment(assignmentId: string, event: string, data: unknown): void {
  if (io) {
    io.to(`assignment:${assignmentId}`).emit(event, data);
  }
}

export function emitToSubmission(submissionId: string, event: string, data: unknown): void {
  if (io) {
    io.to(`submission:${submissionId}`).emit(event, data);
  }
}
