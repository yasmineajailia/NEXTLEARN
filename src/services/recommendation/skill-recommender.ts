const WEAK_THRESHOLD = 60;

export type SkillNode = {
  title: string;
  depends_on?: string[];
  unlocks?: string[];
};

export type SkillsJson = Record<string, SkillNode>;

export type ScoreEntry = {
  subSkillId: string;
  score: number;
};

export type ChapterScoreEntry = {
  chapterId: string;
  score: number;
};

export type RecommendOptions = {
  sortBy?: "readiness" | "unlocks" | "id";
  limit?: number;
  includePartial?: boolean;
};

export type LimitOptions = {
  limit?: number;
};

export type RecommendationEntry = {
  id: string;
  title: string;
  status: "completed" | "ready" | "partial" | "locked";
  readiness: number;
  readinessPct: number;
  prerequisiteProgress: { met: number; total: number };
  unlockImpact: number;
  unlocks: string[];
  depends_on: string[];
};

export type RemediationEntry = RecommendationEntry & {
  score?: number;
  scoreLabel?: string;
  deficit?: number;
  weakBecauseOf?: Array<{
    id: string;
    title: string;
    score: number | null;
    scoreLabel: string;
  }>;
};

export type SkillScoreReportEntry = {
  chapterId: string;
  chapterScore: number | null;
  chapterScoreLabel: string;
  isChapterWeak: boolean;
  subSkillCount: number;
  weakSubSkillCount: number;
  weakSubSkills: Array<{
    id: string;
    title: string;
    score: number | null;
    scoreLabel: string;
  }>;
};

export type SnapshotEntry = RecommendationEntry & {
  score: number | null;
  scoreLabel: string;
  isWeak: boolean;
};

export class Recommender {
  private _skills: SkillsJson;
  private _completed: Set<string>;
  private _subScores: Map<string, number>;
  private _skillScores: Map<string, number>;

  constructor(skillsJson: SkillsJson) {
    this._skills = skillsJson;
    this._completed = new Set();
    this._subScores = new Map();
    this._skillScores = new Map();
  }

  complete(id: string): this {
    this._assertExists(id);
    this._completed.add(id);
    return this;
  }

  uncomplete(id: string): this {
    this._completed.delete(id);
    return this;
  }

  setCompleted(ids: string[] = []): this {
    this._completed = new Set(ids.filter((id) => Boolean(this._skills[id])));
    return this;
  }

  reset(): this {
    this._completed.clear();
    return this;
  }

  getCompleted(): Set<string> {
    return new Set(this._completed);
  }

  recordSubSkillScore(id: string, score: number): this {
    this._assertExists(id);
    this._subScores.set(id, this._clamp(score));
    return this;
  }

  recordSkillScore(chapterId: string, score: number): this {
    this._skillScores.set(String(chapterId), this._clamp(score));
    return this;
  }

  loadSubSkillScores(entries: ScoreEntry[] = []): this {
    for (const { subSkillId, score } of entries) {
      if (this._skills[subSkillId] && Number.isFinite(score)) {
        this._subScores.set(subSkillId, this._clamp(score));
      }
    }
    return this;
  }

  loadSkillScores(entries: ChapterScoreEntry[] = []): this {
    for (const { chapterId, score } of entries) {
      if (Number.isFinite(score)) {
        this._skillScores.set(String(chapterId), this._clamp(score));
      }
    }
    return this;
  }

  getSubSkillScore(id: string): number | null {
    return this._subScores.has(id) ? (this._subScores.get(id) ?? null) : null;
  }

  getSkillScore(chapterId: string): number | null {
    const key = String(chapterId);
    return this._skillScores.has(key) ? (this._skillScores.get(key) ?? null) : null;
  }

  readiness(id: string): number {
    this._assertExists(id);
    const deps = this._validDeps(id);
    if (deps.length === 0) return 1;
    const met = deps.filter((dep) => this._completed.has(dep)).length;
    return met / deps.length;
  }

