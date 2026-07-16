/**
 * quizGenClient.ts
 *
 * Teacher quiz generation runs in the Python ML service (`POST /generate-quiz`,
 * ml/quizgen.py): it builds the prompts, calls the LLM (Gemini then OpenAI),
 * validates the questions, and falls back to template questions. Node resolves
 * the sous-acquis + extracts the course-content snippets and posts them here.
 *
 * Note: this deliberately does NOT touch the ML circuit breaker. A slow or
 * failed LLM call says nothing about the health of the /predict|/cluster
 * endpoints, so it must not mark the whole service down.
 */
import { SHAP_SERVICE_URL } from "../prediction/explain";

export type TeacherGeneratedQuestion = {
  prompt: string;
  options: string[];
  correctOptionIndex: number;
  source?: "ai" | "fallback";
};

export type QuizGenParams = {
  moduleId: string;
  moduleName: string;
  acquisName?: string;
  subAcquisId: string;
  subAcquisName: string;
  topic?: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  count: number;
  courseContent?: string[];
};

// LLM generation is slow — allow well beyond the fast ML endpoints' budget.
const QUIZ_GEN_TIMEOUT_MS = 60_000;

export async function generateTeacherQuizQuestions(
  params: QuizGenParams
): Promise<TeacherGeneratedQuestion[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUIZ_GEN_TIMEOUT_MS);
  try {
    const res = await fetch(`${SHAP_SERVICE_URL.replace(/\/$/, "")}/generate-quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`ML service /generate-quiz -> ${res.status}`);
    const data = (await res.json()) as { questions?: TeacherGeneratedQuestion[] };
    return Array.isArray(data.questions) ? data.questions : [];
  } finally {
    clearTimeout(timer);
  }
}
