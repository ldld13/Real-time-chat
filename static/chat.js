(function(){
  const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
  let ws = null;
  let name = null;

  const el = id => document.getElementById(id);

  function renderMessage(m){
    const container = document.createElement('div');
    container.className = 'message';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const d = new Date(m.time);
    meta.textContent = `${m.name} · ${d.toLocaleTimeString()}`;
    const body = document.createElement('div');
    body.textContent = m.text;
    container.appendChild(meta);
    container.appendChild(body);
    el('messages').appendChild(container);
    el('messages').scrollTop = el('messages').scrollHeight;
  }

  function updateUsersList(names){
    const list = el('usersList');
    list.innerHTML = '';
    names.forEach(n => {
      const li = document.createElement('li');
      li.textContent = n + (n === name ? ' (我)' : '');
      list.appendChild(li);
    });
  }

  function connectWs(){
    ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({type:'join', name}));
    });
    ws.addEventListener('message', ev => {
      let payload;
      try{ payload = JSON.parse(ev.data); }catch(e){return}
      if(payload.type === 'history'){
        el('messages').innerHTML = '';
        (payload.messages || []).forEach(renderMessage);
      }else if(payload.type === 'message'){
        renderMessage(payload);
      }else if(payload.type === 'users'){
        updateUsersList(payload.names || []);
      }else if(payload.type === 'error'){
        alert('服务器错误: ' + (payload.message || ''));
      }
    });
    ws.addEventListener('close', () => {
      setTimeout(() => { if(name) connectWs(); }, 1000);
    });
  }

  function init(){
    name = sessionStorage.getItem('chat_name');
    if(!name){
      // not logged in, go back to login
      location.href = '/';
      return;
    }

    // populate my name
    const myNameEl = el('myName');
    if(myNameEl) myNameEl.textContent = name;

    const logoutBtn = el('logoutBtn');
    if(logoutBtn){
      logoutBtn.addEventListener('click', ()=>{
        sessionStorage.removeItem('chat_name');
        try{ if(ws) ws.close(); }catch(e){}
        location.href = '/';
      });
    }

    connectWs();

    el('msgForm').addEventListener('submit', e => {
      e.preventDefault();
      const text = el('msgInput').value.trim();
      if(!text) return;
      if(ws && ws.readyState === WebSocket.OPEN){
        ws.send(JSON.stringify({type:'message', text}));
        el('msgInput').value = '';
      } else {
        alert('尚未连接到服务器');
      }
    });
  }

  window.addEventListener('load', init);
})();
