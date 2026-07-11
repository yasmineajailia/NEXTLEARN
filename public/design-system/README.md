# NextLearn Design System

Un système de design calme et centré sur le contenu, pour le front-office étudiant et le back-office enseignant.

## Installation

Ajouter dans le `<head>` de chaque page, **avant** les feuilles de style spécifiques à la page :

```html
<link rel="stylesheet" href="/design-system/tokens.css">
<link rel="stylesheet" href="/design-system/components.css">
<link rel="stylesheet" href="/design-system/layouts.css">
<link rel="stylesheet" href="/design-system/animations.css">
```

- `tokens.css` est obligatoire (variables CSS + polices Google Fonts).
- `components.css` suffit pour les composants ; `layouts.css` ajoute les gabarits de page ; `animations.css` ajoute les keyframes (requis pour les spinners, toasts, skeletons et révélations de réponses).
- La typographie de base utilise `:where()` (spécificité zéro) : elle améliore les pages existantes **sans jamais écraser** leurs styles déjà définis.
- Le mode sombre (`data-theme="dark"` sur `<html>`) et le mode daltonien (`data-cvd="on"`) du site sont pris en charge automatiquement : seuls les tokens changent.

## Principes

1. **Calme et concentration** — pas d'éléments décoratifs, pas de dégradés sur les zones de contenu, une seule élévation de carte maximum, jamais de carte dans une carte.
2. **Espace généreux** — padding minimum de `1rem` dans les cartes.
3. **Hiérarchie par la typographie** — taille et graisse, pas la couleur.
4. **La couleur est fonctionnelle** — l'accent `#c41d38` n'apparaît que sur les éléments interactifs, états actifs, indicateurs de progression et alertes.

## Tokens principaux

| Token | Valeur | Usage |
|---|---|---|
| `--color-bg` | `#f7f7f5` | Fond de page |
| `--color-surface` | `#ffffff` | Cartes, panneaux |
| `--color-ink` | `#111318` | Titres, texte fort |
| `--color-ink-secondary` | `#4a4f5c` | Corps de texte |
| `--color-accent` | `#c41d38` | Interactif uniquement |
| `--font-display` | Space Grotesk | Titres |
| `--font-sans` | Inter | Corps |
| `--font-mono` | JetBrains Mono | Code, identifiants, scores |

Toutes les valeurs sont dans [tokens.css](tokens.css).

---

## Composants

### Typographie

```html
<span class="eyebrow">Module 3</span>
<h1 class="page-title">Structures itératives</h1>
<h2 class="section-title">Progression</h2>
<p class="caption">Dernière connexion il y a 2 jours</p>
<span class="mono">ETU-2024-0142</span>
```

### Cartes

```html
<div class="card">
  <h3 class="card__title">Moyenne des quiz</h3>
  <div class="card__body">Contenu de la carte.</div>
</div>

<!-- Variantes -->
<div class="card card--flat">Sans ombre, fond légèrement teinté.</div>
<div class="card card--accent">Bordure gauche accent (mise en avant).</div>
<div class="card card--danger">Alerte : bordure gauche + fond rouge pâle.</div>

<!-- Carte cliquable (lift au survol) -->
<a class="card card--interactive" href="/student/sous-acquis.html?...">…</a>
```

L'effet de survol (translateY + ombre) est **opt-in** via `card--interactive` pour que les cartes de contenu statique restent calmes.

### Boutons

```html
<button class="btn btn--primary">Valider</button>
<button class="btn btn--secondary">Annuler</button>
<button class="btn btn--ghost">Voir plus</button>
<button class="btn btn--danger">Supprimer</button>

<!-- Tailles -->
<button class="btn btn--primary btn--sm">Petit</button>
<button class="btn btn--primary btn--lg">Grand</button>

<!-- Bouton icône (fournir un aria-label) -->
<button class="btn btn--ghost btn--icon" aria-label="Fermer">
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
</button>

<!-- État de chargement : ajouter .btn--loading via JS -->
<button class="btn btn--primary btn--loading">Génération…</button>
```

### Champs de formulaire

