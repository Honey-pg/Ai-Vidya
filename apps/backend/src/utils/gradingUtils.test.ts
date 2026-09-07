/**
 * Unit tests for gradingUtils.ts
 *
 * These are the first tests in the repo. They cover deterministic grading
 * paths only — no I/O, no DB, no network. 100 % pure function tests.
 *
 * Run with:  npx jest  (from apps/backend)
 */

import {
  gradeMCQ,
  gradeTrueFalse,
  gradeFillInBlank,
  gradeQuestion,
  levenshtein,
} from '../utils/gradingUtils';

// ---------------------------------------------------------------------------
// levenshtein (internal helper, exported for testing)
// ---------------------------------------------------------------------------

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('hello', 'hello')).toBe(0);
  });

  it('returns length of b when a is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
  });

  it('returns length of a when b is empty', () => {
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('returns 1 for single substitution', () => {
    expect(levenshtein('cat', 'bat')).toBe(1);
  });

  it('returns 1 for single insertion', () => {
    expect(levenshtein('colour', 'color')).toBe(1);
  });

  it('returns 1 for single deletion', () => {
    expect(levenshtein('color', 'colour')).toBe(1);
  });

  it('handles completely different strings', () => {
    expect(levenshtein('abc', 'xyz')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// gradeMCQ
// ---------------------------------------------------------------------------

describe('gradeMCQ', () => {
  it('awards full marks for exact match', () => {
    const r = gradeMCQ('A', 'A', 2);
    expect(r.correct).toBe(true);
    expect(r.score).toBe(2);
  });

  it('is case-insensitive', () => {
    const r = gradeMCQ('b', 'B', 3);
    expect(r.correct).toBe(true);
    expect(r.score).toBe(3);
  });

  it('is trim-insensitive', () => {
    const r = gradeMCQ('  C  ', 'C', 1);
    expect(r.correct).toBe(true);
  });

  it('awards 0 for wrong answer', () => {
    const r = gradeMCQ('C', 'A', 5);
    expect(r.correct).toBe(false);
    expect(r.score).toBe(0);
  });

  it('includes correct answer in feedback when wrong', () => {
    const r = gradeMCQ('D', 'B', 2);
    expect(r.feedback).toContain('B');
  });

  it('handles full-option strings, not just letters', () => {
    const r = gradeMCQ('Paris', 'paris', 4);
    expect(r.correct).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// gradeTrueFalse
// ---------------------------------------------------------------------------

describe('gradeTrueFalse', () => {
  const cases: Array<[string, string, boolean]> = [
    ['true',  'true',  true],
    ['false', 'false', true],
    ['True',  'true',  true],
    ['FALSE', 'false', true],
    ['yes',   'true',  true],
    ['no',    'false', true],
    ['Yes',   'true',  true],
    ['No',    'false', true],
    ['1',     'true',  true],
    ['0',     'false', true],
    ['t',     'true',  true],
    ['f',     'false', true],
    ['y',     'true',  true],
    ['n',     'false', true],
    // Wrong answers
    ['true',  'false', false],
    ['false', 'true',  false],
    ['yes',   'false', false],
    ['no',    'true',  false],
  ];

  it.each(cases)(
    'answer="%s" correct="%s" → correct=%s',
    (answer, correct, expected) => {
      const r = gradeTrueFalse(answer, correct, 1);
      expect(r.correct).toBe(expected);
      expect(r.score).toBe(expected ? 1 : 0);
    }
  );

  it('returns score=0 and feedback for unrecognised answer', () => {
    const r = gradeTrueFalse('maybe', 'true', 2);
    expect(r.correct).toBe(false);
    expect(r.score).toBe(0);
    expect(r.feedback).toContain('maybe');
  });
});

// ---------------------------------------------------------------------------
// gradeFillInBlank
// ---------------------------------------------------------------------------

describe('gradeFillInBlank', () => {
  describe('exact match (default, no near-match)', () => {
    it('awards marks for identical string', () => {
      const r = gradeFillInBlank('photosynthesis', 'photosynthesis', 3);
      expect(r.correct).toBe(true);
      expect(r.score).toBe(3);
    });

    it('is case-insensitive', () => {
      const r = gradeFillInBlank('Photosynthesis', 'photosynthesis', 2);
      expect(r.correct).toBe(true);
    });

    it('is trim-insensitive', () => {
      const r = gradeFillInBlank('  mitosis  ', 'mitosis', 1);
      expect(r.correct).toBe(true);
    });

    it('awards 0 for wrong answer', () => {
      const r = gradeFillInBlank('meiosis', 'mitosis', 2);
      expect(r.correct).toBe(false);
      expect(r.score).toBe(0);
    });

    it('does NOT accept near-match by default', () => {
      // "colour" vs "color" — distance 1 but near-match is off
      const r = gradeFillInBlank('colour', 'color', 2);
      expect(r.correct).toBe(false);
    });
  });

  describe('near-match (allowNearMatch: true)', () => {
    it('accepts a 1-char typo in a long word', () => {
      const r = gradeFillInBlank('colour', 'color', 2, { allowNearMatch: true, nearMatchMinLength: 4 });
      expect(r.correct).toBe(true);
      expect(r.score).toBe(2);
    });

    it('rejects a 2-char difference even with near-match enabled', () => {
      const r = gradeFillInBlank('colur', 'color', 2, { allowNearMatch: true, nearMatchMinLength: 4 });
      expect(r.correct).toBe(false);
    });

    it('does NOT apply near-match for short correct answers', () => {
      // "a" vs "b" — distance 1 but word is shorter than nearMatchMinLength
      const r = gradeFillInBlank('a', 'b', 1, { allowNearMatch: true, nearMatchMinLength: 4 });
      expect(r.correct).toBe(false);
    });

    it('feedback indicates minor spelling variation when near-match accepted', () => {
      const r = gradeFillInBlank('colour', 'color', 2, { allowNearMatch: true });
      expect(r.feedback).toMatch(/spelling/i);
    });
  });
});

// ---------------------------------------------------------------------------
// gradeQuestion (dispatcher)
// ---------------------------------------------------------------------------

describe('gradeQuestion', () => {
  it('returns null for short_answer (AI needed)', () => {
    const result = gradeQuestion('some answer', {
      type: 'short_answer',
      correctAnswer: 'expected',
      marks: 5,
    });
    expect(result).toBeNull();
  });

  it('returns null for long_answer (AI needed)', () => {
    const result = gradeQuestion('essay text', {
      type: 'long_answer',
      correctAnswer: 'model answer',
      marks: 10,
    });
    expect(result).toBeNull();
  });

  it('returns null when correctAnswer is undefined', () => {
    const result = gradeQuestion('A', {
      type: 'mcq',
      correctAnswer: undefined,
      marks: 2,
    });
    expect(result).toBeNull();
  });

  it('delegates MCQ correctly', () => {
    const result = gradeQuestion('B', {
      type: 'mcq',
      correctAnswer: 'B',
      marks: 3,
    });
    expect(result?.correct).toBe(true);
    expect(result?.score).toBe(3);
  });

  it('delegates true_false correctly', () => {
    const result = gradeQuestion('yes', {
      type: 'true_false',
      correctAnswer: 'true',
      marks: 1,
    });
    expect(result?.correct).toBe(true);
  });

  it('delegates fill_in_blank correctly', () => {
    const result = gradeQuestion('mitosis', {
      type: 'fill_in_blank',
      correctAnswer: 'Mitosis',
      marks: 2,
    });
    expect(result?.correct).toBe(true);
  });
});
