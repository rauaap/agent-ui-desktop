/**
 * A deliberately small Markdown subset for agent messages: headings, bold,
 * italic, strikethrough, inline code, fenced code blocks, bullet/numbered lists
 * and links. Same subset and same rules as the Android client's Markdown.java.
 *
 * That class flattens to text-plus-spans because Android needs a Spannable;
 * here we emit HTML instead, so lists and code blocks become real `<ul>` and
 * `<pre>` rather than glyph prefixes. `toHtml` is pure — no DOM — so it can be
 * tested headlessly.
 *
 * Everything is escaped on the way out: agent output is text, and it lands in
 * innerHTML.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Schemes we are willing to put in an href. Anything else renders as text. */
const SAFE_SCHEME = /^(https?:|mailto:|#|\/|\.{0,2}\/)/i;

const isDigit = (ch) => ch >= '0' && ch <= '9';
const isWordChar = (ch) => /[A-Za-z0-9]/.test(ch);

/** Render a markdown string to an HTML string. */
export function toHtml(md) {
  const lines = String(md ?? '').split('\n');
  const out = [];

  let paragraph = [];
  let list = null; // { ordered: boolean, items: string[] }

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${paragraph.join('<br>')}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? 'ol' : 'ul';
    out.push(`<${tag}>${list.items.map((item) => `<li>${item}</li>`).join('')}</${tag}>`);
    list = null;
  };

  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // A closing fence must be bare and at least as long as its opener. Fences
    // inside the block are literal content; use a longer outer fence to show
    // shorter fenced examples, as required by standard Markdown.
    const openingFence = trimmed.match(/^(`{3,})(.*)$/);
    if (openingFence) {
      flush();
      const fenceLength = openingFence[1].length;
      const language = openingFence[2].trim();
      const code = [];
      let j = i + 1;
      while (j < lines.length) {
        const candidate = lines[j].trim().match(/^(`{3,})$/);
        if (candidate && candidate[1].length >= fenceLength) break;
        code.push(lines[j]);
        j++;
      }
      const cls = language ? ` class="lang-${escapeHtml(language.replace(/[^\w.+-]/g, ''))}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(code.join('\n'))}</code></pre>`);
      i = j; // the loop's i++ steps past the closing fence
      continue;
    }

    // blank line ends whatever block was open
    if (!trimmed) {
      flush();
      continue;
    }

    // heading: 1..6 '#' followed by a space
    let h = 0;
    while (h < trimmed.length && trimmed[h] === '#') h++;
    if (h >= 1 && h <= 6 && trimmed[h] === ' ') {
      flush();
      out.push(`<h${h}>${inline(trimmed.slice(h + 1).trim())}</h${h}>`);
      continue;
    }

    // bullet list: -, * or + followed by a space
    if (/^[-*+] /.test(trimmed)) {
      flushParagraph();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(inline(trimmed.slice(2).trim()));
      continue;
    }

    // numbered list: digits, a dot, then a space
    let d = 0;
    while (d < trimmed.length && isDigit(trimmed[d])) d++;
    if (d > 0 && trimmed[d] === '.' && trimmed[d + 1] === ' ') {
      flushParagraph();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(inline(trimmed.slice(d + 2).trim()));
      continue;
    }

    // plain paragraph line — a single newline is a line break, matching how the
    // Android client renders agent prose
    flushList();
    paragraph.push(inline(line));
  }

  flush();
  return out.join('');
}

/**
 * Parse inline markers within one line. Recursive, so emphasis nests; inline
 * code wins over everything inside it.
 */
function inline(source) {
  const s = String(source);
  const n = s.length;
  let out = '';
  let i = 0;

  while (i < n) {
    const c = s[i];

    // Inline code delimiters are runs of backticks. Only a run of exactly the
    // same length closes the span; differently sized runs are literal content.
    if (c === '`') {
      let openingEnd = i + 1;
      while (openingEnd < n && s[openingEnd] === '`') openingEnd++;
      const delimiterLength = openingEnd - i;
      let search = openingEnd;
      let closingEnd = -1;

      while (search < n) {
        const closingStart = s.indexOf('`', search);
        if (closingStart < 0) break;
        let end = closingStart + 1;
        while (end < n && s[end] === '`') end++;
        if (end - closingStart === delimiterLength) {
          let code = s.slice(openingEnd, closingStart);
          if (code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code)) {
            code = code.slice(1, -1);
          }
          out += `<code>${escapeHtml(code)}</code>`;
          closingEnd = end;
          break;
        }
        search = end;
      }

      if (closingEnd >= 0) {
        i = closingEnd;
        continue;
      }
    }

    // link [text](url)
    if (c === '[') {
      const close = s.indexOf(']', i + 1);
      if (close > i && s[close + 1] === '(') {
        const paren = s.indexOf(')', close + 2);
        if (paren > close) {
          const text = inline(s.slice(i + 1, close));
          const href = s.slice(close + 2, paren).trim();
          out += SAFE_SCHEME.test(href)
            ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${text}</a>`
            : text;
          i = paren + 1;
          continue;
        }
      }
    }

    // emphasis: ** / __ (bold), ~~ (strike), * / _ (italic)
    if (c === '*' || c === '_' || c === '~') {
      const double = s[i + 1] === c;
      // a lone '~' is not a marker; underscores inside words (snake_case) are
      // not emphasis either
      let ok = c !== '~' || double;
      if (c === '_' && i > 0 && isWordChar(s[i - 1])) ok = false;

      if (ok) {
        const delim = double ? c + c : c;
        const from = i + delim.length;
        const close = s.indexOf(delim, from);
        if (close >= from) {
          const tag = double ? (c === '~' ? 'del' : 'strong') : 'em';
          out += `<${tag}>${inline(s.slice(from, close))}</${tag}>`;
          i = close + delim.length;
          continue;
        }
      }
    }

    out += escapeHtml(c);
    i++;
  }

  return out;
}
