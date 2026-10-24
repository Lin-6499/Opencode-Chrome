import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';
import { requestBridge } from '../bridge-client.mjs';

test('MCP lists tools, forwards reads, and invalidates operations on takeover', { timeout: 15000 }, async () => {
  const port = 17981;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../server.mjs', import.meta.url))],
    env: { ...process.env, CHROME_CONTROL_PORT: String(port) },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'integration-test', version: '1.0' });
  const second = new Client({ name: 'second-location-test', version: '1.0' });
  let secondConnected = false;
  let ws;
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['begin_task', 'click', 'end_task', 'get_status', 'highlight', 'inspect', 'list_tabs', 'release', 'scroll', 'select_tab', 'type_text', 'wait_for']);
    const token = (await readFile(new URL('../.connection-token', import.meta.url), 'utf8')).trim();
    const outdated = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `chrome-extension://${'a'.repeat(32)}` });
    await new Promise((resolve, reject) => {
      outdated.once('open', () => outdated.send(JSON.stringify({ type: 'hello', token })));
      outdated.once('close', code => { assert.equal(code, 1008); resolve(); });
      outdated.once('error', reject);
    });
    ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `chrome-extension://${'a'.repeat(32)}` });
    await new Promise((resolve, reject) => {
      ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', token, protocol: 4 })));
      ws.once('message', raw => { assert.equal(JSON.parse(raw).type, 'ready'); resolve(); });
      ws.once('error', reject);
    });
    const owners = [];
    let held;
    ws.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.owner) owners.push(message.owner);
      if (message.type === 'cleanup_owner') ws.send(JSON.stringify({ type: 'owner_cleaned', id: message.id, owner: message.owner, matched: true, cleaned: true }));
      if (message.method === 'inspect' && message.args.tabId === 1) {held=message.id;return;}
      if (message.method === 'inspect' && message.args.tabId === 2) {
        ws.send(JSON.stringify({id:message.id,result:{title:'Second'}}));
        if(held)ws.send(JSON.stringify({id:held,result:{title:'First'}}));
        return;
      }
      if (message.method === 'inspect') ws.send(JSON.stringify({ id: message.id, result: { title: 'Demo', headings: ['Hello'] } }));
      if (message.method === 'click') ws.send(JSON.stringify({ type: 'takeover' }));
      if (message.method === 'list_tabs') ws.send(JSON.stringify({ id: message.id, result: [{ tabId: 7, title: 'Demo', url: 'https://example.com/' }] }));
      if (message.method === 'begin_task' || message.method === 'end_task') ws.send(JSON.stringify({ id: message.id, result: { method: message.method, summary: message.args.summary } }));
    });
    const result = await client.callTool({ name: 'inspect', arguments: {}, _meta: { 'ai.opencode/sessionID': 'ses_test' } });
    assert.equal(JSON.parse(result.content[0].text).title, 'Demo');
    assert.equal(owners.includes('session:ses_test'), true);
    const cleanup = await requestBridge('cleanup_owner', { endedAt: Date.now() }, 'session:ses_test', { port });
    assert.equal(cleanup.cleaned, true);
    await second.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../server.mjs', import.meta.url))],
      env: { ...process.env, CHROME_CONTROL_PORT: String(port) },
      stderr: 'pipe',
    }));
    secondConnected = true;
    const parallel=await Promise.all([client.callTool({name:'inspect',arguments:{tabId:1}}),second.callTool({name:'inspect',arguments:{tabId:2}})]);
    assert.equal(JSON.parse(parallel[0].content[0].text).title,'First');
    assert.equal(JSON.parse(parallel[1].content[0].text).title,'Second');
    const shared = await second.callTool({ name: 'inspect', arguments: {} });
    assert.equal(JSON.parse(shared.content[0].text).title, 'Demo');
    const sharedTabs = await second.callTool({ name: 'list_tabs', arguments: {} });
    assert.equal(JSON.parse(sharedTabs.content[0].text)[0].tabId, 7);
    const started = await second.callTool({ name: 'begin_task', arguments: { summary: '读取结构并高亮标题', tabId: 7 } });
    assert.equal(JSON.parse(started.content[0].text).summary, '读取结构并高亮标题');
    const ended = await second.callTool({ name: 'end_task', arguments: {} });
    assert.equal(JSON.parse(ended.content[0].text).method, 'end_task');
    await second.close();
    secondConnected = false;
    const stillConnected = await client.callTool({ name: 'inspect', arguments: {} });
    assert.equal(JSON.parse(stillConnected.content[0].text).title, 'Demo');
    const stopped = await client.callTool({ name: 'click', arguments: { selector: '#button' } });
    assert.equal(stopped.isError, true);
    assert.match(stopped.content[0].text, /took over/);
  } finally {
    if (secondConnected) await second.close();
    ws?.close();
    await client.close();
  }
});
