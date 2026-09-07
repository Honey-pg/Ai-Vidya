import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { AssignmentModel } from '../models/Assignment';
import { assignmentQueue } from '../queues/assignmentQueue';
import { redisClient } from '../config/redis';
import { upload } from '../middleware/upload';
import { extractTextFromFile } from '../services/pdfService';
import {
  requireAuthenticatedUser,
  syncVedaUser,
  requireTeacher,
} from '../middleware/authContext';
import { sanitizeAssignmentRecordForStudent } from '../utils/sanitizeAssignmentForStudent';
import {
  normalizeUserEmail,
  buildAssignmentsListFilter,
  canAccessAssignment,
} from '../utils/studentAssignmentScope';

const router = Router();

router.use(requireAuthenticatedUser);
router.use(syncVedaUser);

const CACHE_TTL = 3600; // 1 hour

const questionConfigSchema = z.object({
  type: z.enum(['mcq', 'short_answer', 'long_answer', 'true_false', 'fill_in_blank']),
  count: z.number().min(1, 'At least 1 question').max(50),
  marksPerQuestion: z.number().min(1, 'At least 1 mark'),
  difficulty: z.enum(['easy', 'medium', 'hard']),
});

const assignmentInputSchema = z.object({
  title: z.string().min(3, 'Title must be at least 3 characters'),
  subject: z.string().min(1, 'Subject is required'),
  topic: z.string().min(1, 'Topic is required'),
  gradeLevel: z.string().min(1, 'Grade level is required'),
  dueDate: z.string().min(1, 'Due date is required'),
  questionConfigs: z
    .string()
    .transform((val) => JSON.parse(val))
    .pipe(z.array(questionConfigSchema).min(1, 'Add at least one question type')),
  additionalInstructions: z.string().optional(),
});

const optionalStudentIds = z
  .string()
  .optional()
  .transform((val) => {
    if (!val) return [] as string[];
    try {
      const parsed = JSON.parse(val);
      const arr = z.array(z.string().min(1)).parse(parsed);
      return arr;
    } catch {
      return [] as string[];
    }
  });

const optionalStudentEmails = z
  .string()
  .optional()
  .transform((val) => {
    if (!val) return [] as string[];
    try {
      const parsed = JSON.parse(val);
      const arr = z.array(z.union([z.string(), z.number()])).parse(parsed);
      return [...new Set(arr.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
    } catch {
      return [] as string[];
    }
  });

router.post(
  '/',
  requireTeacher,
  upload.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const validated = assignmentInputSchema.parse(req.body);
      const teacherId = req.vedaUser!.clerkUserId;
      const studentIds = optionalStudentIds.parse(req.body.studentIds as string | undefined);
      const studentEmails = optionalStudentEmails.parse(req.body.studentEmails as string | undefined);

      let fileContent: string | undefined;
      if (req.file) {
        fileContent = await extractTextFromFile(req.file.buffer, req.file.mimetype);
      }

      const assignment = await AssignmentModel.create({
        teacherId,
        studentIds,
        studentEmails,
        input: {
          ...validated,
          fileContent,
        },
        status: 'pending',
      });

      const job = await assignmentQueue.add('generate', {
        assignmentId: assignment._id.toString(),
      });

      await AssignmentModel.findByIdAndUpdate(assignment._id, {
        jobId: job.id,
      });

      await redisClient.setex(
        `assignment:${assignment._id}`,
        CACHE_TTL,
        JSON.stringify(assignment.toJSON())
      );

      res.status(201).json({
        assignmentId: assignment._id,
        jobId: job.id,
        status: 'pending',
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
      console.error('Error creating assignment:', error);
      res.status(500).json({
        error: 'Failed to create assignment',
        code: 'INTERNAL_ERROR',
      });
    }
  }
);

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.vedaUser!;
    const clerkId = user.clerkUserId;
    const normalizedEmail = normalizeUserEmail(user);
    const page = parseInt(req.query.page as string) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;
    const status = req.query.status as string | undefined;

    const filter: Record<string, unknown> = buildAssignmentsListFilter(
      user.role,
      clerkId,
      normalizedEmail
    );
    if (status) Object.assign(filter, { status });

    let listQuery = AssignmentModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit);
    if (user.role === 'student') listQuery = listQuery.select('-result');

    const [assignments, total] = await Promise.all([listQuery.lean(), AssignmentModel.countDocuments(filter)]);

    res.json({
      assignments,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error listing assignments:', error);
    res.status(500).json({
      error: 'Failed to list assignments',
      code: 'INTERNAL_ERROR',
    });
  }
});