```html
<div class="field">
  <label class="field__label" for="email">Adresse e-mail</label>
  <input class="input" type="email" id="email" placeholder="prenom.nom@exemple.fr">
  <p class="field__help">Utilisée pour la récupération du mot de passe.</p>
</div>

<!-- État d'erreur -->
<div class="field">
  <label class="field__label" for="pw">Mot de passe</label>
  <input class="input input--error" type="password" id="pw" aria-describedby="pw-err">
  <p class="field__error" id="pw-err">8 caractères minimum.</p>
</div>

<!-- Select et textarea utilisent la même classe .input -->
<select class="input"><option>Module 1</option></select>
<textarea class="input"></textarea>
```

### Badges

```html
<span class="badge badge--success">Validé</span>
<span class="badge badge--warning">En attente</span>
<span class="badge badge--danger">En difficulté</span>
<span class="badge badge--info">Nouveau</span>
<span class="badge badge--neutral">Brouillon</span>
<span class="badge badge--accent">Enseignant</span>
```

Ne jamais utiliser la couleur seule : le libellé du badge porte toujours le sens.

### Barres de progression

```html
<div class="progress" role="progressbar" aria-valuenow="65" aria-valuemin="0" aria-valuemax="100" aria-label="Progression du module">
  <div class="progress__fill" style="width: 65%"></div>
</div>

<!-- Variantes -->
<div class="progress progress--success progress--thick">…</div>
<div class="progress progress--thin">…</div>
```

Pour le balayage lumineux après remplissage, ajouter `progress__fill--shimmer` sur le fill à la fin de la transition (`transitionend`).

### Tableaux

```html
<div class="table-wrap table-wrap--scroll">
  <table class="table">
    <thead>
      <tr>
        <th><span class="table__sort table__sort--asc">Nom</span></th>
        <th>Classe</th>
        <th>Moyenne</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>
          <div class="row">
            <span class="avatar avatar--blue">AB</span>
            Amine Ben Salah
          </div>
        </td>
        <td><span class="badge badge--neutral">DEV-101</span></td>
        <td><span class="mono">14,5/20</span></td>
      </tr>
    </tbody>
  </table>
</div>
```

Tri : basculer `table__sort--asc` / `table__sort--desc` sur l'en-tête actif.

### Barre latérale de navigation

```html
<nav class="sidenav" aria-label="Navigation principale">
  <div class="student-card">
    <span class="avatar avatar--accent">YL</span>
    <div>
      <div class="student-card__name">Yasmine Laajailia</div>
      <div class="student-card__id">demo.eleve01</div>
    </div>
  </div>

  <div class="sidenav__section">
    <p class="sidenav__section-label">Apprentissage</p>
    <a class="sidenav__item sidenav__item--active" href="#" aria-current="page">Tableau de bord</a>
    <a class="sidenav__item" href="#">Mes modules</a>
    <a class="sidenav__item" href="#">Auto-évaluation</a>
  </div>

  <div class="sidenav__footer">
    <!-- emplacement des toggles thème / déconnexion -->
  </div>
</nav>
```

### Modales

```html
<div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
  <div class="modal">
    <div class="modal__header">
      <h2 class="modal__title" id="dlg-title">Supprimer l'étudiant ?</h2>
      <button class="btn btn--ghost btn--icon btn--sm" aria-label="Fermer">✕</button>
    </div>
    <div class="modal__body">Cette action est irréversible.</div>
    <div class="modal__footer">
      <button class="btn btn--secondary">Annuler</button>
      <button class="btn btn--danger">Supprimer</button>
    </div>
  </div>
</div>
```

JS requis : piéger le focus dans la modale et fermer sur `Escape`.

### Toasts

```html
<div class="toast-stack" role="region" aria-live="polite" aria-label="Notifications">
  <div class="toast toast--success">
    <span class="toast__strip" aria-hidden="true"></span>
    <div>
      <p class="toast__title">Quiz publié</p>
      <p class="toast__message">Les étudiants de DEV-101 peuvent maintenant y accéder.</p>
    </div>
    <button class="toast__close" aria-label="Fermer la notification">✕</button>
  </div>
</div>
```

Auto-dismiss (4 s) : ajouter `toast--leaving` puis retirer l'élément sur `animationend`.

