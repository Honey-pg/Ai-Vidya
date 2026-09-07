import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AssignmentModel } from '../models/Assignment';
import { SubmissionModel, type IAnswerItem } from '../models/Submission';
import {
  requireAuthenticatedUser,
  syncVedaUser,
  requireStudent,
  requireTeacher,
} from '../middleware/authContext';
import { gradeQuestion } from '../utils/gradingUtils';
import {
  canAccessAssignment,
  normalizeUserEmail,
  isWithinSubmissionWindow,
} from '../utils/studentAssignmentScope';
import { gradingQueue } from '../queues/gradingQueue';
import type { GeneratedPaper, Question } from '@vedaai/shared/types';

const router = Router();

router.use(requireAuthenticatedUser, syncVedaUser);

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const answerItemSchema = z.object({
  questionId: z.string().min(1, 'questionId is required'),
  value: z.string(),
});

const submitBodySchema = z.object({
  answers: z.array(answerItemSchema).min(1, 'answers array must not be empty'),
});

const overrideAnswerSchema = z.object({
  questionId: z.string().min(1),
  score: z.number().min(0),
  feedback: z.string().optional(),
});

const overrideBodySchema = z.object({
  /** Partial per-question overrides; empty array = confirm AI scores as-is */
  answers: z.array(overrideAnswerSchema).default([]),
  /** If true, mark submission as final `graded` */
  finalize: z.boolean().optional().default(true),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildQuestionMap(paper: GeneratedPaper): Map<string, Question> {
  const map = new Map<string, Question>();
  for (const section of paper.sections) {
    for (const q of section.questions) {
      map.set(q.id, q);
    }
  }
  return map;
}

function paramAsString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function recomputeTotals(answers: IAnswerItem[]): { score: number; maxScore: number } {
  let score = 0;
  let maxScore = 0;
  for (const a of answers) {
    if (typeof a.maxScore === 'number') maxScore += a.maxScore;
    if (typeof a.score === 'number') score += a.score;
  }
  return { score, maxScore };
}

// ---------------------------------------------------------------------------
// POST /:assignmentId/submit  — student submits answers (insert-only)
// ---------------------------------------------------------------------------

router.post(
  '/:assignmentId/submit',
  requireStudent,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const assignmentId = paramAsString(req.params.assignmentId);

      if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
        res.status(400).json({ error: 'Invalid assignmentId', code: 'BAD_REQUEST' });
        return;
      }

      const body = submitBodySchema.parse(req.body);
      const user = req.vedaUser!;
      const studentId = user.clerkUserId;
      const normalizedEmail = normalizeUserEmail(user);

      const assignment = await AssignmentModel.findById(assignmentId);
      if (!assignment) {
        res.status(404).json({ error: 'Assignment not found', code: 'NOT_FOUND' });
        return;
      }

      if (!canAccessAssignment(studentId, 'student', normalizedEmail, assignment)) {
        res.status(404).json({ error: 'Assignment not found', code: 'NOT_FOUND' });
        return;
      }

      if (assignment.status !== 'completed' || !assignment.result) {
        res.status(409).json({
          error: 'Assignment paper is not ready yet',
          code: 'NOT_READY',
        });
        return;
      }

      if (!isWithinSubmissionWindow(assignment.input.dueDate)) {
        res.status(403).json({
          error: 'The submission window for this assignment has closed',
          code: 'PAST_DUE',
        });
        return;
      }

      const paper = assignment.result as unknown as GeneratedPaper;
      const questionMap = buildQuestionMap(paper);

      let totalScore = 0;
      let totalMaxScore = 0;
      let needsAI = false;

      const gradedAnswers: IAnswerItem[] = body.answers.map((ans) => {
        const question = questionMap.get(ans.questionId);
        if (!question) {
          return { questionId: ans.questionId, value: ans.value };
        }

        const maxScore = question.marks;
        totalMaxScore += maxScore;

        const result = gradeQuestion(ans.value, {
          type: question.type,
          correctAnswer: question.correctAnswer,
          marks: question.marks,
        });

        if (result === null) {
          needsAI = true;
          return { questionId: ans.questionId, value: ans.value, maxScore };
        }

        totalScore += result.score;
        return {
          questionId: ans.questionId,
          value: ans.value,
          score: result.score,
          maxScore,
          feedback: result.feedback,
          scoreSource: 'auto' as const,
        };
      });

      const status = needsAI ? 'ai_pending' : 'auto_graded';
      const assignmentOid = new mongoose.Types.ObjectId(assignmentId);

      // Insert-only: unique index + create; never overwrite an existing submission
      let submission;
      try {
        submission = await SubmissionModel.create({
          assignmentId: assignmentOid,
          studentId,
          answers: gradedAnswers,
          score: needsAI ? null : totalScore,
          maxScore: totalMaxScore || null,
          status,
        });
      } catch (err: unknown) {
        if ((err as { code?: number }).code === 11000) {
          const existing = await SubmissionModel.findOne({
            assignmentId: assignmentOid,
            studentId,
          });
          res.status(409).json({
            error: 'You have already submitted this assignment',
            code: 'ALREADY_SUBMITTED',
            submissionId: existing?._id,
            status: existing?.status,
          });
          return;
        }
        throw err;
      }

      if (needsAI) {
        await gradingQueue.add(
          'grade-submission',
          { submissionId: String(submission._id) },
          { jobId: `grade-${String(submission._id)}` }
        );
      }

      res.status(201).json({
        submissionId: submission._id,
        status: submission.status,
        score: submission.score,
        maxScore: submission.maxScore,
        needsAIGrading: needsAI,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: error.errors,
        });
        return;
      }
      console.error('submissions/submit', error);
      res.status(500).json({ error: 'Failed to submit assignment', code: 'INTERNAL_ERROR' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /:assignmentId/mine  — student fetches their own submission
// ---------------------------------------------------------------------------

router.get(
  '/:assignmentId/mine',
  requireStudent,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const assignmentId = paramAsString(req.params.assignmentId);

      if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
        res.status(400).json({ error: 'Invalid assignmentId', code: 'BAD_REQUEST' });
        return;
      }

      const user = req.vedaUser!;
      const normalizedEmail = normalizeUserEmail(user);

      const assignment = await AssignmentModel.findById(assignmentId).lean<{
        teacherId: string;
        studentIds?: string[];
        studentEmails?: string[];
      } | null>();
      if (
        !assignment ||
        !canAccessAssignment(user.clerkUserId, 'student', normalizedEmail, assignment)
      ) {
        res.status(404).json({ error: 'Assignment not found', code: 'NOT_FOUND' });
        return;
      }

      const submission = await SubmissionModel.findOne({
        assignmentId: new mongoose.Types.ObjectId(assignmentId),
        studentId: user.clerkUserId,
      }).lean();

      if (!submission) {
        res.status(404).json({ error: 'No submission found', code: 'NOT_FOUND' });
        return;
      }

      res.json(submission);
    } catch (error) {
      console.error('submissions/mine', error);
      res.status(500).json({ error: 'Failed to fetch submission', code: 'INTERNAL_ERROR' });
    }
  }
);

