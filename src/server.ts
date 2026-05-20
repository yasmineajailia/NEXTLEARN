import express from "express";
import path from "node:path";
import mongoose from "mongoose";
import { env } from "./config/env";
import { webRouter } from "./routes/web";

// App bootstrap.
// Express serves static files from public/ and API/page routes from webRouter.
const app = express();

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

// Static assets: CSS, images, and any future client-side JavaScript.
app.use(express.static(path.join(process.cwd(), "public")));
app.use(
  "/Support_Cours_Préparation",
  express.static(path.join(process.cwd(), "content", "Support_Cours_Préparation"))
);
app.get("/graph.json", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "graph.json"));
});
app.use(
  "/vendor/pdfjs",
  express.static(path.join(process.cwd(), "node_modules", "pdfjs-dist", "build"))
);

// App routes.
app.use(webRouter);

// Friendly 404 fallback for unknown routes.
app.use((_req, res) => {
  res.status(404).json({ message: "Route not found" });
});

// MongoDB connection
async function startServer() {
  try {
    if (!env.mongodbUri) {
      throw new Error("MONGODB_URI environment variable is not set");
    }

    await mongoose.connect(env.mongodbUri);
    console.log("Connected to MongoDB");

    app.listen(env.port, () => {
      // Startup log helps confirm active environment and server port.
      console.log(`NextLearn server running on http://localhost:${env.port} (${env.nodeEnv})`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
