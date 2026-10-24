const status = document.querySelector('#status');
const connectButton = document.querySelector('#connect');
status.textContent = '正在自动配对本机…';
chrome.runtime.sendMessage({ type: 'pair' }).then(result => {
  if (result.error) { status.textContent = result.error; return; }
  status.textContent = result.paused ? '已停止 · 点击“恢复自动控制”后才允许新任务' : result.connected ? '已自动配对 · 正在控制已选标签页' : '已自动配对 · 就绪，工具调用时自动连接网页';
  connectButton.hidden = !result.paused;
}).catch(error => { status.textContent = error.message; });
document.querySelector('#connect').onclick = async () => {
  status.textContent = '正在恢复…';
  connectButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'resume' });
    status.textContent = result.error || '已恢复 · 下一次工具调用将自动选择网页';
    if (!result.error) connectButton.hidden = true;
  } catch (error) { status.textContent = error.message; }
  finally { connectButton.disabled = false; }
};
document.querySelector('#stop').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'stop' });
  status.textContent = '已停止。点击“恢复自动控制”才允许新任务。';
  connectButton.hidden = false;
};
