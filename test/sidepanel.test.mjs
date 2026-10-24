import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../ui/markdown.mjs';
import { applyStreamEvent, mergeStreaming } from '../ui/stream-state.mjs';

async function panel({ streaming=false }={}) {
  const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../extension/workspace.js', import.meta.url), 'utf8').replace(/^import .*?;\n/m, '');
  const dom = new JSDOM(html, { url: 'https://extension.test/sidepanel.html', runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [];
  const storage = {};
  let messages = [];
  let paused = false;
  let model = { providerID: 'test', id: 'model-a' };
  let agent = 'build';
  let serverBusy = false;
  let forms=[];
  const ports=[];
  const event = { addListener() {} };
  w.chrome = {
    windows: { async getCurrent() { return { id: 1 }; } },
    tabs: { async query() { return [{ id: 9, title: '演示页面', url: 'https://example.com/' }]; }, onActivated: event, onUpdated: event },
    storage: { session: { async get(key) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, storage[k]])); }, async set(data) { Object.assign(storage, data); }, async remove(key) { delete storage[key]; } } },
    runtime: { async sendMessage(message) {
      calls.push(message);
      if (message.type === 'control_state') return { connected: true, paused, tabId: null };
      if (message.type === 'stop') { paused = true; return {}; }
      if (message.type === 'resume') { paused = false; return {}; }
      if (message.type !== 'chat') return { paired: true };
      const r = message.request;
      if (r.operation === 'catalog') return { models: [{ providerID:'test', id:'model-a', name:'模型 A', variants:['fast','deep'] }, { providerID:'test', id:'model-b', name:'模型 B', variants:['high'] }], defaultModel: { providerID:'test', id:'model-a' }, agents: [{ id:'build', name:'Build' }, { id:'plan', name:'Plan' }] };
      if (r.operation === 'list') return { sessions: [{ id: 'ses_demo', title: '<script>history</script>' }] };
      if (r.operation === 'create') { model = r.model || model; agent = r.agent || agent; return { session: { id: 'ses_demo' } }; }
      if (r.operation === 'read') return { session: { id: 'ses_demo', title:'演示会话', model, agent }, busy: serverBusy, messages, permissions: [], forms };
      if(r.operation==='form_reply'){forms=[];return{replied:true};}
      if (r.operation === 'model') { model = r.model; return { updated:true }; }
      if (r.operation === 'agent') { agent = r.agent; return { updated:true }; }
      if (r.operation === 'send') {
        messages = [{ id: r.messageID, type: 'user', text: r.text, created: 1000 }, { id: 'msg_reply', type: 'assistant', text: '<img src=x onerror=alert(1)> 已读取页面', created: 1100 }, { id: 'msg_idle', type: 'idle', created: 1200 }];
        return { accepted: true, messageID: r.messageID, acceptedAt: 1000 };
      }
      return {};
    } },
  };
  if(streaming) w.chrome.runtime.connect=()=>{
    const incoming=[], disconnected=[];
    const port={onMessage:{addListener:fn=>incoming.push(fn)},onDisconnect:{addListener:fn=>disconnected.push(fn)},postMessage(){queueMicrotask(()=>incoming.forEach(fn=>fn({type:'stream_ready',sessionID:'ses_demo'})));},disconnect(){disconnected.forEach(fn=>fn());},emit:value=>incoming.forEach(fn=>fn(value))};
    ports.push(port); return port;
  };
  w.renderMarkdown = renderMarkdown; w.applyStreamEvent = applyStreamEvent; w.mergeStreaming = mergeStreaming;
  w.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); };
  w.eval(script);
  await new Promise(setImmediate);
  return { w, calls, setForms:value=>{forms=value;}, $: selector => w.document.querySelector(selector), settle: () => new Promise(setImmediate), feed(event){if(event.kind==='busy')serverBusy=true;if(event.terminal)serverBusy=false;ports.at(-1).emit({type:'event',event:{sessionID:'ses_demo',...event}});}, close() { w.dispatchEvent(new w.Event('unload')); w.close(); } };
}
test('suggestions only fill the composer; submitting creates a session and sends once', async () => {
  const p = await panel();
  try {
    p.$('.suggestions button').click();
    assert.equal(p.$('#prompt').value, '读取当前页面结构');
    assert.equal(p.calls.some(call => call.request?.operation === 'send'), false);
    p.$('#composer').dispatchEvent(new p.w.Event('submit', { cancelable: true }));
    p.$('#composer').dispatchEvent(new p.w.Event('submit', { cancelable: true }));
    await p.settle();
    const sends = p.calls.filter(call => call.request?.operation === 'send');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].request.tab.tabId, 9);
    assert.equal(p.$('#conversation').textContent.includes('已读取页面'), true);
    assert.equal(p.$('#conversation img'), null, 'Assistant output must be rendered as text, not executable HTML');
  } finally { p.close(); }
});
test('mode switches are removed; controls live in the menu and takeover can be resumed', async () => {
  const p = await panel();
  try {
    p.$('#history-toggle').click(); await p.settle();
    assert.equal(p.$('#history').hidden, false);
    assert.equal(p.$('#session-list script'), null);
    assert.equal(p.$('#control-tab'), null);
    assert.equal(p.$('#chat-tab'), null);
    p.$('#menu-toggle').click(); await p.settle();
    assert.equal(p.$('#control-menu').hidden, false);
    assert.equal(p.$('#chat-view').hidden, false);
    p.$('#takeover').click(); await p.settle();
    assert.equal(p.$('#resume').hidden, false);
    p.$('#resume').click(); await p.settle();
    assert.equal(p.$('#resume').hidden, true);
  } finally { p.close(); }
});

