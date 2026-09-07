import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AssignmentModel } from '../models/Assignment';
import { SubmissionModel } from '../models/Submission';
import { requireAuthenticatedUser, syncVedaUser, requireStudent, requireTeacher } from '../middleware/authContext';
import { gradeQuestion } from '../utils/gradingUtils';
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flatten all questions from a GeneratedPaper into a single lookup map
 * keyed by question.id.
 */
function buildQuestionMap(paper: GeneratedPaper): Map<string, Question> {
  const map = new Map<string, Question>();
  for (const section of paper.sections) {
    for (const q of section.questions) {
      map.set(q.id, q);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// POST /:assignmentId/submit  — student submits answers
// ---------------------------------------------------------------------------

router.post(
  '/:assignmentId/submit',
  requireStudent,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { assignmentId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
        res.status(400).json({ error: 'Invalid assignmentId', code: 'BAD_REQUEST' });
        return;
      }

      const body = submitBodySchema.parse(req.body);
      const studentId = req.vedaUser!.clerkUserId;

      // ── 1. Load assignment & verify the student has access ──────────────
      const assignment = await AssignmentModel.findById(assignmentId);
      if (!assignment) {
        res.status(404).json({ error: 'Assignment not found', code: 'NOT_FOUND' });
        return;
      }

      const studentEmail = req.vedaUser!.email?.trim().toLowerCase() ?? '';
      const hasAccess =
        assignment.studentIds.includes(studentId) ||
        (studentEmail && assignment.studentEmails.includes(studentEmail));

      if (!hasAccess) {
        res.status(404).json({ error: 'Assignment not found', code: 'NOT_FOUND' });
        return;
      }

      // ── 2. Assignment must be completed (paper generated) ───────────────
      if (assignment.status !== 'completed' || !assignment.result) {
        res.status(409).json({
          error: 'Assignment paper is not ready yet',
          code: 'NOT_READY',
        });
        return;
      }

      const paper = assignment.result as unknown as GeneratedPaper;
      const questionMap = buildQuestionMap(paper);

      // ── 3. Grade each answer deterministically where possible ───────────
      let totalScore = 0;
      let totalMaxScore = 0;
      let needsAI = false;

      const gradedAnswers = body.answers.map((ans) => {
        const question = questionMap.get(ans.questionId);
        if (!question) {
          // Unknown questionId — skip gracefully
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
          // Needs AI grading
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
        };
      });

      // ── 4. Determine final status ────────────────────────────────────────
      const status = needsAI ? 'ai_pending' : 'auto_graded';

      // ── 5. Upsert submission (prevent double-submit) ─────────────────────
      let submission;
      try {
        submission = await SubmissionModel.findOneAndUpdate(
          { assignmentId: new mongoose.Types.ObjectId(assignmentId), studentId },
          {
            $set: {
              answers: gradedAnswers,
              score: needsAI ? null : totalScore,
              maxScore: totalMaxScore || null,
              status,
            },
            $setOnInsert: {
              assignmentId: new mongoose.Types.ObjectId(assignmentId),
              studentId,
            },
          },
          { upsert: true, new: true }
        );
      } catch (err: unknown) {
        // Mongo duplicate key on a race condition — return existing
        if ((err as { code?: number }).code === 11000) {
          submission = await SubmissionModel.findOne({
            assignmentId: new mongoose.Types.ObjectId(assignmentId),
            studentId,
          });
          res.status(409).json({
            error: 'You have already submitted this assignment',
            code: 'ALREADY_SUBMITTED',
            submissionId: submission?._id,
          });
          return;
        }
        throw err;
      }

      res.status(201).json({
        submissionId: submission._id,
        status,
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
      const { assignmentId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
        res.status(400).json({ error: 'Invalid assignmentId', code: 'BAD_REQUEST' });
        return;
      }

      const studentId = req.vedaUser!.clerkUserId;

      const submission = await SubmissionModel.findOne({
        assignmentId: new mongoose.Types.ObjectId(assignmentId),
        studentId,
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
// GET /:assignmentId  — teacher fetches all submissions for an assignment
// ---------------------------------------------------------------------------

router.get(
  '/:assignmentId',
  requireTeacher,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { assignmentId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
        res.status(400).json({ error: 'Invalid assignmentId', code: 'BAD_REQUEST' });
        return;
      }

      // Verify the requesting teacher owns this assignment
      const assignment = await AssignmentModel.findById(assignmentId).lean();
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
