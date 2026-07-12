# NextLearn

Plateforme e-learning pour le cours de programmation en C (ESPRIT). Les étudiants suivent
les modules (supports PDF, vidéos, quiz par sous-acquis), et la plateforme ajoute une
couche d'intelligence par-dessus : prédiction du risque de rattrapage et de la note
d'examen avec explications SHAP, chatbot ancré dans le contenu du cours (RAG),
recommandations selon le style d'apprentissage (VARK), et suivi d'attention par webcam
traité entièrement dans le navigateur.

Backend Node.js / TypeScript / Express, frontend en JavaScript natif, MongoDB, plus un
petit service Python pour les explications SHAP.

## Prérequis

- Node.js 20+
- Une base MongoDB (locale ou Atlas)
- Python 3.10+ (uniquement pour le service SHAP, optionnel)
- LibreOffice (uniquement pour la conversion PPTX vers PDF côté back-office, optionnel)

## Installation

```bash
npm install
```

Créer un fichier `.env` à la racine :

```
MONGODB_URI=mongodb://...
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

## Lancer

```bash
npm run dev
```

Le serveur écoute sur http://localhost:3000. Les deux modèles Random Forest
(`data/rf-model.json`, `data/rf-grade-model.json`) sont chargés au démarrage.

Service SHAP (optionnel — les explications utilisent alors la vraie librairie `shap`
sur les arbres exacts du modèle déployé) :

```bash
npm run shap:install   # une seule fois
npm run shap:serve     # FastAPI sur :8000
```

Sans lui, l'API calcule les valeurs de Shapley exactes en JavaScript, puis retombe sur
des règles heuristiques si les modèles ne sont pas chargés.

## Scripts utiles

| Commande | Rôle |
|---|---|
| `npm run dev` | Serveur de développement (tsx watch) |
| `npx tsc --noEmit` | Vérification TypeScript |
| `npm run train:grade-model` | Réentraîne le modèle de note (graine fixe) |
| `npm run evaluate:models` | Métriques honnêtes : split 80/20 + validation croisée |
| `npm run test:fresh-data` | Test sur données générées avec une autre graine |
| `npm run resync:quizzes` | Pousse les quiz `data/*.normalized.json` vers Mongo (avec sauvegarde) |

## Organisation du code

```
src/
  server.ts            démarrage Express, montage des routeurs
  routes/              web.ts (curriculum + quiz, en cours de découpage),
                       auth, pages, student/ (chatbot, attention), backoffice/
  services/            prédiction + SHAP, RAG, LLM, extraction de contenu,
                       accès aux classes, clustering, recommandation
  models/              schémas Mongoose
ml/                    service SHAP Python (reconstruction exacte des arbres)
scripts/               entraînement, évaluation, seed, resync
public/                pages étudiant / back-office / auth, thèmes, i18n FR-EN
data/                  modèles entraînés, quiz normalisés, calendrier
```

Le détail de l'architecture et des conventions est dans `CLAUDE.md`.

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
