import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

// Default runtime configuration for local development.
// You can override these values with environment variables.
export const env = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  mongodbUri: process.env.MONGODB_URI ?? "",
  appBaseUrl: process.env.APP_BASE_URL ?? "http://localhost:3000",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiEmbeddingBaseUrl: process.env.OPENAI_EMBEDDING_BASE_URL ?? "https://api.openai.com/v1",
  openaiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
  openaiChatBaseUrl: process.env.OPENAI_CHAT_BASE_URL ?? "https://api.openai.com/v1",
  openaiChatModel: process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiBaseUrl: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta",
  geminiEmbeddingModel: process.env.GEMINI_EMBEDDING_MODEL ?? "text-embedding-004",
  geminiChatModel: process.env.GEMINI_CHAT_MODEL ?? "gemini-1.5-flash",
  smtpHost: process.env.SMTP_HOST ?? "",
  smtpPort: Number(process.env.SMTP_PORT ?? 587),
  smtpSecure: process.env.SMTP_SECURE === "true",
  smtpUser: process.env.SMTP_USER ?? "",
  smtpPass: process.env.SMTP_PASS ?? "",
  smtpFrom: process.env.SMTP_FROM ?? "NextLearn <no-reply@nextlearn.local>"
};
