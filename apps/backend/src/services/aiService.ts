import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';
import type {
  AssignmentInput,
  Question,
  Section,
  GeneratedPaper,
} from '@vedaai/shared/types';

/** Optional hook so BullMQ worker can emit Socket.io progress during long LLM calls */
export type AiProgressCallback = (message: string, progress?: number) => void;

const LLM_FETCH_TIMEOUT_MS = 180_000; // 3 min per HTTP attempt (large JSON papers)

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function buildPrompt(input: AssignmentInput): string {
  const questionSpecs = input.questionConfigs
    .map(
      (q) =>
        `- ${q.count} ${q.type.replace('_', ' ')} questions, ${q.difficulty} difficulty, ${q.marksPerQuestion} marks each`
    )
    .join('\n');

  return `You are an expert educator. Generate a question paper with the following specs:

Subject: ${input.subject}
Topic: ${input.topic}
Grade Level: ${input.gradeLevel}
${input.fileContent ? `\nReference Material:\n${input.fileContent.substring(0, 3000)}` : ''}
${input.additionalInstructions ? `\nAdditional Instructions: ${input.additionalInstructions}` : ''}

Question Requirements:
${questionSpecs}

IMPORTANT: Respond ONLY with a valid JSON object. No markdown, no explanation, no code fences. Structure:
{
  "sections": [
    {
      "title": "Section A",
      "instruction": "Attempt all questions",
      "questions": [
        {
          "text": "...",
          "type": "short_answer",
          "difficulty": "medium",
          "marks": 3,
          "correctAnswer": "Concise exemplar solution (2-4 sentences) teachers can grade against."
        }
      ]
    }
  ]
}

Group questions by type into sections (Section A = MCQ, Section B = Short Answer, etc.)
Each section must have a descriptive instruction.

For MCQ questions, always include exactly 4 options (strings may start with "A. ", etc.).

══════════════════════════════════════════════════════
MANDATORY — include "correctAnswer" on EVERY question
══════════════════════════════════════════════════════
The paper will be useless for teachers unless every question has a non-empty "correctAnswer" string:

- mcq: single letter ONLY: "A", "B", "C", or "D" indicating which option is correct (match by position with your four options).
- true_false: "True" or "False".
- fill_in_blank: the exact wording that fills every blank (keep it short).
- short_answer / long_answer: a clear model / exemplar answer a teacher can use for marking — length should match marks (short for low marks; more detail when marks are high).
- Omitting correctAnswer or using empty strings for any question is NOT allowed — double-check JSON before answering.

Example MCQ snippet (still include correctAnswer letter):
{
  "text": "...",
  "type": "mcq",
  "difficulty": "easy",
  "marks": 2,
  "options": ["A. Option one", "B. Option two", "C. Option three", "D. Option four"],
  "correctAnswer": "B"
}

For true_false questions, include "options": ["True", "False"] and correctAnswer "True" or "False".`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse retry delay from Gemini error JSON, e.g. "retryDelay":"40s" */
function parseGeminiRetryDelayMs(body: string): number | null {
  const m = body.match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
  if (!m) return null;
  const sec = parseFloat(m[1]);
  if (Number.isNaN(sec)) return null;
  return Math.ceil(sec * 1000) + 500;
}

async function callGemini(prompt: string, onProgress?: AiProgressCallback): Promise<string> {
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is missing. Get a free key at https://aistudio.google.com/apikey'
    );
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.7,
      maxOutputTokens: 8192,
    },
  });

  const maxAttempts = 4;
  let lastErrText = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onProgress?.(
      `Calling Gemini (${env.GEMINI_MODEL})… Large papers can take 1–3 minutes.`,
      34
    );

    let res: Response;
    try {
      res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
        LLM_FETCH_TIMEOUT_MS
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('abort') || msg.includes('Abort')) {
        throw new Error(
          `Gemini request timed out after ${LLM_FETCH_TIMEOUT_MS / 1000}s. Try fewer/shorter questions or switch AI_PROVIDER to groq / ollama.`
        );
      }
      throw e;
    }

    if (res.ok) {
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty response from Gemini');
      return text;
    }

    lastErrText = await res.text();

    if (res.status === 429 && attempt < maxAttempts) {
      let delay =
        parseGeminiRetryDelayMs(lastErrText) ??
        Math.min(60_000, 12_000 * attempt);
      delay = Math.min(delay, 55_000);

      onProgress?.(
        `Gemini rate limit — waiting ${Math.round(delay / 1000)}s before retry (${attempt}/${maxAttempts - 1})…`,
        33
      );
      console.warn(
        `[Gemini] Rate limited (429), retry ${attempt}/${maxAttempts - 1} after ${delay}ms`
      );
      await sleep(delay);
      continue;
    }

    if (res.status === 429) {
      throw new Error(
        'Gemini rate limit / quota exceeded (429) after retries. Wait a few minutes or until tomorrow for daily caps; ' +
          'enable billing for your AI Studio API project if you need higher limits; try GEMINI_MODEL=gemini-2.0-flash-lite; ' +
          'or use AI_PROVIDER=groq / ollama. Details: https://ai.google.dev/gemini-api/docs/rate-limits'
      );
    }

    throw new Error(`Gemini API error (${res.status}): ${lastErrText}`);
  }

  throw new Error(`Gemini API failed after retries: ${lastErrText}`);
}

