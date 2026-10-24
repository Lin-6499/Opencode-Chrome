import test from 'node:test';
import assert from 'node:assert/strict';
import { projectEvent, watchSession } from '../native-stream.mjs';
import { chatDirectory } from '../native-api.mjs';
import { applyStreamEvent, mergeStreaming } from '../ui/stream-state.mjs';

const event=(type,data,id='evt_1')=>({type,id,created:100,data:{sessionID:'ses_test',assistantMessageID:'msg_a',...data}});
test('live projection forwards text/tool status but not reasoning, arguments or tool output',()=>{
  assert.equal(projectEvent(event('session.reasoning.delta',{delta:'SECRET'}),'ses_test'),null);
  assert.equal(projectEvent(event('session.tool.input.delta',{delta:'SECRET'}),'ses_test'),null);
  const shown=projectEvent(event('session.tool.success',{id:'call_1',content:[{text:'SECRET'}],native:{key:'SECRET'}}),'ses_test');
  assert.equal(shown.status,'completed'); assert.equal(JSON.stringify(shown).includes('SECRET'),false);
  assert.equal(projectEvent(event('session.text.delta',{delta:'你好',ordinal:0}),'ses_other'),null);
});
test('watch validates project scope before subscribing and emits native ready/data frames',async()=>{
  const output=[];
  const connection={api:async()=>({data:{location:{directory:chatDirectory}}}),client:{event:{async *subscribe(){yield {type:'server.connected'};yield event('session.text.delta',{delta:'你好',ordinal:0});yield event('session.execution.succeeded',{});}}}};
  await watchSession('ses_test',async value=>output.push(value),new AbortController().signal,connection);
  assert.equal(output[0].type,'stream_ready'); assert.equal(output[1].event.delta,'你好'); assert.equal(output[2].event.terminal,true);
  connection.api=async()=>({data:{location:{directory:'C:\\OtherProject'}}});
  await assert.rejects(watchSession('ses_test',async()=>{},new AbortController().signal,connection),/其他项目/);
});
test('canonical refresh and streaming prefixes do not duplicate text',()=>{
  const records=new Map(); const baseline=[{id:'msg_a',type:'assistant',created:1,text:'Hello',tools:[]}];
  applyStreamEvent(records,{kind:'text_start',messageID:'msg_a',ordinal:1,created:2},baseline);
  applyStreamEvent(records,{kind:'text_delta',messageID:'msg_a',ordinal:1,delta:'World',created:3},baseline);
  const combined=mergeStreaming(baseline,records);
  assert.equal(combined[0].text,'Hello\nWorld');
  assert.equal(mergeStreaming(combined,records)[0].text,'Hello\nWorld');
});
test('joining mid-response requests canonical refresh rather than guessing a missing prefix',()=>{
  const records=new Map(); const baseline=[{id:'msg_a',type:'assistant',text:'Existing prefix',created:1}];
  assert.equal(applyStreamEvent(records,{kind:'text_delta',messageID:'msg_a',ordinal:0,delta:'tail'},baseline),false);
  assert.equal(mergeStreaming(baseline,records)[0].text,'Existing prefix');
});