// ---------------------------------------------------------------------------
// PATCH /:submissionId/override  — teacher overrides AI / confirms grades
// ---------------------------------------------------------------------------

router.patch(
  '/:submissionId/override',
  requireTeacher,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const submissionId = paramAsString(req.params.submissionId);

      if (!mongoose.Types.ObjectId.isValid(submissionId)) {
        res.status(400).json({ error: 'Invalid submissionId', code: 'BAD_REQUEST' });
        return;
      }

      const body = overrideBodySchema.parse(req.body);
      const teacherId = req.vedaUser!.clerkUserId;

      const submission = await SubmissionModel.findById(submissionId);
      if (!submission) {
        res.status(404).json({ error: 'Submission not found', code: 'NOT_FOUND' });
        return;
      }

      const assignment = await AssignmentModel.findById(submission.assignmentId).lean<{
        teacherId: string;
      } | null>();
      if (!assignment || assignment.teacherId !== teacherId) {
        res.status(404).json({ error: 'Submission not found', code: 'NOT_FOUND' });
        return;
      }

      if (submission.status === 'ai_pending') {
        res.status(409).json({
          error: 'AI grading is still in progress',
          code: 'GRADING_IN_PROGRESS',
        });
        return;
      }

      const overrideById = new Map(body.answers.map((a) => [a.questionId, a]));

      for (const ans of submission.answers) {
        const ov = overrideById.get(ans.questionId);
        if (!ov) continue;

        const max = typeof ans.maxScore === 'number' ? ans.maxScore : ov.score;
        ans.score = Math.max(0, Math.min(max, ov.score));
        if (ov.feedback !== undefined) {
          ans.feedback = ov.feedback;
        }
        ans.scoreSource = 'teacher';
        // aiScore / aiFeedback intentionally left unchanged
      }

      const totals = recomputeTotals(submission.answers);
      submission.score = totals.score;
      submission.maxScore = totals.maxScore || submission.maxScore;

      if (body.finalize) {
        submission.status = 'graded';
        submission.gradedAt = new Date();
        submission.gradedBy = teacherId;
      }

      await submission.save();

      res.json({
        submissionId: submission._id,
        status: submission.status,
        score: submission.score,
        maxScore: submission.maxScore,
        answers: submission.answers,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: error.errors,
        });
        return;
      }
      console.error('submissions/override', error);
      res.status(500).json({ error: 'Failed to override grades', code: 'INTERNAL_ERROR' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /:assignmentId  — teacher fetches all submissions for an assignment
// ---------------------------------------------------------------------------

router.get(
  '/:assignmentId',
  requireTeacher,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const assignmentId = paramAsString(req.params.assignmentId);

      if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
        res.status(400).json({ error: 'Invalid assignmentId', code: 'BAD_REQUEST' });
        return;
      }

      const assignment = await AssignmentModel.findById(assignmentId).lean<{
        teacherId: string;
      } | null>();
      if (!assignment || assignment.teacherId !== req.vedaUser!.clerkUserId) {
        res.status(404).json({ error: 'Assignment not found', code: 'NOT_FOUND' });
        return;
      }

      const submissions = await SubmissionModel.find({
        assignmentId: new mongoose.Types.ObjectId(assignmentId),
      })
        .sort({ createdAt: -1 })
        .lean();

      res.json({ submissions, total: submissions.length });
    } catch (error) {
      console.error('submissions/list', error);
      res.status(500).json({ error: 'Failed to list submissions', code: 'INTERNAL_ERROR' });
    }
  }
);

export default router;
