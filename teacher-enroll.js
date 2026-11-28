// NEXORA Teacher Portal: add a user and map their RFID card in one step.
//
// The form sends the name, class, password and (optionally) a card UID to the
// server's student-enroll function, which creates the student record, the login
// and the card mapping together. The roster's card badges are filled in here
// too, from the RFID panel's card list (teacher-rfid.js).
//
// teacher.html calls NexoraEnroll.studentsChanged(allStudents) whenever the
// roster loads.
(function () {
  const $ = id => document.getElementById(id);
  // No look-alike characters (0/O, 1/l/I), so a password read aloud or copied by hand survives.
  const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const PASSWORD_LENGTH = 12;

  function normaliseUid(value) {
    return String(value || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  }

  function generatePassword() {
    const picks = new Uint32Array(PASSWORD_LENGTH);
    crypto.getRandomValues(picks);
    // The alphabet has 55 characters; the bias from the modulo is far too small to matter here.
    return Array.from(picks, value => PASSWORD_ALPHABET[value % PASSWORD_ALPHABET.length]).join('');
  }

  function setMessage(text, tone) {
    const box = $('enrollMessage');
    box.textContent = text;
    box.style.color = tone === 'error' ? '#ef4444' : tone === 'success' ? '#10b981' : 'var(--text-secondary)';
  }

  function relativeTime(value) {
    const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
    if (!Number.isFinite(seconds)) return '';
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.round(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago';
    return Math.round(seconds / 86400) + ' d ago';
  }

  // Cards that were tapped on a reader but belong to nobody yet. Tapping the
  // new card and picking it here avoids typing its UID.
  function renderTappedCards() {
    const box = $('enrollTappedCards');
    if (!box) return;
    const unknown = window.NexoraRfidAdmin?.unknownCards() || [];
    box.replaceChildren();
    const hint = document.createElement('span');
    hint.style.color = 'var(--text-secondary)';
    box.append(hint);
    if (!unknown.length) {
      hint.textContent = 'Tap the new card on a reader and it will appear here, or type its UID. ';
    } else {
      hint.textContent = 'Recently tapped, not yet assigned: ';
      for (const entry of unknown.slice(0, 5)) {
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'btn teacher-secondary-action rfid-uid';
        pick.style.cssText = 'padding:4px 8px;font-size:0.75rem;margin:2px 4px 2px 0;';
        pick.textContent = entry.uid + ' · ' + relativeTime(entry.last);
        pick.addEventListener('click', () => {
          $('enrollCardUid').value = entry.uid;
          setMessage('Card ' + entry.uid + ' selected.', 'muted');
        });
        box.append(pick);
      }
    }
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'btn teacher-secondary-action';
    check.style.cssText = 'padding:4px 8px;font-size:0.75rem;margin:2px 0;';
    check.textContent = 'Check for taps';
    check.addEventListener('click', async () => {
      check.disabled = true;
      await window.NexoraRfidAdmin?.refresh();
      check.disabled = false;
    });
    box.append(check);
  }

  // The card badge and "Map card" label on each roster row.
  function renderRosterCards() {
    const admin = window.NexoraRfidAdmin;
    if (!admin) return;
    document.querySelectorAll('[data-card-for]').forEach(badge => {
      const card = admin.cardFor(Number(badge.dataset.cardFor));
      badge.textContent = card ? 'Card ' + card.card_uid : 'No card';
      badge.className = 'rfid-badge rfid-uid ' + (card ? 'rfid-badge-green' : 'rfid-badge-grey');
      const button = document.querySelector('[data-map-card="' + badge.dataset.cardFor + '"]');
      if (button) button.textContent = card ? 'Change card' : 'Map card';
    });
  }

  function showResult(student, password, cardUid) {
    const box = $('enrollResult');
    const line = (label, value, strong) => {
      const row = document.createElement('p');
      row.style.cssText = 'margin:4px 0;word-break:break-all;';
      const name = document.createElement('span');
      name.style.color = 'var(--text-secondary)';
      name.textContent = label + ': ';
      const text = document.createElement(strong ? 'strong' : 'span');
      text.textContent = value;
      row.append(name, text);
      return row;
    };
    const heading = document.createElement('strong');
    heading.style.color = '#10b981';
    heading.textContent = student.student_name + ' added';
    const note = document.createElement('small');
    note.style.cssText = 'display:block;margin-top:8px;color:var(--text-secondary);';
    note.textContent = 'Give the code and password to the student now. The password is not shown again; you can set a new one from the list below.';
    const details = 'Student: ' + student.student_name + '\nLogin code: ' + student.student_code + '\nPassword: ' + password;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn teacher-secondary-action';
    copy.style.cssText = 'padding:6px 10px;font-size:0.8rem;margin-top:8px;';
    copy.textContent = 'Copy login details';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(details);
        copy.textContent = 'Copied';
      } catch (_) {
        copy.textContent = 'Copy not available. Write the details down.';
      }
    });
    box.replaceChildren(
      heading,
      line('Class', student.class_name),
      line('Login code', student.student_code, true),
      line('Password', password, true),
      line('RFID card', cardUid ? cardUid + ' (mapped, ready to tap)' : 'not mapped yet. Use "Map card" in the list below'),
      note,
      copy
    );
    box.hidden = false;
  }

  async function submit(event) {
    event.preventDefault();
    if (typeof nexoraClient === 'undefined' || !nexoraClient) return setMessage('The service is unavailable. Please try again later.', 'error');
    const name = $('enrollName').value.trim();
    const className = $('enrollClass').value.trim();
    const password = $('enrollPassword').value;
    const rawUid = $('enrollCardUid').value.trim();
    const cardUid = normaliseUid(rawUid);
    if (!name || !className) return setMessage('Enter the student\'s name and class.', 'error');
    if (password.length < 10 || password.length > 72) return setMessage('The password needs 10 to 72 characters. Press Generate for a ready-made one.', 'error');
    if (rawUid && !/^[0-9A-F]{8,20}$/.test(cardUid)) return setMessage('A card UID is 8 to 20 hex characters, e.g. 39C38E02. Leave it empty to map the card later.', 'error');

    const button = $('enrollSubmit');
    button.disabled = true;
    button.textContent = 'Adding…';
    setMessage('');
    $('enrollResult').hidden = true;
    try {
      const { data, error } = await nexoraClient.functions.invoke('student-enroll', {
        body: { student_name: name, class_name: className, password, card_uid: rawUid ? cardUid : '' }
      });
      if (error || !data?.success) {
        return setMessage('Could not add the user: ' + (data?.error || error?.message || 'unknown error'), 'error');
      }
      showResult(data.student, password, data.card_uid);
      $('enrollStudentForm').reset();
      setMessage('');
      // Reloads the roster, which also refreshes the RFID panel and the badges.
      if (typeof window.loadStudentsRoster === 'function') await window.loadStudentsRoster();
    } catch (_) {
      setMessage('A connection error interrupted the request. Check the list below before trying again.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Add user';
    }
  }

  let wired = false;
  function wire() {
    if (wired || !$('enrollStudentForm')) return;
    wired = true;
    $('enrollStudentForm').addEventListener('submit', submit);
    $('enrollGeneratePassword').addEventListener('click', () => { $('enrollPassword').value = generatePassword(); });
    window.addEventListener('nexora:rfid-updated', () => { renderTappedCards(); renderRosterCards(); });
    renderTappedCards();
  }

  window.NexoraEnroll = Object.freeze({
    studentsChanged(list) {
      wire();
      const classes = [...new Set((Array.isArray(list) ? list : []).map(student => student.class_name).filter(Boolean))].sort();
      const datalist = $('enrollClassList');
      if (datalist) {
        datalist.replaceChildren(...classes.map(name => {
          const option = document.createElement('option');
          option.value = name;
          return option;
        }));
      }
    },
    renderRosterCards
  });
})();
