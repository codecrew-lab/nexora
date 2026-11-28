// NEXORA Teacher Portal: RFID attendance panel.
//
// Shows reader status and today's taps, lets teachers assign unknown cards to
// students, deactivate lost cards, and set the late cut-off. Requires the
// 20261127120000_rfid_attendance_v2.sql migration.
//
// After every successful load it fires a 'nexora:rfid-updated' event on window,
// which the add-user form and the roster's card badges (teacher-enroll.js) use.
//
// teacher.html calls NexoraRfidAdmin.studentsChanged(allStudents) whenever the
// roster loads; the panel starts itself on the first call.
(function () {
  const POLL_MS = 15000;
  const ONLINE_WINDOW_MS = 7 * 60 * 1000;   // readers send a heartbeat every 5 minutes
  const UNKNOWN_LOOKBACK_DAYS = 7;

  let students = [];
  let studentsById = new Map();
  let cards = [];
  let unknownEntries = [];
  let pollTimer = null;
  let loading = false;

  const $ = id => document.getElementById(id);

  function node(tag, options = {}, children = []) {
    const element = document.createElement(tag);
    if (options.className) element.className = options.className;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.title) element.title = options.title;
    if (options.type) element.type = options.type;
    if (options.style) element.style.cssText = options.style;
    for (const child of children) if (child) element.append(child);
    return element;
  }

  function badge(text, tone) {
    return node('span', { className: 'rfid-badge rfid-badge-' + tone, text });
  }

  function normaliseUid(value) {
    return String(value || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  }

  function studentLabel(student) {
    if (!student) return 'Unknown student';
    return student.student_name + (student.class_name ? ' (' + student.class_name + ')' : '');
  }

  function relativeTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return 'never';
    const seconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.round(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago';
    return date.toLocaleDateString('en-IN', { timeZone: NexoraAttendance.TIME_ZONE, day: 'numeric', month: 'short' });
  }

  function setMessage(text, tone = 'muted') {
    const box = $('rfidMessage');
    if (!box) return;
    box.textContent = text;
    box.style.color = tone === 'error' ? '#ef4444' : tone === 'success' ? '#10b981' : 'var(--text-secondary)';
  }

  function isMissingSetup(error) {
    return Boolean(error) && (error.code === '42P01' || error.code === 'PGRST205' || error.code === '42703'
      || /does not exist|schema cache/i.test(error.message || ''));
  }

  function studentOptions(select, placeholder) {
    const current = select.value;
    select.replaceChildren(node('option', { text: placeholder }));
    select.firstChild.value = '';
    const sorted = [...students].sort((a, b) =>
      String(a.class_name || '').localeCompare(String(b.class_name || '')) ||
      String(a.student_name || '').localeCompare(String(b.student_name || '')));
    const withCard = new Set(cards.filter(card => card.active).map(card => card.student_id));
    for (const student of sorted) {
      const option = node('option', { text: studentLabel(student) + (withCard.has(student.id) ? ' · has card' : '') });
      option.value = String(student.id);
      select.append(option);
    }
    if ([...select.options].some(option => option.value === current)) select.value = current;
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  async function fetchAll() {
    const today = NexoraAttendance.todayIso();
    const since = new Date(Date.now() - UNKNOWN_LOOKBACK_DAYS * 86400000).toISOString();
    const [cardsResult, readersResult, scansResult, unknownResult, settingsResult] = await Promise.all([
      nexoraClient.from('student_rfid_cards').select('id,student_id,card_uid,active,created_at').order('created_at', { ascending: false }),
      nexoraClient.from('rfid_devices').select('*').order('last_seen_at', { ascending: false }),
      nexoraClient.from('rfid_scan_events').select('id,card_uid,device_id,student_id,result,scanned_at,is_late')
        .eq('attendance_date', today).order('scanned_at', { ascending: false }).limit(500),
      nexoraClient.from('rfid_scan_events').select('card_uid,device_id,scanned_at')
        .eq('result', 'unregistered_card').gte('received_at', since).order('received_at', { ascending: false }).limit(300),
      nexoraClient.from('attendance_settings').select('late_after').maybeSingle()
    ]);
    const error = cardsResult.error || readersResult.error || scansResult.error || unknownResult.error || settingsResult.error;
    if (error) throw error;
    return {
      cards: cardsResult.data || [],
      readers: readersResult.data || [],
      scans: scansResult.data || [],
      unknown: unknownResult.data || [],
      lateAfter: settingsResult.data?.late_after || null
    };
  }

  // Returns true when everything loaded.
  async function refresh() {
    if (loading || !$('teacherRfidSection') || typeof nexoraClient === 'undefined' || !nexoraClient) return false;
    loading = true;
    try {
      const data = await fetchAll();
      cards = data.cards;
      renderReaders(data.readers);
      renderToday(data.scans);
      renderUnknown(data.unknown);
      renderCards();
      studentOptions($('rfidRegisterStudent'), 'Choose student');
      const lateInput = $('rfidLateAfter');
      if (data.lateAfter && document.activeElement !== lateInput) lateInput.value = data.lateAfter.slice(0, 5);
      $('rfidUpdatedAt').textContent = 'Updated ' + NexoraAttendance.formatTime(new Date());
      window.dispatchEvent(new CustomEvent('nexora:rfid-updated'));
      return true;
    } catch (error) {
      console.error('RFID panel failed to load:', error);
      setMessage(isMissingSetup(error)
        ? 'RFID tables are not set up yet. Apply db/migrations/20261127120000_rfid_attendance_v2.sql to the database (cd server && npm run db:migrate).'
        : 'Could not load RFID data: ' + (error.message || 'unknown error'), 'error');
      stopPolling();
      return false;
    } finally {
      loading = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function renderReaders(readers) {
    const box = $('rfidReaders');
    box.replaceChildren();
    if (!readers.length) {
      box.append(node('p', { className: 'rfid-muted', text: 'No reader has connected yet. Power on the reader and tap a card.' }));
      return;
    }
    for (const reader of readers) {
      const online = Date.now() - new Date(reader.last_seen_at).getTime() < ONLINE_WINDOW_MS;
      const details = [
        'Last seen ' + relativeTime(reader.last_seen_at),
        reader.firmware_version ? 'v' + reader.firmware_version : null,
        typeof reader.wifi_rssi === 'number' ? 'Wi-Fi ' + reader.wifi_rssi + ' dBm' : null,
        reader.queued_scans > 0 ? reader.queued_scans + ' taps waiting to sync' : null
      ].filter(Boolean).join(' · ');
      box.append(node('div', { className: 'rfid-row' }, [
        node('div', {}, [
          node('strong', { text: reader.device_id }),
          node('small', { className: 'rfid-muted rfid-block', text: details })
        ]),
        badge(online ? 'Online' : 'Offline', online ? 'green' : 'red')
      ]));
    }
  }

  function renderToday(scans) {
    const presentIds = new Set(scans.filter(scan => scan.result === 'present_marked').map(scan => scan.student_id));
    const lateIds = new Set(scans.filter(scan => scan.result === 'present_marked' && scan.is_late).map(scan => scan.student_id));
    const unknownCount = scans.filter(scan => scan.result === 'unregistered_card').length;
    const summary = $('rfidTodaySummary');
    summary.replaceChildren(
      node('strong', { className: 'rfid-big', text: presentIds.size + ' / ' + students.length }),
      node('small', { className: 'rfid-muted rfid-block', text: 'students tapped in today' + (lateIds.size ? ' · ' + lateIds.size + ' late' : '') + (unknownCount ? ' · ' + unknownCount + ' unknown-card taps' : '') })
    );

    const feed = $('rfidScanFeed');
    feed.replaceChildren();
    if (!scans.length) {
      feed.append(node('p', { className: 'rfid-muted', text: 'No taps yet today.' }));
      return;
    }
    for (const scan of scans.slice(0, 40)) {
      const student = studentsById.get(scan.student_id);
      const label = scan.result === 'unregistered_card' ? 'Unknown card ' + scan.card_uid : studentLabel(student);
      const badges = node('span', { style: 'display:flex;gap:6px;flex-wrap:wrap;' });
      if (scan.result === 'present_marked') badges.append(badge('Marked present', 'green'));
      if (scan.result === 'already_marked') badges.append(badge('Repeat tap', 'grey'));
      if (scan.result === 'unregistered_card') badges.append(badge('Not registered', 'amber'));
      if (scan.result === 'student_unavailable') badges.append(badge('Student missing', 'red'));
      if (scan.is_late && scan.result === 'present_marked') badges.append(badge('Late', 'amber'));
      feed.append(node('div', { className: 'rfid-row' }, [
        node('div', {}, [
          node('strong', { text: label }),
          node('small', { className: 'rfid-muted rfid-block', text: NexoraAttendance.formatTime(scan.scanned_at) + ' · ' + scan.device_id })
        ]),
        badges
      ]));
    }
  }

  function renderUnknown(events) {
    const registered = new Set(cards.filter(card => card.active).map(card => card.card_uid));
    const byUid = new Map();
    for (const event of events) {
      if (registered.has(event.card_uid)) continue;
      const entry = byUid.get(event.card_uid) || { uid: event.card_uid, last: event.scanned_at, device: event.device_id, taps: 0 };
      entry.taps += 1;
      byUid.set(event.card_uid, entry);
    }

    unknownEntries = [...byUid.values()];
    const box = $('rfidUnknownCards');
    box.replaceChildren();
    if (!byUid.size) {
      box.append(node('p', { className: 'rfid-muted', text: 'No unknown cards. To add a new card, tap it on the reader and it will appear here.' }));
      return;
    }
    for (const entry of byUid.values()) {
      const select = node('select', { className: 'input-field', style: 'max-width:260px;' });
      studentOptions(select, 'Assign to student…');
      const button = node('button', { className: 'btn', type: 'button', text: 'Assign', style: 'padding:8px 12px;' });
      button.addEventListener('click', () => assignCard(entry.uid, Number(select.value), button));
      box.append(node('div', { className: 'rfid-row' }, [
        node('div', {}, [
          node('strong', { className: 'rfid-uid', text: entry.uid }),
          node('small', { className: 'rfid-muted rfid-block', text: 'Last tapped ' + relativeTime(entry.last) + ' at ' + entry.device + ' · ' + entry.taps + (entry.taps === 1 ? ' tap' : ' taps') })
        ]),
        node('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;' }, [select, button])
      ]));
    }
  }

  function renderCards() {
    const list = $('rfidCardList');
    const query = ($('rfidCardSearch').value || '').trim().toLowerCase();
    $('rfidCardCount').textContent = String(cards.filter(card => card.active).length);
    list.replaceChildren();
    const rows = cards.filter(card => {
      if (!query) return true;
      const student = studentsById.get(card.student_id);
      return card.card_uid.toLowerCase().includes(query) || studentLabel(student).toLowerCase().includes(query);
    });
    if (!rows.length) {
      list.append(node('p', { className: 'rfid-muted', text: cards.length ? 'No cards match your search.' : 'No cards registered yet.' }));
      return;
    }
    for (const card of rows) {
      const student = studentsById.get(card.student_id);
      const button = node('button', {
        className: 'btn', type: 'button',
        text: card.active ? 'Deactivate' : 'Reactivate',
        style: 'padding:6px 10px;font-size:.8rem;' + (card.active ? 'background:#b91c1c;' : '')
      });
      button.addEventListener('click', () => setCardActive(card, !card.active, button));
      list.append(node('div', { className: 'rfid-row' + (card.active ? '' : ' rfid-inactive') }, [
        node('div', {}, [
          node('strong', { text: studentLabel(student) }),
          node('small', { className: 'rfid-muted rfid-block rfid-uid', text: card.card_uid })
        ]),
        node('div', { style: 'display:flex;gap:8px;align-items:center;' }, [
          badge(card.active ? 'Active' : 'Inactive', card.active ? 'green' : 'grey'),
          button
        ])
      ]));
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  async function assignCard(rawUid, studentId, button) {
    const uid = normaliseUid(rawUid);
    const student = studentsById.get(studentId);
    if (!student) return setMessage('Choose a student first.', 'error');
    if (!/^[0-9A-F]{8,20}$/.test(uid)) return setMessage('A card UID is 8 to 20 hex characters, e.g. 39C38E02.', 'error');

    const existingForUid = cards.find(card => card.card_uid === uid);
    if (existingForUid?.active && existingForUid.student_id === studentId) {
      return setMessage('That card is already assigned to ' + student.student_name + '.', 'success');
    }
    if (existingForUid?.active) {
      const owner = studentLabel(studentsById.get(existingForUid.student_id));
      if (!confirm('Card ' + uid + ' belongs to ' + owner + '.\n\nMove it to ' + studentLabel(student) + '?')) return;
    }
    const currentCard = cards.find(card => card.active && card.student_id === studentId && card.card_uid !== uid);
    if (currentCard && !confirm(studentLabel(student) + ' already has card ' + currentCard.card_uid + '.\n\nReplace it? The old card will stop working.')) return;

    if (button) { button.disabled = true; button.textContent = 'Saving…'; }
    try {
      // Only one active card per student: retire the old one first.
      if (currentCard) {
        const { error } = await nexoraClient.from('student_rfid_cards').update({ active: false }).eq('id', currentCard.id);
        if (error) throw error;
      }
      const { error } = existingForUid
        // UIDs are unique across all rows, so a previously used card is re-pointed instead of inserted.
        ? await nexoraClient.from('student_rfid_cards').update({ student_id: studentId, active: true }).eq('id', existingForUid.id)
        : await nexoraClient.from('student_rfid_cards').insert({ student_id: studentId, card_uid: uid, created_by: window.NEXORA_TEACHER_USER_ID || null });
      if (error) throw error;
      setMessage('Card ' + uid + ' assigned to ' + studentLabel(student) + '. They can tap now.', 'success');
      const uidInput = $('rfidRegisterUid');
      if (uidInput && normaliseUid(uidInput.value) === uid) uidInput.value = '';
      await refresh();
    } catch (error) {
      setMessage('Could not assign the card: ' + (error.message || 'unknown error'), 'error');
    } finally {
      if (button) { button.disabled = false; button.textContent = button.dataset.label || 'Assign'; }
    }
  }

  async function setCardActive(card, active, button) {
    const student = studentsById.get(card.student_id);
    if (!active && !confirm('Deactivate card ' + card.card_uid + ' for ' + studentLabel(student) + '?\n\nTaps with this card will show "Unknown card" until it is reactivated or reassigned.')) return;
    if (active && cards.some(other => other.active && other.student_id === card.student_id)) {
      return setMessage(studentLabel(student) + ' already has an active card. Deactivate it first.', 'error');
    }
    button.disabled = true;
    const { error } = await nexoraClient.from('student_rfid_cards').update({ active }).eq('id', card.id);
    button.disabled = false;
    if (error) return setMessage('Could not update the card: ' + error.message, 'error');
    setMessage('Card ' + card.card_uid + (active ? ' reactivated.' : ' deactivated.'), 'success');
    await refresh();
  }

  async function saveLateAfter(event) {
    event.preventDefault();
    const value = $('rfidLateAfter').value;
    if (!/^\d{2}:\d{2}$/.test(value)) return setMessage('Enter a time such as 09:30.', 'error');
    const { data, error } = await nexoraClient.from('attendance_settings')
      .update({ late_after: value, updated_at: new Date().toISOString(), updated_by: window.NEXORA_TEACHER_USER_ID || null })
      .eq('id', true).select('late_after');
    if (error || !data?.length) return setMessage('Could not save the late cut-off. ' + (error?.message || 'Check teacher permissions.'), 'error');
    setMessage('Taps after ' + value + ' are now marked Late. Earlier records are unchanged.', 'success');
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  // Opens the card form for one student, from the roster's "Map card" button.
  function startAssign(studentId) {
    const student = studentsById.get(Number(studentId));
    const form = $('rfidRegisterForm');
    if (!student || !form) return;
    const details = form.closest('details');
    if (details) details.open = true;
    studentOptions($('rfidRegisterStudent'), 'Choose student');
    $('rfidRegisterStudent').value = String(student.id);
    // Only suggest a card tapped in the last ten minutes: an older tap is probably someone else's.
    const newest = unknownEntries[0];
    const latest = newest && Date.now() - new Date(newest.last).getTime() < 10 * 60 * 1000 ? newest : null;
    const uidInput = $('rfidRegisterUid');
    // The most recent unassigned tap is almost always the card being handed over.
    if (latest && !uidInput.value) uidInput.value = latest.uid;
    setMessage(latest
      ? 'Mapping a card to ' + studentLabel(student) + '. ' + latest.uid + ' was tapped ' + relativeTime(latest.last) + '. Press Register card, or type another UID.'
      : 'Mapping a card to ' + studentLabel(student) + '. Tap the card on a reader and press Refresh, or type its UID, then press Register card.');
    if (typeof form.scrollIntoView === 'function') form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    uidInput.focus();
  }

  let wired = false;
  function wireEvents() {
    if (wired || !$('teacherRfidSection')) return;
    wired = true;
    $('rfidRefresh').addEventListener('click', () => {
      setMessage('');
      refresh().then(ok => { if (ok && !pollTimer) startPolling(); });
    });
    $('rfidCardSearch').addEventListener('input', renderCards);
    $('rfidLateForm').addEventListener('submit', saveLateAfter);
    const registerButton = $('rfidRegisterButton');
    registerButton.dataset.label = registerButton.textContent;
    $('rfidRegisterForm').addEventListener('submit', event => {
      event.preventDefault();
      assignCard($('rfidRegisterUid').value, Number($('rfidRegisterStudent').value), registerButton);
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && pollTimer) refresh(); });
  }

  window.NexoraRfidAdmin = Object.freeze({
    studentsChanged(list) {
      students = Array.isArray(list) ? list : [];
      studentsById = new Map(students.map(student => [student.id, student]));
      wireEvents();
      refresh().then(ok => { if (ok && !pollTimer) startPolling(); });
    },
    refresh,
    startAssign,
    // Cards tapped on a reader that belong to nobody yet, newest first.
    unknownCards: () => unknownEntries.map(entry => ({ ...entry })),
    // The student's active card, or null.
    cardFor: studentId => cards.find(card => card.active && card.student_id === studentId) || null
  });
})();
