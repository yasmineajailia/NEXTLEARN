import fs from 'node:fs/promises';
import path from 'node:path';
import { Recommender } from '../src/services/recommendation/skill-recommender.js';

async function main() {
  const graphPath = path.join(process.cwd(), 'graph.json');
  const raw = await fs.readFile(graphPath, 'utf8');
  const graph = JSON.parse(raw);

  const recommender = new Recommender(graph as any);

  // Example: mark a few completed skills (adjust to your graph ids)
  recommender.setCompleted(['1.1.1', '1.1.2']);

  // Example: load some sub-skill scores
  recommender.loadSubSkillScores([
    { subSkillId: '1.1.1', score: 85 },
    { subSkillId: '1.1.2', score: 45 },
    { subSkillId: '1.2.1', score: 55 }
  ]);

  console.log('--- Snapshot ---');
  console.log(JSON.stringify(recommender.snapshot().slice(0, 5), null, 2));

  console.log('--- Recommend ---');
  console.log(JSON.stringify(recommender.recommend({ limit: 10 }), null, 2));

  console.log('--- Remediation ---');
  console.log(JSON.stringify(recommender.remediation({ limit: 10 }), null, 2));

  console.log('--- Revisit ---');
  console.log(JSON.stringify(recommender.revisit({ limit: 10 }), null, 2));

  console.log('--- Skill Score Report ---');
  console.log(JSON.stringify(recommender.skillScoreReport(), null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