test('model selection is catalog-backed and sent when creating a new session', async () => {
  const p = await panel();
  try {
    p.$('#model-button').click(); await p.settle();
    const options = [...p.w.document.querySelectorAll('.model-option')];
    options.find(option => option.textContent.includes('模型 B')).click(); await p.settle();
    assert.equal(p.$('#model-label').textContent, '模型 B');
    p.$('#prompt').value = '你好'; p.$('#composer').dispatchEvent(new p.w.Event('submit', { cancelable:true })); await p.settle();
    const create = p.calls.find(call => call.request?.operation === 'create');
    assert.equal(create.request.model.id, 'model-b');
    assert.equal(p.$('#model-label').textContent, '模型 B');
  } finally { p.close(); }
});
test('existing session changes model, variant and agent through real API operations', async () => {
  const p = await panel();
  try {
    p.$('#history-toggle').click(); await p.settle(); p.$('.session-item').click(); await p.settle();
    p.$('#model-button').click(); await p.settle();
    [...p.w.document.querySelectorAll('.model-option')].find(option => option.textContent.includes('模型 B')).click(); await p.settle();
    assert.equal(p.calls.find(call => call.request?.operation === 'model').request.model.id, 'model-b');
    p.$('#variant-select').value = 'high'; p.$('#variant-select').dispatchEvent(new p.w.Event('change')); await p.settle();
    assert.equal(p.calls.filter(call => call.request?.operation === 'model').at(-1).request.model.variant, 'high');
    p.$('#agent-select').value = 'plan'; p.$('#agent-select').dispatchEvent(new p.w.Event('change')); await p.settle();
    assert.equal(p.calls.find(call => call.request?.operation === 'agent').request.agent, 'plan');
  } finally { p.close(); }
});
test('native live events render incremental Markdown and tool status without mode switches',async()=>{
  const p=await panel({streaming:true});
  try{
    p.$('#history-toggle').click();await p.settle();p.$('.session-item').click();await p.settle();
    p.feed({kind:'busy',busy:true,eventID:'busy'});
    p.feed({kind:'text_start',messageID:'msg_live',ordinal:0,created:10,eventID:'start'});
    p.feed({kind:'text_delta',messageID:'msg_live',ordinal:0,delta:'# 流式标题\n\n正在',created:11,eventID:'delta1'});
    await new Promise(resolve=>setTimeout(resolve,70));
    assert.equal(p.$('#conversation h1').textContent,'流式标题');
    assert.equal(p.$('#conversation').textContent.includes('正在'),true);
    p.feed({kind:'text_delta',messageID:'msg_live',ordinal:0,delta:'输出',created:12,eventID:'delta2'});
    p.feed({kind:'tool',messageID:'msg_live',id:'tool_1',name:'inspect',status:'running',created:13,eventID:'tool1'});
    await new Promise(resolve=>setTimeout(resolve,70));
    assert.equal(p.$('#conversation').textContent.includes('正在输出'),true);
    assert.equal(p.$('.tool-status').textContent,'运行中');
    assert.equal(p.$('#model-button').disabled,false, 'Model selection remains available for subsequent turns');
    p.feed({kind:'tool',messageID:'msg_live',id:'tool_1',status:'completed',created:14,eventID:'tool2'});
    await new Promise(resolve=>setTimeout(resolve,70));
    assert.equal(p.$('.tool-status').textContent,'已完成');
    assert.equal(p.$('#stream-label').textContent,'实时连接');
  }finally{p.close();}
});
test('pending questions can be answered in the sidebar without desktop handoff',async()=>{
  const p=await panel();
  try{
    p.$('#history-toggle').click();await p.settle();p.$('.session-item').click();await p.settle();
    p.setForms([{id:'frm_choice',title:'选择方案',requiresDesktop:false,fields:[{key:'choice',type:'string',required:true,options:[{value:'a',label:'方案 A'}]}]}]);
    p.$('#refresh-session').click();await p.settle();
    assert.equal(p.$('#forms').hidden,false);
    p.$('#forms select').value='a';p.$('.question-form').dispatchEvent(new p.w.Event('submit',{cancelable:true}));await p.settle();
    assert.equal(p.calls.find(call=>call.request?.operation==='form_reply').request.answer.choice,'a');
    assert.equal(p.$('#forms').hidden,true);
  }finally{p.close();}
});
test('typed steering instructions can be sent during an active streamed task',async()=>{
  const p=await panel({streaming:true});
  try{
    p.$('#history-toggle').click();await p.settle();p.$('.session-item').click();await p.settle();
    p.feed({kind:'busy',busy:true,eventID:'busy-steer'});
    p.$('#prompt').value='只读取，不要提交';p.$('#prompt').dispatchEvent(new p.w.Event('input'));
    assert.equal(p.$('#send').hidden,false);assert.equal(p.$('#interrupt').hidden,false);
    p.$('#composer').dispatchEvent(new p.w.Event('submit',{cancelable:true}));await p.settle();
    assert.equal(p.calls.filter(call=>call.request?.operation==='send').length,1);
  }finally{p.close();}
});
