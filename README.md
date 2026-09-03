<p align="center">
  <img src="public/images/dark-mode-nextlearn-logo.png" alt="NextLearn Logo" width="300"/>
</p>

<h3 align="center">AI-Powered Learning Platform</h3>

---

## Overview

**NextLearn** is an intelligent e-learning platform developed for the introductory C programming course at **ESPRIT School of Engineering**.

The platform combines traditional course content such as lessons, videos, and quizzes with AI-powered features designed to help students identify weaknesses, receive personalized support, and monitor their progress.

### Key Features

*  **Student performance prediction** predicts exam grades and identifies students who may be at risk of falling behind.
*  **SHAP explanations** provides explanations for the factors influencing each prediction.
*  **RAG-based chatbot** answers student questions using the course material as its knowledge base.
*  **Personalized recommendations** recommends learning content based on the student's learning profile and competency gaps.
*  **VARK learning profile** identifies the student's preferred learning style and uses it to personalize recommendations.
*  **Competency-based mastery tracking** estimates mastery of individual skills and subskills from quiz performance.
*  **Attention tracking** estimates student attention using browser-based webcam processing while keeping the camera data on the user's device.
*  **AI-assisted quiz generation** helps teachers create quizzes from course content.
*  **Competency graph** represents relationships and prerequisites between C programming skills.

---

## Architecture

<p align="center">
  <img width="800" alt="NextLearn Architecture" src="https://github.com/user-attachments/assets/474e1ef2-4942-4e6a-a957-2becfb79bc68" />
</p>

NextLearn is organized into three main parts:

* **Node.js / TypeScript / Express** handles the main application logic, authentication, API routes, curriculum management, quizzes, and communication with the database and Python service.
* **Vanilla JavaScript** provides the student, teacher, and authentication interfaces without relying on a frontend framework.
* **MongoDB** stores users, curriculum data, quiz attempts, progress, and uploaded course files.
* **Python / FastAPI** provides the machine-learning and AI services, including predictions, SHAP explanations, the RAG chatbot, VARK clustering, mastery calculations, and attention processing.

The application can run locally with Node automatically starting the Python service, or as three Docker containers for deployment.

---

## AI & Data Science Components

NextLearn uses several AI and data science techniques:

### Student Prediction

Two Random Forest models are used to:

* estimate the probability that a student can catch up;
* predict the student's expected grade.

The models use behavioral and performance-related features such as quiz scores, login frequency, learning gaps, and competency weaknesses.

**SHAP (SHapley Additive exPlanations)** is used to make the predictions more understandable by showing which features contributed to each result.

### RAG Chatbot

The chatbot uses **Retrieval-Augmented Generation (RAG)** to ground its answers in the actual course material.

Course documents such as PDF, PPTX, and DOCX files are extracted, converted into embeddings, and stored in a **ChromaDB** vector index. When a student asks a question, relevant course content is retrieved before generating the answer.

### Personalized Learning

Student progress is connected to a competency graph containing the course skills and their prerequisites.

The platform uses this graph together with mastery estimates and the student's VARK learning profile to recommend relevant content.

### Attention Tracking

Attention tracking is performed directly in the browser using **MediaPipe FaceMesh**.

The webcam is processed locally and only derived attention information is sent to the server. Raw camera images are not uploaded or stored.

---

## Prerequisites

Before running NextLearn, make sure you have:

* **Node.js 20+**
* **Python 3.10+**
* **MongoDB** (local installation or MongoDB Atlas)
* **LibreOffice** required for some document processing operations

Python is required because the Node.js application automatically starts the FastAPI service used by the AI/ML features.

---

## Installation

Clone the repository and install the Node.js dependencies:

```bash
npm install
npm run shap:install   # Install Python dependencies (only needed once)
```

Create a `.env` file at the root of the project:

```env
MONGODB_URI=mongodb://...
AUTH_SECRET=...
APP_BASE_URL=http://localhost:3000

# Optional internal URL when the Python service runs separately
# INTERNAL_BASE_URL=http://app:3000

# LLM / embedding provider
GEMINI_API_KEY=...

# OpenAI-compatible provider (OpenRouter or OpenAI)
OPENAI_API_KEY=...
OPENAI_CHAT_BASE_URL=https://openrouter.ai/api/v1
OPENAI_CHAT_MODEL=meta-llama/llama-3.3-70b-instruct
OPENAI_EMBEDDING_BASE_URL=https://openrouter.ai/api/v1
OPENAI_EMBEDDING_MODEL=openai/text-embedding-3-small

# SMTP - used for password reset emails
SMTP_HOST=...
SMTP_USER=...
SMTP_PASS=...
```

