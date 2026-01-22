(function(){
  const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
  let ws = null;
  let name = null;
  let aiController = null; // track in-flight AI request to cancel when typing
  let lastAiText = '';
  let lastAiSuggestions = [];

  const el = id => document.getElementById(id);

  // --- Messages rendering ---
  function renderMessage(m){
    const container = document.createElement('div');
    container.className = 'message';
    if(m.name === name){
      container.classList.add('mine');
    }
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
  // localSuggestions disabled: rely solely on AI
  function localSuggestions(){ return []; }

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

  function renderPanelSuggestionsWithSource(suggestions){
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
      item.textContent = s.text;
      item.tabIndex = 0;
      item.title = s.source === 'ai' ? '来自AI的建议' : ''; // tooltip for AI suggestions
      item.addEventListener('click', ()=>{
        const input = el('msgInput');
        input.value = s.text;
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
    // local suggestions disabled; rely on AI below
  }, 250);

  const debouncedAi = debounce(function(text){
    requestAiSuggestions(text);
  }, 500); // faster refresh

  // --- Insights UI ---
  function renderInsights(analyses){
    const list = el('insightsList');
    const status = el('insightsStatus');
    if(!list) return;
    list.innerHTML = '';
    if(!analyses || !analyses.length){
      if(status) status.textContent = 'No recent messages to analyze.';
      return;
    }
    analyses.forEach(item => {
      const card = document.createElement('div');
      card.className = 'insight-card';
      const user = document.createElement('div');
      user.className = 'insight-user';
      user.textContent = item.user || 'Unknown';
      const badge = document.createElement('span');
      badge.className = 'insight-badge';
      badge.textContent = item.emotion || 'neutral';
      user.appendChild(badge);

      const inf = document.createElement('div');
      inf.className = 'insight-text';
      inf.textContent = item.inference || '';

      const reply = document.createElement('div');
      reply.className = 'insight-reply';
      reply.textContent = item.suggested_reply || '';

      card.appendChild(user);
      card.appendChild(inf);
      card.appendChild(reply);
      list.appendChild(card);
    });
    if(status) status.textContent = 'Insights refreshed.';
  }

  function fetchInsights(){
    const panel = el('insightsPanel');
    const status = el('insightsStatus');
    if(panel){ panel.classList.remove('hidden'); panel.setAttribute('aria-hidden','false'); }
    if(status) status.textContent = 'Analyzing...';
    fetch('/analyze_users', {method:'POST'}).then(r => {
      if(!r.ok) throw new Error('bad response '+r.status);
      return r.json();
    }).then(data => {
      renderInsights((data || {}).analyses || []);
    }).catch(err => {
      console.debug('insights fetch failed', err);
      if(status) status.textContent = 'AI request failed, please retry.';
    });
  }

  function requestAiSuggestions(text){
    const loadingEl = el('suggestLoading');
    const aiBtn = el('suggestAiBtn');
    const list = el('suggestList');
    if(!text || !text.trim()) return;
    const trimmed = text.trim();
    // if we already have suggestions for the same input, reuse to avoid flicker
    if(lastAiSuggestions.length && trimmed === lastAiText){
      renderPanelSuggestionsWithSource(lastAiSuggestions);
      return;
    }
    console.debug('[requestAiSuggestions] text=', text);
    if(aiBtn) { aiBtn.disabled = true; }
    if(loadingEl){ loadingEl.style.display='inline'; loadingEl.setAttribute('aria-hidden','false'); }
    // show panel and a pending placeholder so user sees progress
    const panel = el('suggestPanel');
    if(panel){ panel.classList.remove('collapsed'); panel.setAttribute('aria-hidden','false'); }
    if(list){
      const pendingId = 'suggest-pending';
      const existing = list.querySelector('#' + pendingId);
      if(existing) existing.remove();
      const pending = document.createElement('div');
      pending.id = pendingId;
      pending.className = 'suggest-empty';
      pending.textContent = 'Generating suggestions...';
      pending.style.padding = '8px';
      pending.style.color = '#555';
      list.prepend(pending);
    }

    // cancel previous request if still pending
    if(aiController){ aiController.abort(); }
    aiController = new AbortController();
    const controller = aiController;
    const timeout = setTimeout(()=> controller.abort(), 8000);

    const clearEmpty = ()=>{
      const ex = list && list.querySelector('.suggest-empty');
      if(ex) ex.remove();
    };
    clearEmpty();

    fetch('/autocomplete_ai', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text}), signal: controller.signal})
      .then(r => {
        if(!r.ok) throw new Error('bad response ' + r.status);
        return r.json();
      })
      .then(j => {
        console.debug('[requestAiSuggestions] response', j);
        const ai = (j.suggestions||[]).map(s=>({text:s, source:'ai'}));
        if(ai.length){
          lastAiText = trimmed;
          lastAiSuggestions = ai;
          const seen = new Set();
          const combined = [];
          ai.forEach(obj => { if(obj && obj.text && !seen.has(obj.text)){ combined.push(obj); seen.add(obj.text);} });
          renderPanelSuggestionsWithSource(combined);
        } else {
          lastAiSuggestions = [];
          // show a small placeholder indicating no AI suggestions
          if(list){
            clearEmpty();
            const empty = document.createElement('div');
            empty.className = 'suggest-empty';
            empty.textContent = 'No AI suggestions returned.';
            empty.style.padding = '8px';
            empty.style.color = '#666';
            list.appendChild(empty);
            // expand panel so user can see message
            const panel = el('suggestPanel'); if(panel){ panel.classList.remove('collapsed'); panel.setAttribute('aria-hidden','false'); }
          }
        }
      })
      .catch(err => {
        console.debug('AI suggestions fetch failed:', err);
        // silence UI errors; keep panel state unchanged
      })
      .finally(()=>{
        clearTimeout(timeout);
        if(loadingEl){ loadingEl.style.display='none'; loadingEl.setAttribute('aria-hidden','true'); }
        if(aiBtn) { aiBtn.disabled = false; }
        if(list){
          const pending = list.querySelector('#suggest-pending');
          if(pending) pending.remove();
        }
        if(controller === aiController){ aiController = null; }
      });
  }

  // --- WebSocket and main logic ---
  function updateUsersList(names){
    const list = el('usersList'); if(!list) return; list.innerHTML = ''; names.forEach(n => { const li = document.createElement('li'); li.textContent = n + (n === name ? ' (me)' : ''); list.appendChild(li); });
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
    const suggestAiBtn = el('suggestAiBtn');
    const insightsBtn = el('insightsBtn');
    const insightsClose = el('insightsClose');
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
          // trigger AI refresh when reopening
          const txt = input ? input.value : '';
          if(lastAiSuggestions.length && txt.trim() === lastAiText){
            renderPanelSuggestionsWithSource(lastAiSuggestions);
          } else {
            debouncedAi(txt);
          }
        }
      });
    }
    if(suggestAiBtn){
      suggestAiBtn.addEventListener('click', ()=>{
        const text = input ? input.value : '';
        requestAiSuggestions(text);
      });
    }

    if(insightsBtn){
      insightsBtn.addEventListener('click', ()=>{
        fetchInsights();
      });
    }
    if(insightsClose){
      insightsClose.addEventListener('click', ()=>{
        const panel = el('insightsPanel');
        if(panel){ panel.classList.add('hidden'); panel.setAttribute('aria-hidden','true'); }
      });
    }

    if(input){
      input.addEventListener('input', ()=> { debouncedLocal(input); debouncedAi(input.value); });
      input.addEventListener('keydown', e=>{ if(e.key === 'Escape'){ if(panel){ panel.classList.add('collapsed'); panel.setAttribute('aria-hidden','true'); panelToggle.setAttribute('aria-expanded','false'); panelToggle.textContent = '▼'; } } });
      // click outside collapses panel
      document.addEventListener('click', (ev)=>{
        const panel = el('suggestPanel'); if(!panel) return; const target = ev.target;
        const showBtn = el('suggestShowBtn');
        const aiBtn = el('suggestAiBtn');
        if(target === input) return;
        if(panel.contains(target)) return;
        if(target === showBtn || target === aiBtn) return; // do not collapse when clicking show/AI buttons
        panel.classList.add('collapsed');
        panel.setAttribute('aria-hidden','true');
        const t = el('suggestToggle'); if(t) { t.setAttribute('aria-expanded','false'); t.textContent='▼' }
      });
    }

    el('msgForm').addEventListener('submit', e=>{ e.preventDefault(); const text = el('msgInput').value.trim(); if(!text) return; if(ws && ws.readyState===WebSocket.OPEN){ ws.send(JSON.stringify({type:'message', text})); el('msgInput').value=''; const panel = el('suggestPanel'); if(panel) { panel.classList.add('collapsed'); panel.setAttribute('aria-hidden','true'); const t = el('suggestToggle'); if(t){ t.setAttribute('aria-expanded','false'); t.textContent='▼' } } } else { alert('尚未连接到服务器'); } });
  }

  window.addEventListener('load', init);
})();
