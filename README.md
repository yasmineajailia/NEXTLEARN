# NextLearn

Plateforme e-learning pour le cours de programmation en C (ESPRIT). Les étudiants suivent
les modules (supports PDF, vidéos, quiz par sous-acquis), et la plateforme ajoute une
couche d'intelligence par-dessus : prédiction du risque de rattrapage et de la note
d'examen avec explications SHAP, chatbot ancré dans le contenu du cours (RAG),
recommandations selon le style d'apprentissage (VARK), et suivi d'attention par webcam
traité entièrement dans le navigateur.

Backend Node.js / TypeScript / Express, frontend en JavaScript natif, MongoDB, plus un
service Python (FastAPI) qui héberge les prédictions ML + SHAP, le RAG du chatbot,
le clustering VARK, l'analyse d'attention et le suivi de maîtrise (SAKT).

## Prérequis

- Node.js 20+
- Une base MongoDB (locale ou Atlas)
- Python 3.10+ — **requis**, pas optionnel : Node démarre automatiquement le service
  Python (voir plus bas) et le chatbot/les prédictions en dépendent entièrement, il
  n'y a plus de repli en JavaScript pur.
- LibreOffice (uniquement pour la conversion PPTX vers PDF côté back-office, optionnel)

## Installation

```bash
npm install
npm run shap:install   # dépendances Python (une seule fois)
```

Créer un fichier `.env` à la racine :

```
MONGODB_URI=mongodb://...
AUTH_SECRET=...               # signe les sessions JWT ; obligatoire en production
APP_BASE_URL=http://localhost:3000   # utilisé par le service Python pour relire les fichiers de cours

# Fournisseur LLM/embeddings : Gemini est utilisé en priorité si sa clé est présente,
# sinon on retombe sur les variables OPENAI_* (compatibles OpenRouter).
GEMINI_API_KEY=...
OPENAI_API_KEY=...            # clé OpenRouter (ou OpenAI)
OPENAI_CHAT_BASE_URL=https://openrouter.ai/api/v1
OPENAI_CHAT_MODEL=meta-llama/llama-3.3-70b-instruct
OPENAI_EMBEDDING_BASE_URL=https://openrouter.ai/api/v1
OPENAI_EMBEDDING_MODEL=openai/text-embedding-3-small

SMTP_HOST=...                 # pour la réinitialisation de mot de passe
SMTP_USER=...
SMTP_PASS=...
```

Sans clé LLM, le chatbot retombe sur des réponses déterministes construites depuis le
contenu indexé, et la génération de quiz par IA est indisponible. Le reste fonctionne.
`AUTH_SECRET` a une valeur de secours en développement (avec un avertissement) mais le
serveur refuse de démarrer sans elle en production.

## Lancer

```bash
npm run dev
```

Le serveur écoute sur http://localhost:3000. Il démarre lui-même le service Python
(`ml/shap_service.py`, port 8000) en arrière-plan via `shapSupervisor.ts` — pas besoin
de le lancer à la main pour le développement courant. Ce service héberge, sous une
seule appli FastAPI : les modèles Random Forest (`ml/models/rf-risk.joblib`,
`rf-grade.joblib`), les explications SHAP, le RAG du chatbot (`ml/rag/`, index vectoriel
ChromaDB), le clustering VARK, l'attention et le suivi de maîtrise (SAKT).

Pour l'itérer séparément (sans redémarrer Node à chaque changement Python) :

```bash
npm run shap:serve     # FastAPI sur :8000
```

Node détecte une instance déjà démarrée et l'adopte plutôt que d'en relancer une
seconde.

Le contenu des leçons (PDF/PPTX) doit être indexé pour que le chatbot ait de la matière :
un `POST /rag/reindex` est déclenché automatiquement à chaque sauvegarde de curriculum
côté back-office, mais on peut le forcer manuellement :

```bash
npm run reindex:rag            # incrémental
npm run reindex:rag -- --reset # reconstruit l'index vectoriel depuis zéro
```

## Scripts utiles

| Commande | Rôle |
|---|---|
| `npm run dev` | Serveur de développement (tsx watch), démarre aussi le service Python |
| `npm test` | Tests unitaires (Vitest) |
| `npx tsc --noEmit` | Vérification TypeScript |
| `npm run build` / `npm start` | Build de production puis lancement (`dist/`) |
| `npm run train:model` | Réentraîne les modèles Random Forest (risque + note) |
| `npm run reindex:rag` | (Re)construit l'index vectoriel du chatbot depuis le curriculum persisté |
| `npm run resync:quizzes` | Pousse les quiz `data/*.normalized.json` vers Mongo (avec sauvegarde) |
| `npm run seed:login-users` / `seed:modules` / `seed:demo-classes` / `seed:clustering-demo` | Comptes et données de démo |

## Organisation du code

```
src/
  server.ts            démarrage Express, montage des routeurs, lance shapSupervisor
  routes/               auth, pages, web/ (curriculum, quiz, media, prédiction...),
                        student/ (chatbot, attention), backoffice/
  services/             prédiction + SHAP, chatbot (learnerProfile, ragClient),
                        extraction de contenu, accès aux classes, clustering
  models/               schémas Mongoose
ml/
  shap_service.py       appli FastAPI unique : monte tous les routers ci-dessous
  routers/               risk, clustering, attention, rag_routes, mastery, quiz
  rag/                   RAG du chatbot : retrieve/generate (LLM), embed, extraction
                        de contenu (PDF/PPTX/DOCX), store (ChromaDB, sur disque)
  models/                modèles entraînés (.joblib, SAKT .pt)
scripts/               entraînement, reindex RAG, seed, resync
public/                pages étudiant / back-office / auth, thèmes, i18n FR-EN
data/                  quiz normalisés, calendrier, jeux de données d'entraînement
```

## Quelques choix à connaître

- Le suivi d'attention (MediaPipe FaceMesh) tourne à 100 % dans le navigateur : aucune
  image ne quitte la machine de l'étudiant, seuls des scores dérivés sont envoyés,
  et uniquement après consentement explicite.
- Les métriques ML annoncées sont mesurées sur données de test, pas d'entraînement :
  environ 72-76 % d'exactitude (AUC 0,81-0,84) pour le classifieur de risque, et une
  erreur moyenne d'environ 0,95 point sur 20 pour la note prédite.
- L'interface est en français par défaut, avec bascule anglais (bouton FR/EN dans la
  barre latérale), mode sombre et palette adaptée au daltonisme.
- Comptes de démonstration : voir les scripts de seed dans `scripts/`.
