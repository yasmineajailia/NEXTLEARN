"""
routers/quiz.py

Teacher-facing quiz tooling: LLM quiz generation (with a template fallback)
and classical item analysis (difficulty/discrimination/reliability) over real
student responses.
"""

from fastapi import APIRouter
from pydantic import BaseModel

from quizgen import generate_quiz
import item_analysis

router = APIRouter()


class QuizGenBody(BaseModel):
    moduleId: str = ""
    moduleName: str = ""
    acquisName: str = ""
    subAcquisId: str = ""
    subAcquisName: str = ""
    topic: str = ""
    difficulty: str = "intermediate"
    count: int = 5
    courseContent: list[str] = []


class ItemAnalysisBody(BaseModel):
    """Per-question responses for one quiz. Each attempt carries the gradable
    responses captured in User.progress.skillAttempts."""
    attempts: list[dict] = []


@router.post("/generate-quiz")
def generate_quiz_endpoint(body: QuizGenBody):
    """Teacher quiz generation (LLM, with a template fallback). Returns validated
    questions. Node passes the resolved sous-acquis + course-content snippets."""
    return {"questions": generate_quiz(body.model_dump())}


@router.post("/item-analysis")
def item_analysis_endpoint(body: ItemAnalysisBody):
    """Classical item analysis (difficulty + rest-corrected point-biserial
    discrimination + KR-20 reliability) for one quiz, so teachers can spot broken
    / too-easy / too-hard AI-generated questions from real student responses."""
    return item_analysis.analyze(body.attempts)
