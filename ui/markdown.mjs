import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

const purifiers = new WeakMap();
export function renderMarkdown(document, text) {
  const window = document.defaultView;
  if (!purifiers.has(window)) purifiers.set(window, createDOMPurify(window));
  const fragment = purifiers.get(window).sanitize(marked.parse(String(text || ''), { gfm: true, breaks: true }), {
    RETURN_DOM_FRAGMENT: true, SANITIZE_NAMED_PROPS: true, ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'img', 'video', 'audio', 'svg', 'math'],
    FORBID_ATTR: ['style'],
  });
  for (const link of fragment.querySelectorAll('a')) {
    try {
      const url = new URL(link.getAttribute('href'));
      if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) throw new Error('Unsafe link');
      link.target = '_blank'; link.rel = 'noopener noreferrer';
    } catch { link.removeAttribute('href'); }
  }
  for (const pre of fragment.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const source = code.textContent;
    const language = [...code.classList].find(name => name.startsWith('language-'))?.slice(9);
    if (language && hljs.getLanguage(language) && source.length <= 20000) {
      code.innerHTML = hljs.highlight(source, { language }).value;
      code.classList.add('hljs');
    }
    const wrap = document.createElement('div'); wrap.className = 'code-block';
    const header = document.createElement('div'); header.className = 'code-header';
    const label = document.createElement('span'); label.textContent = language || 'code';
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制';
    copy.onclick = async () => {
      try { await window.navigator.clipboard.writeText(source); copy.textContent = '已复制'; }
      catch { copy.textContent = '复制失败'; }
    };
    header.append(label, copy);
    pre.replaceWith(wrap); wrap.append(header, pre);
  }
  return fragment;
}
