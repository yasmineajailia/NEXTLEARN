/**
 * routes/web.ts
 *
 * Aggregator for the web-facing API. The former 3,800-line monolith was split
 * into a shared helper layer (./web/shared.ts) and one router per domain
 * (./web/*.routes.ts). This file only wires them onto a single `webRouter`,
 * which is the sole public contract (mounted in server.ts).
 */
import { Router } from "express";
import { authRouter } from "./auth";
import { coreRouter } from "./web/core.routes.js";
import { curriculumRouter } from "./web/curriculum.routes.js";
import { mediaRouter } from "./web/media.routes.js";
import { learningRouter } from "./web/learning.routes.js";
import { predictionRouter } from "./web/prediction.routes.js";
import { quizzesRouter } from "./web/quizzes.routes.js";

// Preserve the public helper surface other modules import from "../web".
export {
  readClassAccessByStudentIdentifier,
  readPersistedProgramCOverview,
  readPersistedCurriculumModules,
  resolveTotalSubAcquisCount,
} from "./web/shared.js";

const webRouter = Router();

webRouter.use(authRouter);
webRouter.use(coreRouter);
webRouter.use(curriculumRouter);
webRouter.use(mediaRouter);
webRouter.use(learningRouter);
webRouter.use(predictionRouter);
webRouter.use(quizzesRouter);

export { webRouter };
