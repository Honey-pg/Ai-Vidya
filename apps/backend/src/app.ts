import express from 'express';
import cors from 'cors';
import { clerkMiddleware } from '@clerk/express';
import assignmentRoutes from './routes/assignments';
import analyticsRoutes from './routes/analytics';
import studentAnalyticsRoutes from './routes/studentAnalytics';
import classesRoutes from './routes/classes';
import submissionRoutes from './routes/submissions';
import {
  requireAuthenticatedUser,
  syncVedaUser,
  requireTeacher,
  requireStudent,
} from './middleware/authContext';

const app = express();

const corsOrigin =
  process.env.NODE_ENV === 'production'
    ? process.env.FRONTEND_URL || 'http://localhost:3000'
    : true; // reflect requesting origin — fixes LAN IPs (e.g. 192.168.x.x:3000) during dev

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  })
);

app.use(clerkMiddleware());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/assignments', assignmentRoutes);

app.use('/api/classes', classesRoutes);

app.use('/api/submissions', submissionRoutes);

app.use(
  '/api/analytics/student',
  requireAuthenticatedUser,
  syncVedaUser,
  requireStudent,
  studentAnalyticsRoutes
);

app.use(
  '/api/analytics',
  requireAuthenticatedUser,
  syncVedaUser,
  requireTeacher,
  analyticsRoutes
);

export default app;
