(function(){
  const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
  let ws = null;
  let name = null;

  const el = id => document.getElementById(id);

  // --- Messages rendering ---
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

  // --- suggestion panel logic (render into #suggestList) ---
  const canned = [
    '您好，请问可以提供订单号或购买时间吗？',
    '您好，很抱歉给您带来不便，请问是要退货还是换货？',
    '如果商品存在质量问题，我们可以为您办理退换货，是否需要申请运费补偿？',
    '已为您查询到订单信息，请问需要我为您提交退货申请吗？',
    '请您确认收货地址以及联系电话是否有误，以便安排取件。',
    '您的退款会在7个工作日内原路退回，请耐心等待。',
    '可否请您上传一下商品照片或问题截图？'
  ];

  function localSuggestions(text){
    if(!text || !text.trim()) return [canned[0], canned[6]];
    const t = text.toLowerCase();
    if(t.includes('退') || t.includes('退款') || t.includes('退货')) return [canned[1], canned[3], canned[5]];
    if(t.includes('换') || t.includes('换货')) return [canned[1], canned[2], canned[3]];
    if(t.includes('快递') || t.includes('物流') || t.includes('发货')) return [canned[4], canned[3]];
    if(t.includes('质量') || t.includes('破损') || t.includes('坏')) return [canned[2], canned[6]];
    return [canned[0], canned[1], canned[6]];
  }

  function renderPanelSuggestions(suggestions){
    const panel = el('suggestPanel');
    const list = el('suggestList');
    if(!panel || !list) return;
    list.innerHTML = '';
    if(!suggestions || suggestions.length === 0){
      // collapse if empty
      panel.classList.add('collapsed');
      panel.setAttribute('aria-hidden','true');
      el('suggestToggle').setAttribute('aria-expanded','false');
      return;
    }
    // expand
    panel.classList.remove('collapsed');
    panel.setAttribute('aria-hidden','false');
    el('suggestToggle').setAttribute('aria-expanded','true');

    suggestions.forEach(s => {
      const item = document.createElement('div');
      item.className = 'suggest-item';
      item.textContent = s;
      item.tabIndex = 0;
      item.addEventListener('click', ()=>{
        const input = el('msgInput');
        input.value = s;
        input.focus();
        // keep panel open so user can edit or press send
      });
      list.appendChild(item);
    });
  }

  function debounce(fn, wait){
    let t = null; return function(...args){ clearTimeout(t); t = setTimeout(()=>fn.apply(this,args), wait); };
  }

  const debouncedLocal = debounce(function(inputEl){
    const text = inputEl.value;
    const suggestions = localSuggestions(text);
    renderPanelSuggestions(suggestions);

    // now fetch AI suggestions in background and merge
    const loadingEl = el('suggestLoading');
    if(!text || !text.trim()) return; // don't call AI for empty
    if(loadingEl) { loadingEl.style.display = 'inline'; loadingEl.setAttribute('aria-hidden','false'); }

    const controller = new AbortController();
    const timeout = setTimeout(()=> controller.abort(), 5000); // 5s timeout

    fetch('/autocomplete_ai', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text}), signal: controller.signal})
      .then(r=> r.ok ? r.json() : Promise.reject(new Error('bad response')))
      .then(j=>{
        const ai = j.suggestions || [];
        if(ai.length){
          // merge with existing panel suggestions, keep uniqueness
          const listEl = el('suggestList');
          const existing = Array.from(listEl.querySelectorAll('.suggest-item')).map(it=>it.textContent);
          const combined = existing.slice();
          ai.forEach(s=>{ if(s && !combined.includes(s)) combined.push(s); });
          // re-render
          renderPanelSuggestions(combined);
        }
      })
      .catch(err=>{
        console.debug('AI suggestions fetch failed:', err);
      })
      .finally(()=>{
        clearTimeout(timeout);
        if(loadingEl){ loadingEl.style.display='none'; loadingEl.setAttribute('aria-hidden','true'); }
      });

  }, 250);

  // --- WebSocket and main logic ---
  function updateUsersList(names){
    const list = el('usersList'); if(!list) return; list.innerHTML = ''; names.forEach(n => { const li = document.createElement('li'); li.textContent = n + (n === name ? ' (我)' : ''); list.appendChild(li); });
  }

  function connectWs(){
    ws = new WebSocket(wsUrl);
    ws.addEventListener('open', ()=>{ ws.send(JSON.stringify({type:'join', name})); });
    ws.addEventListener('message', ev=>{ let payload; try{ payload = JSON.parse(ev.data); }catch(e){return} if(payload.type==='history'){ el('messages').innerHTML=''; (payload.messages||[]).forEach(renderMessage); } else if(payload.type==='message'){ renderMessage(payload); } else if(payload.type==='users'){ updateUsersList(payload.names || []); } });
    ws.addEventListener('close', ()=>{ setTimeout(()=>{ if(name) connectWs(); }, 1000); });
  }

  function init(){
    name = sessionStorage.getItem('chat_name'); if(!name){ location.href='/'; return; }
    const myNameEl = el('myName'); if(myNameEl) myNameEl.textContent = name;
    const logoutBtn = el('logoutBtn'); if(logoutBtn) logoutBtn.addEventListener('click', ()=>{ sessionStorage.removeItem('chat_name'); try{ if(ws) ws.close(); }catch(e){}; location.href='/'; });

    connectWs();

    const input = el('msgInput');
    const panelToggle = el('suggestToggle');
    const panel = el('suggestPanel');
    const suggestShowBtn = el('suggestShowBtn');
    if(panelToggle && panel){
      panelToggle.addEventListener('click', ()=>{
        const isCollapsed = panel.classList.toggle('collapsed');
        panel.setAttribute('aria-hidden', isCollapsed ? 'true' : 'false');
        panelToggle.setAttribute('aria-expanded', (!isCollapsed).toString());
        panelToggle.textContent = isCollapsed ? '▼' : '▲';
        // update show button visibility
        if(suggestShowBtn) suggestShowBtn.setAttribute('aria-expanded', (!isCollapsed).toString());
      });
    }
    if(suggestShowBtn){
      suggestShowBtn.addEventListener('click', ()=>{
        if(panel.classList.contains('collapsed')){
          panel.classList.remove('collapsed');
          panel.setAttribute('aria-hidden','false');
          panelToggle.setAttribute('aria-expanded','true');
          panelToggle.textContent = '▲';
          suggestShowBtn.setAttribute('aria-expanded','true');
          // trigger suggestions immediately
          debouncedLocal(input);
        }
      });
    }

    if(input){
      input.addEventListener('input', ()=> debouncedLocal(input));
      input.addEventListener('keydown', e=>{ if(e.key === 'Escape'){ if(panel){ panel.classList.add('collapsed'); panel.setAttribute('aria-hidden','true'); panelToggle.setAttribute('aria-expanded','false'); panelToggle.textContent = '▼'; } } });
      // click outside collapses panel
      document.addEventListener('click', (ev)=>{ const panel = el('suggestPanel'); if(!panel) return; const target = ev.target; if(target === input) return; if(panel.contains(target)) return; panel.classList.add('collapsed'); panel.setAttribute('aria-hidden','true'); const t = el('suggestToggle'); if(t) { t.setAttribute('aria-expanded','false'); t.textContent='▼' } });
    }

    el('msgForm').addEventListener('submit', e=>{ e.preventDefault(); const text = el('msgInput').value.trim(); if(!text) return; if(ws && ws.readyState===WebSocket.OPEN){ ws.send(JSON.stringify({type:'message', text})); el('msgInput').value=''; const panel = el('suggestPanel'); if(panel) { panel.classList.add('collapsed'); panel.setAttribute('aria-hidden','true'); const t = el('suggestToggle'); if(t){ t.setAttribute('aria-expanded','false'); t.textContent='▼' } } } else { alert('尚未连接到服务器'); } });
  }

  window.addEventListener('load', init);
})();