function sendAssignmentPayload(
  res: Response,
  role: 'teacher' | 'student',
  payload: Record<string, unknown>
): void {
  if (role === 'student') {
    res.json(sanitizeAssignmentRecordForStudent(payload));
    return;
  }
  res.json(payload);
}

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const user = req.vedaUser!;

    const normalizedEmail = normalizeUserEmail(user);

    const cachedRaw = await redisClient.get(`assignment:${id}`);
    if (cachedRaw) {
      try {
        const cachedDoc = JSON.parse(cachedRaw) as {
          teacherId?: string;
          studentIds?: string[];
          studentEmails?: string[];
          status?: string;
          [key: string]: unknown;
        };

        if (typeof cachedDoc.teacherId === 'string') {
          const gated = {
            teacherId: cachedDoc.teacherId,
            studentIds: cachedDoc.studentIds,
            studentEmails: cachedDoc.studentEmails,
          };
          if (!canAccessAssignment(user.clerkUserId, user.role, normalizedEmail, gated)) {
            res.status(404).json({ error: 'Assignment not found', code: 'NOT_FOUND' });
            return;
          }
          if (cachedDoc.status === 'completed' || cachedDoc.status === 'failed') {
            sendAssignmentPayload(res, user.role, cachedDoc as Record<string, unknown>);
            return;
          }
        }
      } catch {
        /* malformed cache — load from Mongo */
      }
    }

    const assignment = await AssignmentModel.findById(id);
    if (!assignment) {
      res.status(404).json({ error: 'Assignment not found', code: 'NOT_FOUND' });
      return;
    }

    if (!canAccessAssignment(user.clerkUserId, user.role, normalizedEmail, assignment)) {
      res.status(404).json({ error: 'Assignment not found', code: 'NOT_FOUND' });
      return;
    }

    await redisClient.setex(`assignment:${id}`, CACHE_TTL, JSON.stringify(assignment.toJSON()));

    sendAssignmentPayload(res, user.role, assignment.toJSON() as Record<string, unknown>);
  } catch (error) {
    console.error('Error fetching assignment:', error);
    res.status(500).json({
      error: 'Failed to fetch assignment',
      code: 'INTERNAL_ERROR',
    });
  }
});

router.post('/:id/regenerate', requireTeacher, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const user = req.vedaUser!;

    const assignment = await AssignmentModel.findById(id);
    if (!assignment || assignment.teacherId !== user.clerkUserId) {
      res.status(404).json({ error: 'Assignment not found', code: 'NOT_FOUND' });
      return;
    }

    assignment.status = 'pending';
    assignment.result = undefined;
    assignment.error = undefined;
    await assignment.save();

    const job = await assignmentQueue.add('generate', {
      assignmentId: id,
    });

    await AssignmentModel.findByIdAndUpdate(id, { jobId: job.id });

    await redisClient.del(`assignment:${id}`);

    res.json({ jobId: job.id, status: 'pending' });
  } catch (error) {
    console.error('Error regenerating assignment:', error);
    res.status(500).json({
      error: 'Failed to regenerate assignment',
      code: 'INTERNAL_ERROR',
    });
  }
});

router.delete('/:id', requireTeacher, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const user = req.vedaUser!;
    const assignment = await AssignmentModel.findById(id);
    if (!assignment || assignment.teacherId !== user.clerkUserId) {
      res.status(404).json({ error: 'Assignment not found', code: 'NOT_FOUND' });
      return;
    }
    await AssignmentModel.findByIdAndDelete(id);
    await redisClient.del(`assignment:${id}`);
    res.json({ message: 'Assignment deleted successfully' });
  } catch (error) {
    console.error('Error deleting assignment:', error);
    res.status(500).json({
      error: 'Failed to delete assignment',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