async function callGroq(prompt: string): Promise<string> {
  if (!env.GROQ_API_KEY) {
    throw new Error(
      'GROQ_API_KEY is missing. Get a free key at https://console.groq.com/keys'
    );
  }

  const client = new OpenAI({
    apiKey: env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
    timeout: LLM_FETCH_TIMEOUT_MS,
  });

  const completion = await client.chat.completions.create({
    model: env.GROQ_MODEL,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.7,
  });

  const content = completion.choices[0].message.content;
  if (!content) throw new Error('Empty response from Groq');
  return content;
}

async function callOllama(prompt: string): Promise<string> {
  const base = env.OLLAMA_BASE_URL.replace(/\/$/, '');
  const res = await fetchWithTimeout(
    `${base}/api/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.OLLAMA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        format: 'json',
      }),
    },
    LLM_FETCH_TIMEOUT_MS
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Ollama error (${res.status}): ${errText}. Is Ollama running? Try: ollama pull ${env.OLLAMA_MODEL}`
    );
  }

  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content;
  if (!content) throw new Error('Empty response from Ollama');
  return content;
}

async function callOpenAI(prompt: string): Promise<string> {
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is missing');
  }
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: LLM_FETCH_TIMEOUT_MS });
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  });
  const content = completion.choices[0].message.content;
  if (!content) throw new Error('Empty response from OpenAI');
  return content;
}

async function callAnthropic(prompt: string): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is missing');
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = msg.content[0];
  if (block.type === 'text') return block.text;
  throw new Error('Unexpected response type from Anthropic');
}

async function callLLM(prompt: string, onProgress?: AiProgressCallback): Promise<string> {
  switch (env.AI_PROVIDER) {
    case 'gemini':
      return callGemini(prompt, onProgress);
    case 'groq':
      onProgress?.('Calling Groq…', 36);
      return callGroq(prompt);
    case 'ollama':
      onProgress?.('Calling local Ollama…', 36);
      return callOllama(prompt);
    case 'anthropic':
      onProgress?.('Calling Anthropic…', 36);
      return callAnthropic(prompt);
    case 'openai':
    default:
      onProgress?.('Calling OpenAI…', 36);
      return callOpenAI(prompt);
  }
}

interface ParsedPaper {
  sections: Section[];
}

function parseAndValidate(raw: string): ParsedPaper {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('LLM returned invalid JSON. Cannot parse response.');
  }

  if (!parsed.sections || !Array.isArray(parsed.sections)) {
    throw new Error('LLM response missing "sections" array');
  }

  const sections: Section[] = (parsed.sections as Array<Record<string, unknown>>).map(
    (section) => {
      if (!section.title || !section.questions || !Array.isArray(section.questions)) {
        throw new Error('Each section must have a title and questions array');
      }

      const questions: Question[] = (
        section.questions as Array<Record<string, unknown>>
      ).map((q) => {
        if (!q.text || !q.type || !q.difficulty || !q.marks) {
          throw new Error('Each question must have text, type, difficulty, and marks');
        }
        let correctAnswer = q.correctAnswer;
        if (typeof correctAnswer === 'number') {
          correctAnswer = String(correctAnswer);
        }
        if (typeof correctAnswer === 'string') {
          correctAnswer = correctAnswer.trim();
        }
        const answerStr =
          typeof correctAnswer === 'string' && correctAnswer.length > 0 ? correctAnswer : undefined;
        return {
          id: uuidv4(),
          text: q.text as string,
          type: q.type as Question['type'],
          difficulty: q.difficulty as Question['difficulty'],
          marks: q.marks as number,
          options: q.options as string[] | undefined,
          correctAnswer: answerStr,
        };
      });

      const totalMarks = questions.reduce((sum, q) => sum + q.marks, 0);

      return {
        id: uuidv4(),
        title: section.title as string,
        instruction: (section.instruction as string) || 'Attempt all questions',
        questions,
        totalMarks,
      };
    }
  );

  return { sections };
}

