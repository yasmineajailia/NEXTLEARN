import mongoose from "mongoose";
import { env } from "../src/config/env";
import { CurriculumModule } from "../src/models/CurriculumModule";

const newModules = [
  { id: "uiux", name: "UI/UX" },
  { id: "anglais", name: "Anglais" },
  { id: "algorithmiques", name: "Algorithmiques" }
];

async function main(): Promise<void> {
  if (!env.mongodbUri) {
    throw new Error("MONGODB_URI environment variable is not set");
  }

  await mongoose.connect(env.mongodbUri);

  const existing = await CurriculumModule.find({}, { id: 1, name: 1, sortOrder: 1 });
  const existingIds = new Set(existing.map((m: any) => m.id));
  const maxSortOrder = existing.reduce((max: number, m: any) => Math.max(max, m.sortOrder ?? 0), 0);

  let nextSortOrder = maxSortOrder + 1;
  let addedCount = 0;

  for (const mod of newModules) {
    if (existingIds.has(mod.id)) {
      console.log(`Skipped (already exists): ${mod.name}`);
      continue;
    }

    await CurriculumModule.create({
      id: mod.id,
      name: mod.name,
      sortOrder: nextSortOrder++,
      acquis: []
    });

    console.log(`Added: ${mod.name} (id: ${mod.id}, sortOrder: ${nextSortOrder - 1})`);
    addedCount++;
  }

  console.log(`\nDone. ${addedCount} module(s) added.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
