/* NEXORA AI — shared floating assistant */
(() => {
  if (window.__NEXORA_AI_LOADED__) return;
  window.__NEXORA_AI_LOADED__ = true;

  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = 'nexora-ai.css?v=1';
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'nexora-ai-root';
  root.innerHTML = `
    <button class="nxa-launcher" type="button" aria-label="Open NEXORA AI assistant" aria-expanded="false">
      <span class="nxa-launcher-orb"><span></span><span></span><span></span></span>
      <span class="nxa-launcher-label">Ask NEXORA AI</span>
      <span class="nxa-launcher-pulse"></span>
    </button>
    <section class="nxa-panel" role="dialog" aria-modal="false" aria-label="NEXORA AI assistant" hidden>
      <header class="nxa-header">
        <div class="nxa-brand">
          <div class="nxa-avatar"><span>✦</span><i></i></div>
          <div><strong>NEXORA AI</strong><small><span class="nxa-status-dot"></span> Your school assistant</small></div>
        </div>
        <div class="nxa-head-actions">
          <button class="nxa-icon-btn nxa-clear" type="button" aria-label="Clear conversation" title="New conversation">↻</button>
          <button class="nxa-icon-btn nxa-close" type="button" aria-label="Close assistant">×</button>
        </div>
      </header>
      <div class="nxa-welcome">
        <span class="nxa-eyebrow">YOUR INTELLIGENT SCHOOL COMPANION</span>
        <h2>What can I help you with?</h2>
        <p>Ask about learning, attendance, assignments, exams and school updates.</p>
      </div>
      <div class="nxa-messages" aria-live="polite" aria-relevant="additions"></div>
      <div class="nxa-suggestions">
        <button type="button">Show my attendance</button>
        <button type="button">What assignments are due?</button>
        <button type="button">Help me prepare for exams</button>
      </div>
      <form class="nxa-composer">
        <label class="nxa-sr-only" for="nxa-message">Message NEXORA AI</label>
        <textarea id="nxa-message" rows="1" maxlength="2000" placeholder="Message NEXORA AI…" required></textarea>
        <button class="nxa-send" type="submit" aria-label="Send message"><span>↑</span></button>
      </form>
      <div class="nxa-footnote">AI can make mistakes. Verify important school information.</div>
    </section>`;
  document.body.appendChild(root);

  const launcher = root.querySelector('.nxa-launcher');
  const panel = root.querySelector('.nxa-panel');
  const close = root.querySelector('.nxa-close');
  const clear = root.querySelector('.nxa-clear');
  const form = root.querySelector('.nxa-composer');
  const input = root.querySelector('textarea');
  const messages = root.querySelector('.nxa-messages');
  const suggestions = root.querySelector('.nxa-suggestions');
  const send = root.querySelector('.nxa-send');
  let busy = false;
  let conversation = [];

  function openPanel() {
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    launcher.classList.add('nxa-launcher-active');
    input.focus();
  }
  function closePanel() {
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    launcher.classList.remove('nxa-launcher-active');
  }
  function addMessage(text, who) {
    const item = document.createElement('div');
    item.className = 'nxa-message nxa-' + who;
    const bubble = document.createElement('div');
    bubble.className = 'nxa-bubble';
    bubble.textContent = text;
    item.appendChild(bubble);
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
    return item;
  }
  function setBusy(value) {
    busy = value;
    send.disabled = value;
    input.disabled = value;
    send.innerHTML = value ? '<span class="nxa-spinner"></span>' : '<span>↑</span>';
  }
  async function ask(question) {
    const message = String(question || '').trim();
    if (!message || busy) return;
    openPanel();
    suggestions.hidden = true;
    addMessage(message, 'user');
    conversation.push({ role: 'user', content: message });
    input.value = '';
    input.style.height = 'auto';
    setBusy(true);
    const typing = addMessage('NEXORA AI is thinking…', 'assistant nxa-typing');
    try {
      const client = typeof supabaseClient !== 'undefined' ? supabaseClient : null;
      if (!client?.auth || !client?.functions) {
        throw new Error('The secure school connection is not available on this page.');
      }
      const { data: sessionData, error: sessionError } = await client.auth.getSession();
      if (sessionError || !sessionData?.session) {
        throw new Error('Please sign in to your NEXORA account before using the AI assistant.');
      }
      const { data, error } = await client.functions.invoke('nexora-ai-chat', {
        body: { message }
      });
      if (error) throw new Error(data?.error || error.message || 'Could not reach NEXORA AI.');
      if (data?.error) throw new Error(data.error);
      if (!data?.reply) throw new Error('NEXORA AI did not return a response. Please try again.');
      typing.remove();
      addMessage(data.reply, 'assistant');
      conversation.push({ role: 'assistant', content: data.reply });
      if (conversation.length > 16) conversation = conversation.slice(-16);
    } catch (error) {
      typing.remove();
      addMessage(error?.message || 'Something went wrong. Please try again.', 'error');
      conversation.pop();
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  launcher.addEventListener('click', () => panel.hidden ? openPanel() : closePanel());
  close.addEventListener('click', closePanel);
  clear.addEventListener('click', () => {
    if (busy) return;
    messages.replaceChildren();
    conversation = [];
    suggestions.hidden = false;
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    ask(input.value);
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 112) + 'px';
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  suggestions.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button) ask(button.textContent);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) closePanel();
  });
})();