```js
function dismissToast(el) {
  el.classList.add('toast--leaving');
  el.addEventListener('animationend', () => el.remove(), { once: true });
}
setTimeout(() => dismissToast(toastEl), 4000);
```

### Skeletons

```html
<div class="skeleton-card" aria-hidden="true">
  <span class="skeleton skeleton--title"></span>
  <span class="skeleton skeleton--text"></span>
  <span class="skeleton skeleton--text"></span>
  <span class="skeleton skeleton--text"></span>
</div>

<!-- Ligne de tableau en chargement -->
<div class="row" aria-hidden="true">
  <span class="skeleton skeleton--avatar"></span>
  <span class="skeleton skeleton--text" style="width: 160px"></span>
</div>
```

Toujours accompagner d'une zone `aria-live` annonçant « Chargement… ».

### État vide

```html
<div class="empty-state">
  <span class="empty-state__icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35" stroke-linecap="round"/></svg>
  </span>
  <h3 class="empty-state__title">Aucun étudiant</h3>
  <p class="empty-state__desc">Ajoutez un premier étudiant pour commencer le suivi de la classe.</p>
  <button class="btn btn--primary">Ajouter un étudiant</button>
</div>
```

### Menu d'actions (trois points)

```html
<div class="menu-anchor">
  <button class="btn btn--ghost btn--icon btn--sm" aria-haspopup="menu" aria-expanded="false" aria-label="Actions">⋯</button>
  <div class="menu" role="menu" hidden>
    <button class="menu__item" role="menuitem">Voir le profil</button>
    <button class="menu__item" role="menuitem">Envoyer un message</button>
    <div class="menu__divider" role="separator"></div>
    <button class="menu__item menu__item--danger" role="menuitem">Retirer</button>
  </div>
</div>
```

---

## Gabarits de page

### 1. Page de leçon (étudiant)

```html
<header class="lesson-topbar">
  <div class="lesson-topbar__left">
    <a class="btn btn--ghost btn--sm" href="/student/index.html">← Retour</a>
  </div>
  <nav class="lesson-topbar__breadcrumb" aria-label="Fil d'Ariane">
    <a href="#">Module 3</a>
    <span class="crumb-sep" aria-hidden="true">›</span>
    <span class="crumb-current">3.5 — Boucle while</span>
  </nav>
  <div class="lesson-topbar__meta">
    <span>4/7 complétés</span>
    <div class="progress progress--thin" style="width: 90px" role="progressbar" aria-valuenow="57" aria-valuemin="0" aria-valuemax="100" aria-label="Progression du module">
      <div class="progress__fill" style="width: 57%"></div>
    </div>
  </div>
</header>

<div class="lesson-layout">
  <main class="lesson-content">
    <h1 class="page-title">La boucle while</h1>
    <div class="lesson-video"><iframe src="…" title="Vidéo du cours" allowfullscreen></iframe></div>
    <div class="lesson-pdf"><iframe src="…" title="Support de cours PDF"></iframe></div>
    <div class="card card--accent">
      <h3 class="card__title">Prêt à vous évaluer ?</h3>
      <p class="card__body">Le quiz couvre les notions de cette leçon.</p>
      <button class="btn btn--primary" style="margin-top: var(--space-4)">Passer le quiz</button>
    </div>
  </main>

  <aside class="lesson-aside">
    <div class="card card--flat toc">
      <p class="toc__title">Sommaire</p>
      <a class="toc__item toc__item--active" href="#intro">Introduction</a>
      <a class="toc__item" href="#syntaxe">Syntaxe</a>
      <a class="toc__item" href="#exemples">Exemples</a>
    </div>
    <div class="card card--flat checklist">
      <div class="checklist__item checklist__item--done"><span class="checklist__mark"></span>3.1 Notion d'itération</div>
      <div class="checklist__item"><span class="checklist__mark"></span>3.5 Boucle while</div>
    </div>
    <p class="reading-time">Lecture estimée : 12 min</p>
    <button class="btn btn--secondary">Poser une question</button>
  </aside>
</div>
```

### 2. Tableau de bord étudiant