Gemini is used first when a Gemini API key is available. Otherwise, the application falls back to the OpenAI-compatible configuration.

---

## Running Locally

Start the development server with:

```bash
npm run dev
```

The application will be available at:

```text
http://localhost:3000
```

The Node.js server automatically starts the FastAPI service on port `8000` through `shapSupervisor.ts`.

If a FastAPI instance is already running, Node detects it and reuses it instead of starting another process.

### Running the Python Service Separately

When working on the Python code, you can start the FastAPI service manually:

```bash
npm run shap:serve
```

This is useful when developing the ML/RAG components without restarting the Node.js application every time.

---

## RAG Indexing

The chatbot needs an indexed version of the course material before it can answer questions using the curriculum.

Normally, the RAG index is automatically updated when the curriculum is saved from the back-office.

It can also be rebuilt manually:

```bash
npm run reindex:rag
```

For a complete rebuild:

```bash
npm run reindex:rag -- --reset
```

---

## Deployment

NextLearn can be deployed using Docker Compose:

```bash
docker compose up --build
```

The deployment consists of three containers:

```text
mongo  → MongoDB database
ml     → FastAPI AI/ML service
app    → Node.js application
```

Docker Compose handles the internal network configuration between the services.

Two persistent volumes are used:

* `mongo-data` MongoDB data and course files stored through GridFS.
* `chroma-store` the chatbot's ChromaDB vector index.

### Production Checklist

Before deploying:

* Set a strong `AUTH_SECRET`.
* Set `APP_BASE_URL` to the public application domain.
* Configure `INTERNAL_BASE_URL` correctly when using Docker or a separate Python service.
* Put an HTTPS reverse proxy in front of the application.
* Regularly back up the `mongo-data` volume because it contains uploaded course files.
* Keep API keys and SMTP credentials outside the repository.

---

## Project Structure

```text
src/
  server.ts                 Express startup and application entry point
  routes/                   Authentication, curriculum, quizzes, media,
                            predictions, chatbot, attention, back-office...
  services/                 Business logic and integrations
  models/                   MongoDB / Mongoose schemas

ml/
  shap_service.py           FastAPI application
  routers/                  AI/ML API endpoints
  rag/                      RAG chatbot and document processing
  models/                   Trained machine-learning models

scripts/                    Training, indexing, seeding and maintenance scripts

public/
  student/                  Student interface
  back-office/              Teacher / administrator interface
  auth/                     Authentication pages
  themes/                   UI themes
  i18n/                     French / English translations

data/
  normalized quizzes
  calendar data
  training datasets
```

---

## Useful Scripts

| Command                          | Purpose                                         |
| -------------------------------- | ----------------------------------------------- |
| `npm run dev`                    | Start the development server and Python service |
| `npm test`                       | Run the unit tests                              |
| `npx tsc --noEmit`               | Check TypeScript types                          |
| `npm run build`                  | Build the production application                |
| `npm start`                      | Start the production build                      |
| `npm run train:model`            | Retrain the Random Forest models                |
| `npm run reindex:rag`            | Build or update the chatbot vector index        |
| `npm run reindex:rag -- --reset` | Rebuild the chatbot index from scratch          |
| `npm run shap:serve`             | Start the FastAPI service separately            |

---

## Privacy & Security

NextLearn includes several measures to protect student data:

* Authentication uses JWT-based sessions stored in **HttpOnly cookies**.
* Passwords are stored using **bcrypt hashing**.
* Role-based middleware restricts access to student, teacher, and administrator features.
* Webcam processing for attention tracking happens directly in the browser.
* Raw webcam images are not uploaded or stored by the application.
* API keys and authentication secrets are provided through environment variables rather than being stored in the source code.
* HTTPS is required in production for secure session cookies.

---

## Development

Before submitting changes, it is recommended to run:

```bash
npm test
npx tsc --noEmit
npm run build
```

This helps catch failing tests, TypeScript errors, and production build issues before deployment.

---


