# NextLearn 
<img width="878" height="284" alt="NextLearn_LOGO" src="https://github.com/user-attachments/assets/3c619ee7-38e3-43c8-af65-2e882c14b651" />

An e-learning platform for the C programming course at Esprit. Students can go through the different modules (PDF materials, videos, quizzes for each sub-skill), while the platform adds an intelligence layer on top of that: prediction of the risk of needing a retake and the exam grade, with SHAP explanations, a chatbot grounded in the course content (RAG), recommendations based on the student's learning style (VARK), and webcam-based attention tracking processed entirely in the browser.


The backend uses Node.js / TypeScript / Express, the frontend is built with native JavaScript, and MongoDB is used for the database. There is also a python service (FastAPI) that handles the AI stuff.
<img width="1565" height="821" alt="nextlearn architecture" src="https://github.com/user-attachments/assets/474e1ef2-4942-4e6a-a957-2becfb79bc68" />


## Prerequisites

* Node.js 20+
* A MongoDB database (local or Atlas)
* Python 3.10+ **required**: Node automatically starts the Python service, and the chatbot/predictions depend on it.
* LibreOffice

## Installation

```bash
npm install
npm run shap:install   # Python dependencies (only needed once)
```

Create a `.env` file at the root of the project:

```
MONGODB_URI=mongodb://...
AUTH_SECRET=...               # used to sign JWT sessions; required in production
APP_BASE_URL=http://localhost:3000   # PUBLIC URL (used in password reset links)
# INTERNAL_BASE_URL=http://app:3000  # only if the Python service runs on another host
                                     # (in Docker: the service name, not the public domain)

# LLM/embedding provider: Gemini is used first if its key is available,
# otherwise it falls back to the OPENAI_* variables (compatible with OpenRouter).
GEMINI_API_KEY=...
OPENAI_API_KEY=...            #openRouter (or OpenAI) key
OPENAI_CHAT_BASE_URL=https://openrouter.ai/api/v1
OPENAI_CHAT_MODEL=meta-llama/llama-3.3-70b-instruct
OPENAI_EMBEDDING_BASE_URL=https://openrouter.ai/api/v1
OPENAI_EMBEDDING_MODEL=openai/text-embedding-3-small

SMTP_HOST=...                 #email stuff used for password reset
SMTP_USER=...
SMTP_PASS=...
```

## Running

```bash
npm run dev
```

The server runs on http://localhost:3000. It automatically starts the Python service (`ml/shap_service.py`, port 8000) in the background through `shapSupervisor.ts`, so there is normally no need to start it manually during development. This service contains, under one FastAPI application, the Random Forest models (`ml/models/rf-risk.joblib`, `rf-grade.joblib`), SHAP explanations, the chatbot RAG (`ml/rag/`, ChromaDB vector index), VARK clustering and attention tracking.

If you want to work on the Python part separately, without having to restart Node every time you make a change:

```bash
npm run shap:serve     # FastAPI on :8000
```

Node detects an already running instance and uses it instead of starting another one.

The lesson content (PDF/PPTX) needs to be indexed for the chatbot to have something to work with. A `POST /rag/reindex` is automatically triggered whenever the curriculum is saved from the back-office, but it can also be forced manually:

```bash
npm run reindex:rag            # incremental
npm run reindex:rag -- --reset # rebuilds the vector index from scratch
```

## Deployment

```bash
docker compose up --build
```

There are three containers: `mongo`, `ml` (FastAPI), and `app` (Node). the compose file handles the network configuration between the containers itself. Two volumes are used to persist the data: `mongo-data` (database + course files stored in GridFS) and `chroma-store` (chatbot index).

Before deploying to production, check the following:

* `AUTH_SECRET` must be defined; the server refuses to start without it.
* `APP_BASE_URL` must be the public domain since it is used in password reset emails. In Docker, `INTERNAL_BASE_URL` is already set to `http://app:3000`; this is how the Python service accesses the course files to build the index.
* Put an HTTPS reverse proxy in front of the application: session cookies are issued with `secure` in production and will not work over plain HTTP.
* `mongo-data` contains **all** files uploaded by teachers, so make sure to regularly back up the volume.

## Useful Scripts

| Command                                                                                    | Purpose                                                           |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `npm run dev`                                                                              | Development server (tsx watch), also starts the Python service    |
| `npm test`                                                                                 | Unit tests (Vitest)                                               |
| `npx tsc --noEmit`                                                                         | TypeScript check                                                  |
| `npm run build` / `npm start`                                                              | Production build and launch (`dist/`)                             |
| `npm run train:model`                                                                      | Retrains the Random Forest models (risk + grade)                  |
| `npm run reindex:rag`                                                                      | (Re)builds the chatbot vector index from the persisted curriculum |

## Code Structure

```text
src/
  server.ts            Express startup, mounts the routers, starts shapSupervisor
  routes/               auth, pages, web/ (curriculum, quiz, media, prediction...),
                        student/ (chatbot, attention), backoffice/
  services/             prediction + SHAP, chatbot (learnerProfile, ragClient),
                        content extraction, class access, clustering
  models/               Mongoose schemas
ml/
  shap_service.py       single FastAPI application: mounts all the routers below
  routers/               risk, clustering, attention, rag_routes, mastery, quiz
  rag/                   chatbot RAG: retrieve/generate (LLM), embed, content
                         extraction (PDF/PPTX/DOCX), store (ChromaDB, on disk)
  models/                trained models (.joblib, SAKT .pt)
scripts/               training, RAG reindexing, seed, resync
public/                student / back-office / auth pages, themes, i18n FR-EN
data/                  normalized quizzes, calendar, training datasets
```
