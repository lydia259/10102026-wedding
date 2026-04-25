/**
 * Wedding backend — handles RSVPs, gift thank-you notes, and the public playlist.
 *
 * Setup:
 *   1. Create a Google Sheet (any name).
 *   2. Open Extensions → Apps Script and replace the default Code.gs with this file.
 *   3. Project Settings (gear icon) → Script Properties → Add:
 *        Property: ADMIN_TOKEN   Value: <a long, secret string>
 *      The same value is what you'll type into admin.html to sign in.
 *   4. Deploy → New deployment → Type: Web app
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      Copy the resulting /exec URL into assets/wedding-config.js.
 *
 * Re-deploy as a "New deployment" any time this file changes.
 * The admin token lives in Script Properties (NOT in this file) so the
 * source can safely be committed to a public repo.
 */

function getAdminToken_() {
  return PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN') || '';
}

const SHEETS = {
  rsvp: {
    name: 'RSVPs',
    headers: ['Submitted At', 'Name', 'Email', 'Attending', 'Plus One', 'Transport', 'Song Title', 'Song Artist']
  },
  gift: {
    name: 'Gifts',
    headers: ['Submitted At', 'Name', 'Amount', 'Method', 'Note']
  }
};

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const type = String(body.type || '').toLowerCase();
    const submittedAt = body.submittedAt ? new Date(body.submittedAt) : new Date();

    if (type === 'rsvp') {
      appendRow_(SHEETS.rsvp, [
        submittedAt,
        body.fullname || '',
        body.email || '',
        body.attending || '',
        formatPlusOne_(body.plusOne),
        body.transport || '',
        body.songTitle || '',
        body.songArtist || ''
      ]);
      return jsonOut_({ ok: true });
    }

    if (type === 'gift') {
      appendRow_(SHEETS.gift, [
        submittedAt,
        body.name || '',
        body.amount || '',
        body.method || '',
        body.note || ''
      ]);
      return jsonOut_({ ok: true });
    }

    return jsonOut_({ ok: false, error: 'unknown type' });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || 'songs').toLowerCase();

    if (action === 'songs') {
      return jsonOut_({ songs: getSongs_() });
    }

    if (action === 'all') {
      const token = (e && e.parameter && e.parameter.token) || '';
      const expected = getAdminToken_();
      if (!expected || token !== expected) {
        return jsonOut_({ ok: false, error: 'unauthorized' });
      }
      return jsonOut_({
        ok: true,
        rsvps: readSheet_(SHEETS.rsvp.name),
        gifts: readSheet_(SHEETS.gift.name),
        songs: getSongs_()
      });
    }

    return jsonOut_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

/**
 * Each guest contributes their latest song request only — if they edit and
 * resubmit, the previous song no longer counts.
 */
function getSongs_() {
  const rows = readSheet_(SHEETS.rsvp.name);
  const seen = {};
  const result = [];

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const title = String(row['Song Title'] || '').trim();
    if (!title) continue;
    const submitter = String(row['Name'] || '').trim();
    const submitterKey = submitter.toLowerCase();
    if (submitterKey && seen[submitterKey]) continue;
    if (submitterKey) seen[submitterKey] = true;

    result.unshift({
      songTitle: title,
      songArtist: String(row['Song Artist'] || '').trim(),
      submitter: submitter,
      submittedAt: row['Submitted At']
    });
  }

  return result;
}

function appendRow_(config, values) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(config.name) || ss.insertSheet(config.name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(config.headers);
    sheet.setFrozenRows(1);
  }
  sheet.appendRow(values);
}

function readSheet_(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim());

  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      let val = row[i];
      if (val instanceof Date) val = val.toISOString();
      obj[h] = val;
    });
    return obj;
  });
}

function formatPlusOne_(plusOne) {
  if (!plusOne) return '';
  if (plusOne === true) return 'yes';
  return String(plusOne);
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
