import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../ui/markdown.mjs';

test('Markdown renders headings, tables and highlighted code with copy controls', () => {
  const dom=new JSDOM('<main></main>',{url:'https://example.com/'});
  try {
    const fragment=renderMarkdown(dom.window.document,'## 结果\n\n|项目|值|\n|---|---|\n|测试|通过|\n\n```js\nconst value = "hello";\n```');
    dom.window.document.querySelector('main').append(fragment);
    assert.equal(dom.window.document.querySelector('h2').textContent,'结果');
    assert.ok(dom.window.document.querySelector('table'));
    assert.ok(dom.window.document.querySelector('code .hljs-keyword'));
    assert.equal(dom.window.document.querySelector('.code-header button').textContent,'复制');
  } finally {dom.window.close();}
});
test('untrusted HTML, tracking images, active URLs and DOM clobbering are sanitized', () => {
  const dom=new JSDOM('<main></main>',{url:'https://example.com/'});
  try {
    const fragment=renderMarkdown(dom.window.document,'<script>alert(1)</script><img src="https://tracker.example/pixel"><iframe src="https://evil.example"></iframe><input id="prompt"><a href="javascript:alert(1)" onclick="alert(1)">bad</a><h2 id="model-label">heading</h2>\n\n[正常链接](https://example.com/docs)');
    dom.window.document.querySelector('main').append(fragment);
    assert.equal(dom.window.document.querySelector('script,img,iframe,input,[onclick]'),null);
    assert.equal(dom.window.document.querySelector('a').hasAttribute('href'),false);
    assert.equal(dom.window.document.querySelector('#model-label'),null);
    assert.equal([...dom.window.document.querySelectorAll('a')].at(-1).rel,'noopener noreferrer');
  } finally {dom.window.close();}
});
