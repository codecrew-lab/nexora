// NEXORA shared attendance helpers, used by the student, parent and teacher portals.
// Keep attendance display rules here so every portal shows the same thing.
(function () {
  const TIME_ZONE = 'Asia/Kolkata';
  // Rows saved before the RFID v2 migration have no is_late flag. The previous
  // rule was "late from 09:31 IST"; v2 rows carry the server's decision instead.
  const LEGACY_LATE_FROM = '09:31';

  const clockFormat = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const dateFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  });

  function toDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // True when the record was created by an RFID tap.
  function isRfid(record) {
    if (!record) return false;
    if (record.source) return record.source === 'rfid';
    // Before v2 the reader inserted rows with marked_by = null.
    return record.marked_by == null && record.status === 'Present' && Boolean(record.created_at);
  }

  // When the student actually tapped (offline taps are synced later), else when saved.
  function entryTime(record) {
    return toDate(record?.scanned_at) || toDate(record?.created_at);
  }

  function formatTime(value) {
    const date = toDate(value);
    if (!date) return '';
    return date.toLocaleTimeString('en-IN', {
      timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: true
    });
  }

  function isLate(record) {
    if (!isRfid(record)) return false;
    if (typeof record.is_late === 'boolean' && record.source) return record.is_late;
    const date = entryTime(record);
    return date ? clockFormat.format(date) >= LEGACY_LATE_FROM : false;
  }

  // One-line description shown under an attendance row.
  function timeDetails(record) {
    const date = entryTime(record);
    if (!date) return '';
    if (isRfid(record) && record.status === 'Present') {
      return 'RFID entry: ' + formatTime(date) + (isLate(record) ? ' · Late' : ' · On time');
    }
    return 'Recorded: ' + formatTime(date);
  }

  // Today's date in IST as YYYY-MM-DD (input[type=date] format).
  function todayIso() {
    return dateFormat.format(new Date());
  }

  window.NexoraAttendance = Object.freeze({
    TIME_ZONE, isRfid, isLate, entryTime, formatTime, timeDetails, todayIso
  });
})();