```html
<div class="app-shell">
  <nav class="sidenav">…voir composant sidenav…</nav>
  <main class="app-shell__main anim-page-enter">
    <span class="eyebrow">Tableau de bord</span>
    <h1 class="page-title">Bonjour, Yasmine</h1>
    <section>…</section>
    <section>…</section> <!-- espacées automatiquement de --space-8 -->
  </main>
</div>
```

### 3. Page de liste (back-office)

```html
<div class="app-shell">
  <nav class="sidenav">…</nav>
  <main class="app-shell__main">
    <div class="page-topbar">
      <div>
        <span class="eyebrow">Gestion</span>
        <h1 class="page-title">Étudiants</h1>
      </div>
      <div class="page-topbar__actions">
        <button class="btn btn--primary">Ajouter un étudiant</button>
      </div>
    </div>

    <div class="filters-row">
      <input class="input filters-row__search" type="search" placeholder="Rechercher un étudiant…" aria-label="Rechercher">
      <select class="input" aria-label="Filtrer par classe"><option>Toutes les classes</option></select>
      <span class="filters-row__count">24 résultats</span>
    </div>

    <div class="table-wrap">…tableau…</div>

    <nav class="pagination" aria-label="Pagination">
      <button class="pagination__btn" disabled>Précédent</button>
      <button class="pagination__btn pagination__btn--current" aria-current="page">1</button>
      <button class="pagination__btn">2</button>
      <span class="pagination__ellipsis" aria-hidden="true">…</span>
      <button class="pagination__btn">8</button>
      <button class="pagination__btn">Suivant</button>
    </nav>
  </main>
</div>
```

### 4. Page de quiz

```html
<div class="quiz-progress" role="progressbar" aria-valuenow="40" aria-valuemin="0" aria-valuemax="100" aria-label="Questions répondues">
  <div class="quiz-progress__fill" style="width: 40%"></div>
</div>

<main class="quiz-page">
  <div class="question-card anim-page-enter">
    <span class="question-card__number">Question 2 / 5</span>
    <p class="question-card__text">Quelle boucle s'exécute au moins une fois ?</p>
    <div class="answer-options" role="radiogroup" aria-label="Réponses">
      <button class="answer-option" role="radio" aria-checked="false">while</button>
      <button class="answer-option answer-option--selected" role="radio" aria-checked="true">do…while</button>
      <button class="answer-option" role="radio" aria-checked="false">for</button>
      <button class="answer-option" role="radio" aria-checked="false">if</button>
    </div>
    <div class="quiz-nav">
      <button class="btn btn--secondary">Précédent</button>
      <button class="btn btn--primary">Suivant</button>
    </div>
  </div>
</main>
```

Après soumission : remplacer `--selected` par `--correct` / `--wrong` et ajouter `answer-option--disabled` sur toutes les options. La bonne réponse non choisie reçoit aussi `--correct`.

Résultat (anneau SVG — `stroke-dasharray` = circonférence, `stroke-dashoffset` = circonférence × (1 − score)) :

```html
<div class="card quiz-result quiz-result--pass" role="status">
  <div class="quiz-result__ring">
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <circle class="quiz-result__ring-track" cx="50" cy="50" r="42"/>
      <circle class="quiz-result__ring-fill" cx="50" cy="50" r="42"
              stroke-dasharray="263.9" stroke-dashoffset="52.8"/>
    </svg>
    <div class="quiz-result__score">80%<small>16/20</small></div>
  </div>
  <span class="badge badge--success">Réussi</span>
  <div class="quiz-result__meta"><span>Temps : 4 min 12 s</span></div>
  <div class="quiz-result__reco">Revoyez la section « Condition de sortie » avant le prochain sous-acquis.</div>
</div>
```

### Grille de modules (page programmation-c)

```html
<div class="module-grid anim-stagger">
  <div class="card module-card anim-page-enter">
    <div class="module-card__head" role="button" tabindex="0" aria-expanded="false">
      <span class="module-card__number">3</span>
      <div class="module-card__info">
        <h3 class="module-card__name">Structures itératives</h3>
        <div class="module-card__stats">
          <div class="progress"><div class="progress__fill" style="width: 57%"></div></div>
          <span class="module-card__count">4/7</span>
        </div>
      </div>
      <svg class="module-card__chevron" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 8l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <div class="module-card__chips">
      <a class="chip chip--done" href="#">3.1 Itération <span class="chip__score">85%</span></a>
      <a class="chip" href="#">3.5 Boucle while</a>
    </div>
  </div>
</div>
```