export async function generatePaper(
  input: AssignmentInput,
  assignmentId: string,
  opts?: { onProgress?: AiProgressCallback }
): Promise<GeneratedPaper> {
  const prompt = buildPrompt(input);
  opts?.onProgress?.('Sending request to AI… This step often takes 1–3 minutes.', 32);
  const rawResponse = await callLLM(prompt, opts?.onProgress);
  opts?.onProgress?.('Parsing question paper JSON…', 78);
  const paper = parseAndValidate(rawResponse);

  const totalMarks = paper.sections.reduce((sum, s) => sum + s.totalMarks, 0);

  return {
    id: uuidv4(),
    assignmentId,
    title: input.title,
    subject: input.subject,
    topic: input.topic,
    gradeLevel: input.gradeLevel,
    totalMarks,
    duration: '3 Hours',
    sections: paper.sections,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Open-ended (short_answer / long_answer) AI grading
// ---------------------------------------------------------------------------

export interface OpenEndedGradeItem {
  questionId: string;
  questionText: string;
  type: 'short_answer' | 'long_answer';
  marks: number;
  difficulty?: string;
  referenceAnswer: string;
  studentAnswer: string;
}

export interface OpenEndedGradeResult {
  questionId: string;
  score: number;
  feedback: string;
}

function buildGradingPrompt(items: OpenEndedGradeItem[]): string {
  const questionsBlock = items
    .map(
      (item, i) => `--- Question ${i + 1} ---
questionId: ${item.questionId}
type: ${item.type}
marks: ${item.marks}
difficulty: ${item.difficulty ?? 'medium'}
question: ${item.questionText}
referenceAnswer: ${item.referenceAnswer}
studentAnswer: ${item.studentAnswer}`
    )
    .join('\n\n');

  return `You are an expert examiner. Grade each student answer against the reference answer.
Award partial credit when appropriate. Score must be a number from 0 to marks (inclusive).
Feedback should be brief (1-3 sentences) and constructive.

Respond ONLY with valid JSON. No markdown, no code fences. Structure:
{
  "grades": [
    { "questionId": "...", "score": 0, "feedback": "..." }
  ]
}

Include exactly one grade object per question below, using the same questionId values.

${questionsBlock}`;
}

function parseGradingResponse(raw: string, items: OpenEndedGradeItem[]): OpenEndedGradeResult[] {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  let parsed: { grades?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('LLM returned invalid JSON for grading.');
  }

  if (!parsed.grades || !Array.isArray(parsed.grades)) {
    throw new Error('LLM grading response missing "grades" array');
  }

  const byId = new Map(
    parsed.grades.map((g) => [String(g.questionId ?? ''), g] as const)
  );

  return items.map((item) => {
    const g = byId.get(item.questionId);
    let score = typeof g?.score === 'number' ? g.score : Number(g?.score);
    if (Number.isNaN(score)) score = 0;
    score = Math.max(0, Math.min(item.marks, Math.round(score * 100) / 100));
    const feedback =
      typeof g?.feedback === 'string' && g.feedback.trim()
        ? g.feedback.trim()
        : 'No feedback provided.';
    return { questionId: item.questionId, score, feedback };
  });
}

/**
 * Grade short/long answer questions via the configured LLM.
 * Scores are clamped to [0, marks] after parse.
 */
export async function gradeOpenEndedAnswers(
  items: OpenEndedGradeItem[],
  opts?: { onProgress?: AiProgressCallback }
): Promise<OpenEndedGradeResult[]> {
  if (items.length === 0) return [];

  const prompt = buildGradingPrompt(items);
  opts?.onProgress?.('Sending open-ended answers to AI for grading…', 40);
  const raw = await callLLM(prompt, opts?.onProgress);
  opts?.onProgress?.('Parsing AI grades…', 85);
  return parseGradingResponse(raw, items);
}
