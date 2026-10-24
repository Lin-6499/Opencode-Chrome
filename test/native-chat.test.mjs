import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChat, presentMessages, chatDirectory } from '../native-chat.mjs';

function fixture() {
  const calls = [];
  let busy = true;
  const models = [
    { id:'model-a', providerID:'test', name:'Model A', enabled:true, variants:[{id:'low'},{id:'high',headers:{authorization:'SECRET'}}], headers:{authorization:'SECRET'}, settings:{apiKey:'SECRET'} },
    { id:'model-b', providerID:'test', name:'Model B', enabled:true, variants:[{id:'fast'}] },
    { id:'hidden-model', providerID:'test', name:'Hidden', enabled:false, variants:[] },
  ];
  const session = { id: 'ses_test', title: '测试会话', location: { directory: chatDirectory }, time: { updated: 100 } };
  const permissions = [{ id: 'per_test', action: 'shell', resources: ['example'] }];
  const api = async (method, route, body) => {
    calls.push({ method, route, body });
    if (route.startsWith('/api/model/default?')) return {data:models[0]};
    if (route.startsWith('/api/model?')) return {data:models};
    if (route.startsWith('/api/agent?')) return {data:[{id:'build',name:'Build',mode:'primary',hidden:false},{id:'plan',name:'Plan',mode:'primary',hidden:false},{id:'internal',name:'Internal',mode:'subagent',hidden:true}]};
    if (route.startsWith('/api/session?')) return { data: [session] };
    if (route === '/api/session') return { data: session };
    if (route === '/api/session/active') return { data: busy ? { ses_test: { type: 'running' } } : {} };
    if (route === '/api/session/ses_test') { if(method==='PATCH') Object.assign(session,body); return { data: session }; }
    if (route.endsWith('/model')) { session.model=body.model; return {}; }
    if (route.endsWith('/agent')) { session.agent=body.agent; return {}; }
    if (route.includes('/message?')) return { data: [{ id: 'msg_a', type: 'assistant', content: [{ type: 'text', text: '你好' }], time: { created: 200 } }, { id: 'msg_u', type: 'user', text: '原始上下文', metadata: { chromeControlUserText: '帮我读取网页' }, time: { created: 100 } }] };
    if (route.endsWith('/permission')) return { data: permissions };
    if (route.endsWith('/form')) return {data:[]};
    if (route.endsWith('/prompt')) return { data: { id: body.id, time: { created: 123 } } };
    if (route.includes('/interrupt')) return { interrupted: true };
    if (route.endsWith('/reply')) return {};
    throw new Error(`Unexpected route: ${route}`);
  };
  return { calls, session, api, setBusy:value=>{busy=value;} };
}
test('native chat lists and creates real API sessions scoped to the project', async () => {
  const f = fixture();
  assert.equal((await handleChat({ operation: 'list' }, f.api)).sessions[0].id, 'ses_test');
  assert.equal((await handleChat({ operation: 'create', title: '新建测试' }, f.api)).session.id, 'ses_test');
  assert.equal(f.calls.at(-1).body.location.directory, chatDirectory);
});
test('sending preserves a stable message ID and strips URL credentials and query secrets', async () => {
  const f = fixture();
  const result = await handleChat({ operation: 'send', sessionID: 'ses_test', messageID: 'msg_once', text: '读取网页', tab: { tabId: 9, title: '测试页面', url: 'https://user:password@example.com/settings?token=secret#fragment' } }, f.api);
  assert.equal(result.accepted, true);
  assert.equal(result.messageID, 'msg_once');
  const body = f.calls.at(-1).body;
  assert.equal(body.id, 'msg_once');
  assert.equal(body.text.includes('https://example.com/settings'), true);
  assert.equal(body.text.includes('secret'), false);
  assert.equal(body.text.includes('password'), false);
  assert.equal(body.metadata.chromeControlUserText, '读取网页');
});
test('session reads expose text/tool names, not reasoning or raw tool inputs and outputs', async () => {
  const f = fixture();
  const read = await handleChat({ operation: 'read', sessionID: 'ses_test' }, f.api);
  assert.equal(read.busy, true);
  assert.equal(read.messages[0].text, '帮我读取网页');
  const shown = presentMessages([{ id: 'msg_a', type: 'assistant', time: { created: 1 }, content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: '公开回复' }, { type: 'tool', name: 'inspect', state: { status: 'completed', input: 'secret-input', output: 'secret-output' } }] }]);
  assert.equal(JSON.stringify(shown).includes('secret'), false);
  assert.equal(JSON.stringify(shown).includes('private'), false);
  assert.equal(shown[0].text, '公开回复');
});
test('only an existing request may be explicitly allowed once or rejected', async () => {
  const f = fixture();
  await handleChat({ operation: 'permission', sessionID: 'ses_test', permissionID: 'per_test', reply: 'once' }, f.api);
  assert.deepEqual(f.calls.at(-1).body, { decision: 'once' });
  await assert.rejects(handleChat({ operation: 'permission', sessionID: 'ses_test', permissionID: 'per_test', reply: 'always' }, f.api));
  await assert.rejects(handleChat({ operation: 'permission', sessionID: 'ses_test', permissionID: 'per_missing', reply: 'once' }, f.api));
});
test('arbitrary operations, path traversal, and sessions in other directories are rejected', async () => {
  const f = fixture();
  await assert.rejects(handleChat({ operation: 'exec', command: 'anything' }, f.api));
  await assert.rejects(handleChat({ operation: 'read', sessionID: '../../config' }, f.api));
  f.session.location.directory = 'C:\\OtherProject';
  await assert.rejects(handleChat({ operation: 'interrupt', sessionID: 'ses_test' }, f.api), /不属于/);
});
test('model catalog strips credentials, hides disabled models and hidden agents', async () => {
  const f=fixture();
  const result=await handleChat({operation:'catalog'},f.api);
  assert.equal(result.models.length,2);
  assert.deepEqual(result.models[0].variants,['low','high']);
  assert.deepEqual(result.agents.map(agent=>agent.id),['build','plan']);
  assert.equal(JSON.stringify(result).includes('SECRET'),false);
});
test('session model, variant and agent changes are validated and never rewrite defaults', async () => {
  const f=fixture(); f.setBusy(false);
  await handleChat({operation:'model',sessionID:'ses_test',model:{providerID:'test',id:'model-a',variant:'high'}},f.api);
  assert.equal(f.session.model.variant,'high');
  await handleChat({operation:'agent',sessionID:'ses_test',agent:'plan'},f.api);
  assert.equal(f.session.agent,'plan');
  await assert.rejects(handleChat({operation:'model',sessionID:'ses_test',model:{providerID:'test',id:'hidden-model'}},f.api),/不可用/);
  await assert.rejects(handleChat({operation:'model',sessionID:'ses_test',model:{providerID:'test',id:'model-a',variant:'unknown'}},f.api),/不可用/);
  await assert.rejects(handleChat({operation:'agent',sessionID:'ses_test',agent:'internal'},f.api),/不可用/);
  assert.equal(f.calls.some(call=>call.route.includes('/config')),false);
});
test('model changes apply to subsequent turns; archiving a busy task is refused', async () => {
  const f=fixture();
  await handleChat({operation:'model',sessionID:'ses_test',model:{providerID:'test',id:'model-a'}},f.api);
  assert.equal(f.session.model.id,'model-a');
  await assert.rejects(handleChat({operation:'archive',sessionID:'ses_test'},f.api),/执行/);
  f.setBusy(false);
  await handleChat({operation:'rename',sessionID:'ses_test',title:'新的会话名称'},f.api);
  assert.equal(f.session.title,'新的会话名称');
  await handleChat({operation:'archive',sessionID:'ses_test'},f.api);
  assert.equal(f.session.archived,true);
  assert.equal(f.calls.some(call=>call.method==='DELETE'),false);
});
