export type Difficulty = 'easy' | 'medium' | 'hard';
export type QuestionType = 'mcq' | 'short_answer' | 'long_answer' | 'true_false' | 'fill_in_blank';
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';
export interface QuestionConfig {
    type: QuestionType;
    count: number;
    marksPerQuestion: number;
    difficulty: Difficulty;
}
export interface AssignmentInput {
    title: string;
    subject: string;
    topic: string;
    gradeLevel: string;
    dueDate: string;
    questionConfigs: QuestionConfig[];
    additionalInstructions?: string;
    fileContent?: string;
}
export interface Question {
    id: string;
    text: string;
    type: QuestionType;
    difficulty: Difficulty;
    marks: number;
    options?: string[];
    correctAnswer?: string;
}
export interface Section {
    id: string;
    title: string;
    instruction: string;
    questions: Question[];
    totalMarks: number;
}
export interface GeneratedPaper {
    id: string;
    assignmentId: string;
    title: string;
    subject: string;
    topic: string;
    gradeLevel: string;
    totalMarks: number;
    duration?: string;
    sections: Section[];
    createdAt: string;
}
export interface Assignment {
    _id: string;
    input: AssignmentInput;
    status: JobStatus;
    jobId?: string;
    result?: GeneratedPaper;
    error?: string;
    createdAt: string;
    updatedAt: string;
}
export interface WSEvent {
    type: 'job:started' | 'job:progress' | 'job:completed' | 'job:failed';
    assignmentId: string;
    progress?: number;
    message?: string;
    result?: GeneratedPaper;
    error?: string;
}
/** Socket events for AI-assisted submission grading */
export interface GradingWSEvent {
    type: 'grading:started' | 'grading:progress' | 'grading:completed' | 'grading:failed';
    assignmentId: string;
    submissionId: string;
    progress?: number;
    message?: string;
    error?: string;
}
//# sourceMappingURL=types.d.ts.map