Basculer `module-card--open` sur le `.module-card` (et `aria-expanded`) au clic.

### Génération de quiz (enseignant)

```html
<div class="gen-layout">
  <div class="card gen-form">
    <h3 class="card__title">Générer un quiz</h3>
    <div class="field"><label class="field__label">Module</label><select class="input">…</select></div>
    <div class="field"><label class="field__label">Nombre de questions</label><input class="input" type="range" min="3" max="15"></div>
    <div class="field"><label class="field__label">Difficulté</label><select class="input">…</select></div>
    <button class="btn btn--primary" style="width:100%">Générer</button>
  </div>

  <div class="gen-preview">
    <div class="bulk-bar" hidden>
      <span class="bulk-bar__count">3 sélectionnées</span>
      <button class="btn btn--secondary btn--sm">Valider la sélection</button>
      <button class="btn btn--danger btn--sm">Supprimer la sélection</button>
    </div>

    <div class="card gen-question">
      <div class="gen-question__toolbar">
        <button class="btn btn--ghost btn--icon btn--sm" aria-label="Modifier">✎</button>
        <button class="btn btn--ghost btn--icon btn--sm" aria-label="Supprimer">✕</button>
      </div>
      <span class="badge badge--warning">Moyen</span>
      <p class="card__body" style="margin-top: var(--space-3)">Que retourne <code>i++</code> ?</p>
      <div class="gen-question__options">
        <label class="gen-question__option gen-question__option--correct"><input type="radio" checked> La valeur avant incrément</label>
        <label class="gen-question__option"><input type="radio"> La valeur après incrément</label>
      </div>
    </div>
  </div>
</div>

<footer class="gen-footer">
  <div class="gen-footer__stats">
    <span><strong>8</strong> générées</span>
    <span><strong>5</strong> validées</span>
  </div>
  <button class="btn btn--primary">Publier le quiz</button>
</footer>
```

---

## Micro-interactions

| Interaction | Implémentation |
|---|---|
| Compteurs KPI animés (0 → valeur, 800 ms) | Snippet JS ci-dessous |
| Balayage après remplissage de progression | `progress__fill--shimmer` sur `transitionend` |
| Entrée de page | `.anim-page-enter` sur le conteneur principal |
| Liste décalée | `.anim-stagger` sur le parent + `.anim-page-enter` sur les enfants |
| Bonne réponse | classe `answer-option--correct` (révélation par clip-path) |
| Mauvaise réponse | classe `answer-option--wrong` (secousse horizontale) |

```js
function animateCounter(el, target, duration = 800) {
  const start = performance.now();
  const suffix = el.dataset.suffix || '';
  function frame(now) {
    const p = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(target * eased) + suffix;
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
// <span class="kpi-value" data-suffix="%">0</span>
document.querySelectorAll('[data-count-to]').forEach((el) =>
  animateCounter(el, Number(el.dataset.countTo))
);
```

## Accessibilité — règles non négociables

- Tout élément interactif est atteignable au clavier et affiche un anneau de focus visible (`--shadow-focus`).
- La couleur n'est **jamais** le seul indicateur d'état : toujours un libellé ou une icône en plus.
- Les modales piègent le focus et se ferment sur `Escape`.
- Les contenus dynamiques (résultats de quiz, toasts, chargements) sont annoncés via `aria-live`.
- Cibles tactiles ≥ 44 × 44 px sur mobile (appliqué automatiquement via `@media (pointer: coarse)`).
- `prefers-reduced-motion` désactive tous les mouvements (géré dans animations.css).

## Compatibilité avec l'existant

- Les keyframes sont préfixés `ds-` et les classes évitent les noms déjà utilisés par le site (ex. la barre latérale utilise `.sidenav__item`, pas `.nav-item`, pour ne pas entrer en collision avec le back-office actuel).
- Les modes sombre et daltonien existants (`public/shared/theme.js`) fonctionnent sans modification : les tokens sont remappés sous `[data-theme="dark"]` et `[data-cvd="on"]`.
