/**
 * gradingUtils.ts
 *
 * Pure, deterministic scoring functions for auto-gradable question types.
 * These are intentionally side-effect-free so they are easy to unit-test
 * and can be used in any context (route handler, worker, test suite).
 *
 * Supported types (deterministic):
 *   - MCQ            → exact letter/option match (case-insensitive, trimmed)
 *   - true_false     → canonical boolean string match ("true"/"false"/"yes"/"no")
 *   - fill_in_blank  → case-insensitive trim + optional near-match (levenshtein ≤ 1)
 *
 * Types requiring AI assist (not handled here):
 *   - short_answer
 *   - long_answer
 */

import type { QuestionType } from '@vedaai/shared/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GradeResult {
  /** Marks awarded (0 or maxScore for deterministic types) */
  score: number;
  /** Whether the answer was judged correct */
  correct: boolean;
  /** Optional human-readable feedback snippet */
  feedback?: string;
}

/** Minimal question shape needed for grading (subset of shared Question) */
export interface GradableQuestion {
  type: QuestionType;
  correctAnswer?: string;
  /** Max marks this question is worth */
  marks: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Normalise a string for comparison: lowercase + trim */
function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Simple Levenshtein distance (iterative, O(n*m) time, O(n) space).
 * Used for near-match in fill-in-blank.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? 0) + 1,          // insert
        (prev[j]   ?? 0) + 1,            // delete
        (prev[j - 1] ?? 0) + cost        // replace
      );
    }
    prev.splice(0, prev.length, ...curr);
  }

  return prev[b.length] ?? 0;
}

// ---------------------------------------------------------------------------
// MCQ grading
// ---------------------------------------------------------------------------

/**
 * Grade an MCQ answer.
 *
 * Accepts single-letter answers ("A", "b", "C") or full option strings.
 * Comparison is case-insensitive and trimmed.
 *
 * @param studentAnswer  – what the student submitted
 * @param correctAnswer  – the stored correct answer (e.g. "A" or "Paris")
 * @param marks          – max marks for this question
 */
export function gradeMCQ(
  studentAnswer: string,
  correctAnswer: string,
  marks: number
): GradeResult {
  const studentNorm = norm(studentAnswer);
  const correctNorm = norm(correctAnswer);
  const correct = studentNorm === correctNorm;
  return {
    score: correct ? marks : 0,
    correct,
    feedback: correct ? 'Correct.' : `Incorrect. The correct answer is "${correctAnswer}".`,
  };
}

// ---------------------------------------------------------------------------
// True / False grading
// ---------------------------------------------------------------------------

/** Map various student representations to a canonical boolean or null. */
function parseBool(raw: string): boolean | null {
  const s = norm(raw);
  if (s === 'true'  || s === 'yes' || s === '1' || s === 't' || s === 'y') return true;
  if (s === 'false' || s === 'no'  || s === '0' || s === 'f' || s === 'n') return false;
  return null;
}

/**
 * Grade a true/false answer.
 *
 * Tolerates "yes"/"no", "1"/"0", "t"/"f" in addition to "true"/"false".
 *
 * @param studentAnswer  – e.g. "True", "false", "yes"
 * @param correctAnswer  – e.g. "true" or "false"
 * @param marks          – max marks for this question
 */
export function gradeTrueFalse(
  studentAnswer: string,
  correctAnswer: string,
  marks: number
): GradeResult {
  const studentBool = parseBool(studentAnswer);
  const correctBool = parseBool(correctAnswer);

  if (studentBool === null) {
    return {
      score: 0,
      correct: false,
      feedback: `Could not interpret "${studentAnswer}" as true or false.`,
    };
  }
  if (correctBool === null) {
    // Fallback: plain string compare if correctAnswer isn't a recognised boolean
    return gradeMCQ(studentAnswer, correctAnswer, marks);
  }

  const correct = studentBool === correctBool;
  return {
    score: correct ? marks : 0,
    correct,
    feedback: correct
      ? 'Correct.'
      : `Incorrect. The correct answer is "${correctAnswer}".`,
  };
}

// ---------------------------------------------------------------------------
// Fill-in-blank grading
// ---------------------------------------------------------------------------

export interface FillInBlankOptions {
  /**
   * Allow near-match (Levenshtein distance ≤ 1)?
   * Useful for single-character typos in short words.
   * Default: false (exact match only).
   */
  allowNearMatch?: boolean;
  /**
   * Only apply near-match when the correct answer is at least this long.
   * Prevents "a" ≈ "b". Default: 4.
   */
  nearMatchMinLength?: number;
}

/**
 * Grade a fill-in-blank answer.
 *
 * Primary comparison: case-insensitive exact match after trimming.
 * Optional near-match: levenshtein distance ≤ 1 (typo tolerance).
 *
 * @param studentAnswer  – free-text answer from the student
 * @param correctAnswer  – expected answer stored in the question
 * @param marks          – max marks for this question
 * @param opts           – near-match configuration
 */
export function gradeFillInBlank(
  studentAnswer: string,
  correctAnswer: string,
  marks: number,
  opts: FillInBlankOptions = {}
): GradeResult {
  const { allowNearMatch = false, nearMatchMinLength = 4 } = opts;

  const studentNorm = norm(studentAnswer);
  const correctNorm = norm(correctAnswer);

  if (studentNorm === correctNorm) {
    return { score: marks, correct: true, feedback: 'Correct.' };
  }

  if (
    allowNearMatch &&
    correctNorm.length >= nearMatchMinLength &&
    levenshtein(studentNorm, correctNorm) <= 1
  ) {
    return {
      score: marks,
      correct: true,
      feedback: `Accepted (minor spelling variation).`,
    };
  }

  return {
    score: 0,
    correct: false,
    feedback: `Incorrect. The expected answer is "${correctAnswer}".`,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Grade a single question deterministically.
 *
 * Returns `null` for question types that require AI assistance
 * (short_answer, long_answer) — callers must handle the null case.
 *
 * @param studentAnswer – raw string submitted by the student
 * @param question      – gradable question metadata
 * @param fillOpts      – optional near-match config for fill_in_blank
 */
export function gradeQuestion(
  studentAnswer: string,
  question: GradableQuestion,
  fillOpts?: FillInBlankOptions
): GradeResult | null {
  const { type, correctAnswer, marks } = question;

  if (!correctAnswer) return null;

  switch (type) {
    case 'mcq':
      return gradeMCQ(studentAnswer, correctAnswer, marks);

    case 'true_false':
      return gradeTrueFalse(studentAnswer, correctAnswer, marks);

    case 'fill_in_blank':
      return gradeFillInBlank(studentAnswer, correctAnswer, marks, fillOpts);

    // AI-assisted types — not handled deterministically
    case 'short_answer':
    case 'long_answer':
      return null;

    default:
      return null;
  }
}
