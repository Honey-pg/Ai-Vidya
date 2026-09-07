import { Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis';
import { AssignmentModel } from '../models/Assignment';
import { SubmissionModel, type IAnswerItem } from '../models/Submission';
import { gradeOpenEndedAnswers, type OpenEndedGradeItem } from '../services/aiService';
import { emitToSubmission } from '../socket';
import type { GeneratedPaper, Question, GradingWSEvent } from '@vedaai/shared/types';

interface GradingJobData {
  submissionId: string;
}

function buildQuestionMap(paper: GeneratedPaper): Map<string, Question> {
  const map = new Map<string, Question>();
  for (const section of paper.sections) {
    for (const q of section.questions) {
      map.set(q.id, q);
    }
  }
  return map;
}

function emitGrading(
  submissionId: string,
  assignmentId: string,
  type: GradingWSEvent['type'],
  extra?: Partial<GradingWSEvent>
): void {
  const event: GradingWSEvent = {
    type,
    assignmentId,
    submissionId,
    ...extra,
  };
  emitToSubmission(submissionId, type, event);
}

const gradingWorker = new Worker(
  'submission-grading',
  async (job: Job<GradingJobData>) => {
    const { submissionId } = job.data;

    const submission = await SubmissionModel.findById(submissionId);
    if (!submission) {
      throw new Error(`Submission ${submissionId} not found`);
    }

    const assignmentId = String(submission.assignmentId);

    if (submission.status !== 'ai_pending') {
      // Already graded or finalized — nothing to do
      return { skipped: true, status: submission.status };
    }

    const assignment = await AssignmentModel.findById(submission.assignmentId);
    if (!assignment?.result) {
      throw new Error(`Assignment ${assignmentId} has no paper result`);
    }

    const paper = assignment.result as unknown as GeneratedPaper;
    const questionMap = buildQuestionMap(paper);

    emitGrading(submissionId, assignmentId, 'grading:started', {
      progress: 10,
      message: 'Starting AI grading…',
    });

    const toGrade: OpenEndedGradeItem[] = [];
    for (const ans of submission.answers) {
      if (ans.score !== undefined && ans.score !== null) continue;
      const q = questionMap.get(ans.questionId);
      if (!q) continue;
      if (q.type !== 'short_answer' && q.type !== 'long_answer') continue;

      toGrade.push({
        questionId: ans.questionId,
        questionText: q.text,
        type: q.type,
        marks: q.marks,
        difficulty: q.difficulty,
        referenceAnswer: q.correctAnswer ?? '',
        studentAnswer: ans.value,
      });
    }

    if (toGrade.length === 0) {
      // Nothing left for AI — finalize as auto_graded aggregate
      let total = 0;
      let max = 0;
      for (const a of submission.answers) {
        if (typeof a.maxScore === 'number') max += a.maxScore;
        if (typeof a.score === 'number') total += a.score;
      }
      submission.score = total;
      submission.maxScore = max || submission.maxScore;
      submission.status = 'ai_graded';
      await submission.save();

      emitGrading(submissionId, assignmentId, 'grading:completed', {
        progress: 100,
        message: 'No open-ended questions needed AI grading.',
      });
      return { graded: 0 };
    }

    emitGrading(submissionId, assignmentId, 'grading:progress', {
      progress: 30,
      message: `Grading ${toGrade.length} open-ended answer(s)…`,
    });

    try {
      const grades = await gradeOpenEndedAnswers(toGrade, {
        onProgress: (message, progress) => {
          emitGrading(submissionId, assignmentId, 'grading:progress', {
            progress: progress ?? 50,
            message,
          });
        },
      });

      const gradeById = new Map(grades.map((g) => [g.questionId, g]));

      const updatedAnswers: IAnswerItem[] = submission.answers.map((ans: IAnswerItem) => {
        const g = gradeById.get(ans.questionId);
        if (!g) return ans;

        return {
          questionId: ans.questionId,
          value: ans.value,
          maxScore: ans.maxScore,
          score: g.score,
          feedback: g.feedback,
          aiScore: g.score,
          aiFeedback: g.feedback,
          scoreSource: 'ai' as const,
        };
      });

      let totalScore = 0;
      let totalMax = 0;
      for (const a of updatedAnswers) {
        if (typeof a.maxScore === 'number') totalMax += a.maxScore;
        if (typeof a.score === 'number') totalScore += a.score;
      }

      submission.answers = updatedAnswers;
      submission.score = totalScore;
      submission.maxScore = totalMax || submission.maxScore;
      submission.status = 'ai_graded';
      await submission.save();

      emitGrading(submissionId, assignmentId, 'grading:completed', {
        progress: 100,
        message: 'AI grading complete. Teacher can review or override.',
      });

      return { graded: grades.length, score: totalScore, maxScore: totalMax };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown grading error';
      emitGrading(submissionId, assignmentId, 'grading:failed', {
        error: errorMessage,
        message: 'AI grading failed.',
      });
      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 2,
  }
);

gradingWorker.on('completed', (job) => {
  console.log(`Grading job ${job.id} completed for submission ${job.data.submissionId}`);
});

gradingWorker.on('failed', (job, err) => {
  console.error(`Grading job ${job?.id} failed:`, err.message);
});

export { gradingWorker };
