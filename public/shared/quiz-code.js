/**
 * quiz-code.js
 *
 * Shared, dependency-free renderer that turns quiz question / option text into
 * safe HTML with code styling. The quiz generator does not tag code explicitly,
 * so this detects it: it finds code "atoms" (statements, calls, #include,
 * backtick spans, ```fences```) and MERGES atoms separated only by connective
 * code (whitespace, braces, operators) into a single region. That turns a
 * snippet like
 *   int i = 1; do { printf("%d ", i); i++;} while (i < 4);
 * — which would otherwise fragment into several scattered inline chips — into a
 * single clean code block. Every slice is HTML-escaped, so the output is safe
 * against injection and preserves literal <, > (e.g. #include <stdio.h>).
 *
 * Global API (classic script tag):
 *   NextLearnQuizCode.render(rawString)     -> HTML string (safe to inject)
 *   NextLearnQuizCode.escapeHtml(rawString) -> escaped string
 */
(function (root) {
  "use strict";

  var STYLE_ID = "nl-quiz-code-styles";

  // Self-contained styling so any page including this script renders code the
  // same way, regardless of its own stylesheet.
  function injectStyles() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    var css =
      "code.nl-qc-inline{font-family:ui-monospace,'Cascadia Code','SF Mono',Consolas,'Liberation Mono',monospace;" +
      "font-size:.86em;background:#eef1f7;border:1px solid #dde3ee;border-radius:6px;padding:.08em .4em;color:#b21f2d;" +
      // pre-wrap, not nowrap: internal spacing still matters in code, but a long
      // single-statement option must wrap inside its row rather than overflow it.
      "white-space:pre-wrap;overflow-wrap:break-word;}" +
      "pre.nl-qc-block{margin:.5rem 0;padding:.75rem .9rem;background:#1e2430;border-radius:10px;overflow-x:auto;}" +
      "pre.nl-qc-block code{font-family:ui-monospace,'Cascadia Code','SF Mono',Consolas,'Liberation Mono',monospace;" +
      "font-size:.85rem;color:#e6e9f0;white-space:pre;}";
    var el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // C keywords that can lead a statement. Bare keywords are never matched on
  // their own (words like "case"/"long" exist in French prose) — they only
  // count as part of a statement ending in ";" or a call "name(...)".
  var C_KEYWORDS =
    "return|int|float|double|char|void|struct|union|enum|sizeof|const|unsigned|" +
    "signed|long|short|static|else|for|while|do|switch|case|break|continue|" +
    "default|goto|typedef|bool|if|printf|scanf|malloc|free|main";

  var CODE_ATOM = new RegExp(
    [
      "`[^`]+`", // inline backticks
      "#include\\s*(?:<[^>\\n]+>|\"[^\"\\n]+\")", // #include directives
      "\\b(?:" + C_KEYWORDS + ")\\b[^\\n;]*;", // keyword-led statement ending in ;
      "\\b[A-Za-z_]\\w*\\s*\\([^()\\n]*\\)" // function call: name(...)
    ].join("|"),
    "g"
  );

  // A gap between two code atoms belongs to the same snippet when it is either
  // pure whitespace/newlines, or short and made only of code characters WITH at
  // least one real code punctuation mark (so prose words never bridge atoms).
  function isConnectiveGap(gap) {
    if (/^\s*$/.test(gap)) return true;
    return (
      gap.length <= 40 &&
      /[;{}()=<>+\-*/%&|!\[\]]/.test(gap) &&
      /^[\s\w+\-*/%=<>!&|^~.,;:{}()\[\]"'\\]*$/.test(gap)
    );
  }

  // Split a fence-free segment into prose + merged code regions and render it.
  function renderSegment(src) {
    if (!src) return "";
    var atoms = [];
    var m;
    CODE_ATOM.lastIndex = 0;
    while ((m = CODE_ATOM.exec(src)) !== null) {
      atoms.push({ start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) CODE_ATOM.lastIndex++;
    }
    if (!atoms.length) return escapeHtml(src);

    // Merge atoms joined only by connective code into single regions.
    var regions = [];
    var cur = { start: atoms[0].start, end: atoms[0].end };
    for (var i = 1; i < atoms.length; i++) {
      if (isConnectiveGap(src.slice(cur.end, atoms[i].start))) {
        cur.end = atoms[i].end;
      } else {
        regions.push(cur);
        cur = { start: atoms[i].start, end: atoms[i].end };
      }
    }
    regions.push(cur);

    var out = "";
    var last = 0;
    for (var r = 0; r < regions.length; r++) {
      var reg = regions[r];
      out += escapeHtml(src.slice(last, reg.start));
      var code = src.slice(reg.start, reg.end);
      // A genuinely multi-line or multi-statement region reads best as a block.
      // Braces alone are NOT enough: an array initialiser such as
      //   char tab[] = {"a", "b", "c"};
      // is a single statement, and blocking it makes one quiz option tower over
      // its siblings. Real snippets that deserve a block (a loop body, a struct)
      // carry a newline or several statements anyway.
      var asBlock = /\n/.test(code) || (code.match(/;/g) || []).length >= 2;
      code = code.replace(/^`+|`+$/g, ""); // drop backtick markers if present
      out += asBlock
        ? '<pre class="nl-qc-block"><code>' + escapeHtml(code) + "</code></pre>"
        : '<code class="nl-qc-inline">' + escapeHtml(code) + "</code>";
      last = reg.end;
    }
    out += escapeHtml(src.slice(last));
    return out;
  }

  function render(raw) {
    injectStyles();
    var src = String(raw == null ? "" : raw);
    // Explicit ```fences``` win outright; everything between goes to renderSegment.
    var out = "";
    var last = 0;
    var fenceRe = /```[a-zA-Z0-9]*\n?([\s\S]*?)```/g;
    var fm;
    while ((fm = fenceRe.exec(src)) !== null) {
      out += renderSegment(src.slice(last, fm.index));
      out += '<pre class="nl-qc-block"><code>' + escapeHtml(fm[1].replace(/\n+$/, "")) + "</code></pre>";
      last = fm.index + fm[0].length;
    }
    out += renderSegment(src.slice(last));
    return out;
  }

  root.NextLearnQuizCode = { render: render, escapeHtml: escapeHtml };
})(typeof window !== "undefined" ? window : this);
