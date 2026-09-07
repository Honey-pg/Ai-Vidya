/** Normalized email for matching `studentEmails` arrays on assignments. */
export function normalizeUserEmail(user: { email?: string | null }): string {
  return String(user.email ?? '')
    .trim()
    .toLowerCase();
}

/**
 * Assignments visible to a learner: enrolled by Clerk id or by account email.
 * Keep list filters and single-doc access checks on this same predicate.
 */
export function buildStudentAssignmentFilter(
  clerkId: string,
  normalizedEmail: string
): Record<string, unknown> {
  const or: Record<string, unknown>[] = [{ studentIds: clerkId }];
  if (normalizedEmail) or.push({ studentEmails: normalizedEmail });
  return { $or: or };
}

export function buildAssignmentsListFilter(
  role: 'teacher' | 'student',
  clerkId: string,
  normalizedEmail: string
): Record<string, unknown> {
  if (role === 'teacher') return { teacherId: clerkId };
  return buildStudentAssignmentFilter(clerkId, normalizedEmail);
}

/** Single-document access check — same enrollment rules as the list filter. */
export function canAccessAssignment(
  clerkId: string,
  role: 'teacher' | 'student',
  userEmailNormalized: string,
  doc: { teacherId: string; studentIds?: string[]; studentEmails?: string[] }
): boolean {
  if (role === 'teacher') return doc.teacherId === clerkId;
  if (doc.studentIds?.includes(clerkId)) return true;
  if (!userEmailNormalized) return false;
  return doc.studentEmails?.includes(userEmailNormalized) ?? false;
}

/**
 * `dueDate` is stored as an HTML date string (`YYYY-MM-DD`).
 * Window is inclusive through the end of that calendar day in UTC.
 */
export function isWithinSubmissionWindow(dueDate: string, now: Date = new Date()): boolean {
  const trimmed = String(dueDate ?? '').trim();
  if (!trimmed) return false;

  // Full ISO datetime — compare directly
  if (trimmed.includes('T') || trimmed.includes(' ')) {
    const due = new Date(trimmed);
    if (Number.isNaN(due.getTime())) return false;
    return now.getTime() <= due.getTime();
  }

  // Date-only: allow through 23:59:59.999 UTC on that day
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    const due = new Date(trimmed);
    if (Number.isNaN(due.getTime())) return false;
    return now.getTime() <= due.getTime();
  }

  const endOfDayUtc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    23,
    59,
    59,
    999
  );
  return now.getTime() <= endOfDayUtc;
}
