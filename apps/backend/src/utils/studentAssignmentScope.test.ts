/**
 * Unit tests for submission-window + access helpers.
 */
import {
  canAccessAssignment,
  isWithinSubmissionWindow,
  buildStudentAssignmentFilter,
} from './studentAssignmentScope';

describe('isWithinSubmissionWindow', () => {
  it('allows submit through end of due date (UTC)', () => {
    const due = '2026-09-07';
    // 12:00 UTC same day
    expect(isWithinSubmissionWindow(due, new Date('2026-09-07T12:00:00.000Z'))).toBe(true);
    // last ms of day
    expect(isWithinSubmissionWindow(due, new Date('2026-09-07T23:59:59.999Z'))).toBe(true);
  });

  it('rejects after end of due date (UTC)', () => {
    expect(
      isWithinSubmissionWindow('2026-09-07', new Date('2026-09-08T00:00:00.000Z'))
    ).toBe(false);
  });

  it('handles ISO datetime due dates', () => {
    const due = '2026-09-07T15:00:00.000Z';
    expect(isWithinSubmissionWindow(due, new Date('2026-09-07T14:59:59.000Z'))).toBe(true);
    expect(isWithinSubmissionWindow(due, new Date('2026-09-07T15:00:01.000Z'))).toBe(false);
  });

  it('rejects empty due date', () => {
    expect(isWithinSubmissionWindow('', new Date())).toBe(false);
  });
});

describe('canAccessAssignment', () => {
  const doc = {
    teacherId: 'teacher_1',
    studentIds: ['student_1'],
    studentEmails: ['alice@school.edu'],
  };

  it('allows owning teacher', () => {
    expect(canAccessAssignment('teacher_1', 'teacher', '', doc)).toBe(true);
    expect(canAccessAssignment('teacher_2', 'teacher', '', doc)).toBe(false);
  });

  it('allows enrolled student by clerk id', () => {
    expect(canAccessAssignment('student_1', 'student', 'other@x.com', doc)).toBe(true);
  });

  it('allows enrolled student by email', () => {
    expect(canAccessAssignment('student_x', 'student', 'alice@school.edu', doc)).toBe(true);
  });

  it('denies non-enrolled student', () => {
    expect(canAccessAssignment('student_x', 'student', 'bob@school.edu', doc)).toBe(false);
  });
});

describe('buildStudentAssignmentFilter', () => {
  it('includes email or when email present', () => {
    expect(buildStudentAssignmentFilter('c1', 'a@b.com')).toEqual({
      $or: [{ studentIds: 'c1' }, { studentEmails: 'a@b.com' }],
    });
  });

  it('omits email clause when empty', () => {
    expect(buildStudentAssignmentFilter('c1', '')).toEqual({
      $or: [{ studentIds: 'c1' }],
    });
  });
});