  prerequisiteProgress(id: string): { met: number; total: number } {
    this._assertExists(id);
    const deps = this._validDeps(id);
    const met = deps.filter((dep) => this._completed.has(dep)).length;
    return { met, total: deps.length };
  }

  unlockImpact(id: string): number {
    this._assertExists(id);
    const direct = (this._skills[id].unlocks ?? []).filter(
      (unlockId) => this._skills[unlockId] && !this._completed.has(unlockId)
    );
    const indirect = direct.flatMap((unlockId) =>
      (this._skills[unlockId]?.unlocks ?? []).filter(
        (nextUnlockId) =>
          this._skills[nextUnlockId] &&
          !this._completed.has(nextUnlockId) &&
          !direct.includes(nextUnlockId)
      )
    );
    return direct.length + indirect.length;
  }

  status(id: string): RecommendationEntry["status"] {
    if (this._completed.has(id)) return "completed";
    const readiness = this.readiness(id);
    if (readiness === 1) return "ready";
    if (readiness > 0) return "partial";
    return "locked";
  }

  isWeak(id: string): boolean {
    const score = this._subScores.get(id);
    return score !== undefined && score < WEAK_THRESHOLD;
  }

  recommend({ sortBy = "readiness", limit, includePartial = true }: RecommendOptions = {}): RecommendationEntry[] {
    const candidates = Object.keys(this._skills)
      .filter((id) => {
        if (this._completed.has(id)) return false;
        const readiness = this.readiness(id);
        if (readiness === 0) return false;
        if (!includePartial && readiness < 1) return false;
        return true;
      })
      .map((id) => this._buildEntry(id));

    candidates.sort((a, b) => {
      if (sortBy === "unlocks") return b.unlockImpact - a.unlockImpact || b.readiness - a.readiness;
      if (sortBy === "id") return this._compareIds(a.id, b.id);
      return b.readiness - a.readiness || b.unlockImpact - a.unlockImpact;
    });

    return typeof limit === "number" ? candidates.slice(0, limit) : candidates;
  }

  remediation({ limit }: LimitOptions = {}): RemediationEntry[] {
    const weakIds = [...this._subScores.entries()]
      .filter(([, score]) => score < WEAK_THRESHOLD)
      .map(([id]) => id)
      .filter((id) => Boolean(this._skills[id]));

    if (!weakIds.length) return [];

    const ancestorMap = new Map<string, Set<string>>();

    for (const weakId of weakIds) {
      for (const ancestorId of this._getAncestors(weakId, 2)) {
        if (!ancestorMap.has(ancestorId)) ancestorMap.set(ancestorId, new Set());
        ancestorMap.get(ancestorId)?.add(weakId);
      }
    }

    const results = [...ancestorMap.entries()].map(([id, triggers]) => ({
      ...this._buildEntry(id),
      weakBecauseOf: [...triggers].map((weakId) => ({
        id: weakId,
        title: this._skills[weakId]?.title ?? weakId,
        score: this._subScores.get(weakId) ?? null,
        scoreLabel: `${Math.round(this._subScores.get(weakId) ?? 0)}%`
      }))
    }));

    results.sort(
      (a, b) =>
        (b.weakBecauseOf?.length ?? 0) - (a.weakBecauseOf?.length ?? 0) ||
        b.unlockImpact - a.unlockImpact
    );

    return typeof limit === "number" ? results.slice(0, limit) : results;
  }

  revisit({ limit }: LimitOptions = {}): Array<RecommendationEntry & { score: number; scoreLabel: string; deficit: number }> {
    const results = [...this._subScores.entries()]
      .filter(([, score]) => score < WEAK_THRESHOLD)
      .filter(([id]) => Boolean(this._skills[id]))
      .map(([id, score]) => ({
        ...this._buildEntry(id),
        score,
        scoreLabel: `${Math.round(score)}%`,
        deficit: WEAK_THRESHOLD - score
      }))
      .sort((a, b) => a.score - b.score);

    return typeof limit === "number" ? results.slice(0, limit) : results;
  }

