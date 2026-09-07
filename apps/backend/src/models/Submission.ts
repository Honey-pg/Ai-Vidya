import mongoose, { Schema, Document } from 'mongoose';

/**
 * The grading status of a submission.
 *
 *   - `submitted`  – student has submitted; not yet graded
 *   - `auto_graded` – fully scored by deterministic rules (MCQ / true_false / fill_in_blank)
 *   - `ai_pending`  – AI scoring requested for open-ended questions; result not yet returned
 *   - `ai_graded`   – AI has returned scores; teacher can still override
 *   - `graded`      – final; teacher has reviewed / confirmed / overridden
 */
export type SubmissionStatus =
  | 'submitted'
  | 'auto_graded'
  | 'ai_pending'
  | 'ai_graded'
  | 'graded';

export type ScoreSource = 'auto' | 'ai' | 'teacher';

/** One answer item mirrors the shape of a Question in GeneratedPaper */
export interface IAnswerItem {
  /** Matches Question.id from GeneratedPaper.sections[].questions[] */
  questionId: string;
  /** The text/letter the student wrote or selected */
  value: string;
  /** Authoritative marks awarded (auto / AI / teacher) */
  score?: number;
  /** Max marks possible for this question (copied from GeneratedPaper at submit time) */
  maxScore?: number;
  /** Authoritative feedback text */
  feedback?: string;
  /** Immutable AI suggestion — preserved across teacher overrides */
  aiScore?: number;
  aiFeedback?: string;
  /** Who last set the authoritative score/feedback */
  scoreSource?: ScoreSource;
}

export interface ISubmission extends Document {
  /** Mongo _id of the parent Assignment */
  assignmentId: mongoose.Types.ObjectId;
  /** Clerk user id of the submitting student */
  studentId: string;
  /** Raw answer payload submitted by the student */
  answers: IAnswerItem[];
  /** Aggregate score across all graded questions (null until at least partial grading) */
  score: number | null;
  /** Max possible total score (computed at submit time from the paper) */
  maxScore: number | null;
  status: SubmissionStatus;
  /** Timestamp when final/teacher grading was applied */
  gradedAt?: Date;
  /** Clerk user id of the teacher who applied an override (optional) */
  gradedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AnswerItemSchema = new Schema<IAnswerItem>(
  {
    questionId: { type: String, required: true },
    value: { type: String, required: true, default: '' },
    score: { type: Number },
    maxScore: { type: Number },
    feedback: { type: String },
    aiScore: { type: Number },
    aiFeedback: { type: String },
    scoreSource: {
      type: String,
      enum: ['auto', 'ai', 'teacher'],
    },
  },
  { _id: false }
);

const SubmissionSchema = new Schema<ISubmission>(
  {
    assignmentId: { type: Schema.Types.ObjectId, required: true, ref: 'Assignment', index: true },
    studentId: { type: String, required: true, index: true },
    answers: { type: [AnswerItemSchema], required: true, default: [] },
    score: { type: Number, default: null },
    maxScore: { type: Number, default: null },
    status: {
      type: String,
      enum: ['submitted', 'auto_graded', 'ai_pending', 'ai_graded', 'graded'],
      default: 'submitted',
    },
    gradedAt: { type: Date },
    gradedBy: { type: String },
  },
  { timestamps: true }
);

// Compound unique index: one submission per student per assignment
SubmissionSchema.index({ assignmentId: 1, studentId: 1 }, { unique: true });

// Fast look-up for "all submissions for an assignment" (teacher view)
SubmissionSchema.index({ assignmentId: 1, createdAt: -1 });

// Fast look-up for "all submissions by a student" (student history)
SubmissionSchema.index({ studentId: 1, createdAt: -1 });

export const SubmissionModel =
  mongoose.models.Submission ??
  mongoose.model<ISubmission>('Submission', SubmissionSchema);