  skillScoreReport(): SkillScoreReportEntry[] {
    const allChapters = new Set([
      ...[...this._skillScores.keys()],
      ...Object.keys(this._skills).map((id) => id.split('.')[0])
    ]);

    return [...allChapters]
      .sort((a, b) => Number(a) - Number(b))
      .map((chapterId) => {
        const subSkillsInChapter = Object.keys(this._skills).filter(
          (id) => id.split('.')[0] === chapterId
        );
        const weakInChapter = subSkillsInChapter.filter((id) => this.isWeak(id));
        const chapterScore = this._skillScores.get(chapterId) ?? null;

        return {
          chapterId,
          chapterScore,
          chapterScoreLabel: chapterScore !== null ? `${Math.round(chapterScore)}%` : "Not taken",
          isChapterWeak: chapterScore !== null && chapterScore < WEAK_THRESHOLD,
          subSkillCount: subSkillsInChapter.length,
          weakSubSkillCount: weakInChapter.length,
          weakSubSkills: weakInChapter.map((id) => ({
            id,
            title: this._skills[id].title,
            score: this._subScores.get(id) ?? null,
            scoreLabel: `${Math.round(this._subScores.get(id) ?? 0)}%`
          }))
        };
      });
  }

  snapshot(): SnapshotEntry[] {
    return Object.keys(this._skills).map((id) => {
      const score = this._subScores.get(id) ?? null;
      return {
        ...this._buildEntry(id),
        score,
        scoreLabel: score !== null ? `${Math.round(score)}%` : "Not taken",
        isWeak: this.isWeak(id)
      };
    });
  }

  previewUnlocks(id: string): string[] {
    this._assertExists(id);
    const before = new Set(Object.keys(this._skills).filter((skillId) => this.status(skillId) === "ready"));
    this._completed.add(id);
    const after = Object.keys(this._skills).filter((skillId) => this.status(skillId) === "ready");
    this._completed.delete(id);
    return after.filter((skillId) => !before.has(skillId));
  }

  private _getAncestors(id: string, maxDepth: number, depth = 0, visited = new Set<string>()): string[] {
    if (depth >= maxDepth || visited.has(id)) return [];
    visited.add(id);

    const deps = this._validDeps(id);
    const result: string[] = [];

    for (const dep of deps) {
      if (!visited.has(dep)) {
        result.push(dep);
        result.push(...this._getAncestors(dep, maxDepth, depth + 1, visited));
      }
    }

    return [...new Set(result)];
  }

  private _buildEntry(id: string): RecommendationEntry {
    const readiness = this.readiness(id);
    return {
      id,
      title: this._skills[id].title,
      status: this.status(id),
      readiness,
      readinessPct: Math.round(readiness * 100),
      prerequisiteProgress: this.prerequisiteProgress(id),
      unlockImpact: this.unlockImpact(id),
      unlocks: [...(this._skills[id].unlocks ?? [])],
      depends_on: [...(this._skills[id].depends_on ?? [])]
    };
  }

  private _validDeps(id: string): string[] {
    return (this._skills[id].depends_on ?? [])
      .map((dep) => dep.trim())
      .filter((dep) => Boolean(this._skills[dep]));
  }

  private _clamp(score: number): number {
    return Math.max(0, Math.min(100, Number(score)));
  }

  private _assertExists(id: string): void {
    if (!this._skills[id]) {
      throw new Error(`Unknown skill id: "${id}"`);
    }
  }

  private _compareIds(a: string, b: string): number {
    const [am, an] = a.split('.').map(Number);
    const [bm, bn] = b.split('.').map(Number);
    return am !== bm ? am - bm : an - bn;
  }
}
