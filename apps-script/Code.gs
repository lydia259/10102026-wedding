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
    headers: ['Submitted At', 'Name', 'Email', 'Attending', 'Plus One', 'Transport', 'Song Title', 'Song Artist', 'Entree', 'Dietary', 'Address', 'Meal Submitted At']
  },
  gift: {
    name: 'Gifts',
    headers: ['Submitted At', 'Name', 'Amount', 'Method', 'Note']
  },
  vote: {
    name: 'Votes',
    headers: ['Submitted At', 'Voter ID', 'Song Key', 'Direction']
  }
};

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const type = String(body.type || '').toLowerCase();
    const submittedAt = body.submittedAt ? new Date(body.submittedAt) : new Date();

    if (type === 'stylist') {
      return jsonOut_(askStylist_(body));
    }

    if (type === 'rsvp') {
      const result = upsertRsvpRow_([
        submittedAt,
        body.fullname || '',
        body.email || '',
        body.attending || '',
        formatPlusOne_(body.plusOne),
        body.transport || '',
        body.songTitle || '',
        body.songArtist || ''
      ], body);
      try { sendRsvpConfirmation_(body); } catch (mailErr) {
        console.error('RSVP email failed:', mailErr);
      }
      return jsonOut_({ ok: true, updated: !!result.updated });
    }

    // Dinner / meal selection from survey.html. Writes the guest's entree and
    // dietary note onto their existing RSVP row (matched by email), or appends
    // a new row if the email isn't found. Does not send any email.
    if (type === 'meal') {
      const result = upsertMeal_(body, submittedAt);
      return jsonOut_({ ok: true, updated: !!result.updated });
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

    if (type === 'vote') {
      const voterId  = String(body.voterId || '').trim();
      const songKey  = String(body.songKey || '').trim();
      const direction = Number(body.direction);
      if (!voterId || !songKey || ![-1, 0, 1].includes(direction)) {
        return jsonOut_({ ok: false, error: 'invalid vote' });
      }
      upsertVote_(voterId, songKey, direction, submittedAt);
      return jsonOut_({ ok: true });
    }

    if (type === 'admin-delete') {
      const expected = getAdminToken_();
      if (!expected || String(body.token || '') !== expected) {
        return jsonOut_({ ok: false, error: 'unauthorized' });
      }
      const sheetKey = String(body.sheet || '').toLowerCase();
      const sheetName = sheetKey === 'rsvp' ? SHEETS.rsvp.name
                      : sheetKey === 'gift' ? SHEETS.gift.name
                      : '';
      if (!sheetName) return jsonOut_({ ok: false, error: 'unknown sheet' });
      const deleted = deleteRowBySubmittedAt_(sheetName, String(body.submittedAt || ''));
      return jsonOut_({ ok: deleted, deleted: deleted });
    }

    // Silent admin create: appends a new row to the sheet using a
    // server-side timestamp. Does NOT trigger any guest notifications.
    if (type === 'admin-create') {
      const expected = getAdminToken_();
      if (!expected || String(body.token || '') !== expected) {
        return jsonOut_({ ok: false, error: 'unauthorized' });
      }
      const sheetKey = String(body.sheet || '').toLowerCase();
      const config = sheetKey === 'rsvp' ? SHEETS.rsvp
                   : sheetKey === 'gift' ? SHEETS.gift
                   : null;
      if (!config) return jsonOut_({ ok: false, error: 'unknown sheet' });
      const updates = (body.updates && typeof body.updates === 'object') ? body.updates : {};
      const createdAt = new Date();
      appendRowByHeader_(config, updates, createdAt);
      return jsonOut_({ ok: true, submittedAt: createdAt.toISOString() });
    }

    // Silent admin edit: updates a sheet row in place without sending any
    // confirmation email to the guest. Uses the row's "Submitted At"
    // timestamp as a stable identifier.
    if (type === 'admin-update') {
      const expected = getAdminToken_();
      if (!expected || String(body.token || '') !== expected) {
        return jsonOut_({ ok: false, error: 'unauthorized' });
      }
      const sheetKey = String(body.sheet || '').toLowerCase();
      const config = sheetKey === 'rsvp' ? SHEETS.rsvp
                   : sheetKey === 'gift' ? SHEETS.gift
                   : null;
      if (!config) return jsonOut_({ ok: false, error: 'unknown sheet' });
      const updates = (body.updates && typeof body.updates === 'object') ? body.updates : {};
      const updated = updateRowBySubmittedAt_(
        config.name,
        config.headers,
        String(body.submittedAt || ''),
        updates
      );
      return jsonOut_({ ok: !!updated, updated: !!updated });
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
      return jsonOut_({ songs: getSongs_(), votes: getVotes_() });
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
        songs: getSongs_(),
        votes: getVotes_()
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
  ensureHeaders_(sheet, config.headers);
  sheet.appendRow(values);
}

/**
 * Appends a row using the sheet's ACTUAL header row so each value lands in the
 * correct physical column even when the sheet has columns that aren't in
 * config.headers (e.g. the email-tracking columns) or a newer column such as
 * "Tags". `updates` is keyed by header name; column A ("Submitted At") is set
 * from createdAt. Any header referenced in `updates` that doesn't exist yet is
 * created first. Used by the authenticated admin create path.
 */
function appendRowByHeader_(config, updates, createdAt) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(config.name) || ss.insertSheet(config.name);
  ensureHeaders_(sheet, config.headers);
  if (updates) ensureHeaders_(sheet, Object.keys(updates));
  const lastCol = sheet.getLastColumn();
  const physical = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const row = physical.map((h, idx) => {
    if (idx === 0) return createdAt;
    if (updates && Object.prototype.hasOwnProperty.call(updates, h)) {
      const val = updates[h];
      return val == null ? '' : val;
    }
    return '';
  });
  sheet.appendRow(row);
}

/**
 * Make sure the sheet's header row contains every header in `headers`.
 * Missing headers are appended to the end in order. This keeps the physical
 * column order aligned with config.headers so index-based reads/writes stay
 * correct even on sheets created before a new column (e.g. Address) was added.
 * Safe because config.headers is only ever appended to, never reordered.
 */
function ensureHeaders_(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    return;
  }
  const existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  headers.forEach(h => {
    if (existing.indexOf(h) === -1) {
      sheet.getRange(1, existing.length + 1).setValue(h);
      existing.push(h);
    }
  });
}

/**
 * Insert or update an RSVP row.
 * Matches existing rows by email (case-insensitive) when available, otherwise
 * falls back to a case-insensitive name match. Updates the most recent
 * matching row in place so a guest editing their reply doesn't create
 * duplicate records.
 */
function upsertRsvpRow_(values, body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const config = SHEETS.rsvp;
  const sheet = ss.getSheetByName(config.name) || ss.insertSheet(config.name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(config.headers);
    sheet.setFrozenRows(1);
  }

  const matchEmail = String((body && body.email) || '').trim().toLowerCase();
  const matchName  = String((body && body.fullname) || '').trim().toLowerCase();
  const lastRow = sheet.getLastRow();

  if (lastRow >= 2 && (matchEmail || matchName)) {
    const data = sheet.getRange(2, 1, lastRow - 1, config.headers.length).getValues();
    // Column order matches SHEETS.rsvp.headers:
    // 0 Submitted At · 1 Name · 2 Email · 3 Attending · 4 Plus One · 5 Transport · 6 Song Title · 7 Song Artist
    const NAME_COL = 1, EMAIL_COL = 2;

    for (let i = data.length - 1; i >= 0; i--) {
      const rowEmail = String(data[i][EMAIL_COL] || '').trim().toLowerCase();
      const rowName  = String(data[i][NAME_COL]  || '').trim().toLowerCase();
      const matched  = matchEmail
        ? (rowEmail && rowEmail === matchEmail)
        : (matchName && rowName === matchName);
      if (matched) {
        sheet.getRange(i + 2, 1, 1, values.length).setValues([values]);
        return { updated: true, row: i + 2 };
      }
    }
  }

  sheet.appendRow(values);
  return { updated: false };
}

/**
 * Writes a guest's dinner selection onto their RSVP row.
 *
 * Matches the most recent row by email (case-insensitive) and sets the
 * "Entree" and "Dietary" columns in place. If those columns don't exist yet
 * (sheet created before this feature), they're added to the header row first.
 * If no row matches the email, a new row is appended with just the name,
 * email, and meal selection so the response is never lost.
 */
function upsertMeal_(body, submittedAt) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const config = SHEETS.rsvp;
  const sheet = ss.getSheetByName(config.name) || ss.insertSheet(config.name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(config.headers);
    sheet.setFrozenRows(1);
  }

  // Read the live header row and make sure Entree/Dietary/Address exist.
  let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  ['Entree', 'Dietary', 'Address', 'Meal Submitted At'].forEach(h => {
    if (headers.indexOf(h) === -1) {
      sheet.getRange(1, headers.length + 1).setValue(h);
      headers.push(h);
    }
  });

  const submittedIdx = headers.indexOf('Submitted At');
  const nameIdx      = headers.indexOf('Name');
  const emailIdx     = headers.indexOf('Email');
  const entreeIdx    = headers.indexOf('Entree');
  const dietaryIdx   = headers.indexOf('Dietary');
  const addressIdx   = headers.indexOf('Address');
  const mealAtIdx    = headers.indexOf('Meal Submitted At');

  const email   = String(body.email || '').trim().toLowerCase();
  const name    = String(body.name || body.fullname || '').trim();
  const entree  = String(body.entree || '').trim();
  const dietary = String(body.dietary || '').trim();
  const address = String(body.address || '').trim();

  // Writes the meal fields onto an existing row and returns the result.
  function applyMeal(rowNumber) {
    sheet.getRange(rowNumber, entreeIdx + 1).setValue(entree);
    sheet.getRange(rowNumber, dietaryIdx + 1).setValue(dietary);
    // Only overwrite address when the guest actually provided one.
    if (address) sheet.getRange(rowNumber, addressIdx + 1).setValue(address);
    // Stamp when the meal was submitted so the admin can sort by it.
    if (mealAtIdx !== -1) sheet.getRange(rowNumber, mealAtIdx + 1).setValue(submittedAt || new Date());
    return { updated: true, row: rowNumber };
  }

  const nameKey = name.toLowerCase().replace(/\s+/g, ' ');
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const data = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();

    // 1) Match by email first — it is the most reliable identifier.
    if (email && emailIdx !== -1) {
      for (let i = data.length - 1; i >= 0; i--) {
        const rowEmail = String(data[i][emailIdx] || '').trim().toLowerCase();
        if (rowEmail && rowEmail === email) return applyMeal(i + 2);
      }
    }

    // 2) Fall back to an exact (case-insensitive) name match. This covers
    //    guests who arrive without their email link, or whose RSVP row was
    //    saved under a different/blank email.
    if (nameKey && nameIdx !== -1) {
      for (let i = data.length - 1; i >= 0; i--) {
        const rowName = String(data[i][nameIdx] || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (rowName && rowName === nameKey) {
          // Backfill the email on that row if it was missing one.
          if (email && emailIdx !== -1 && !String(data[i][emailIdx] || '').trim()) {
            sheet.getRange(i + 2, emailIdx + 1).setValue(body.email || '');
          }
          return applyMeal(i + 2);
        }
      }
    }
  }

  const newRow = headers.map((h, idx) => {
    if (idx === submittedIdx) return submittedAt;
    if (idx === nameIdx)      return name;
    if (idx === emailIdx)     return body.email || '';
    if (idx === entreeIdx)    return entree;
    if (idx === dietaryIdx)   return dietary;
    if (idx === addressIdx)   return address;
    return '';
  });
  sheet.appendRow(newRow);
  return { updated: false };
}

/**
 * Records or updates a vote. One row per (voterId, songKey). Direction can be
 * -1 (down), 1 (up), or 0 (clear). Direction 0 deletes the row so the vote
 * has no further effect on totals.
 */
function upsertVote_(voterId, songKey, direction, submittedAt) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const config = SHEETS.vote;
  const sheet = ss.getSheetByName(config.name) || ss.insertSheet(config.name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(config.headers);
    sheet.setFrozenRows(1);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const data = sheet.getRange(2, 1, lastRow - 1, config.headers.length).getValues();
    // 0 Submitted At · 1 Voter ID · 2 Song Key · 3 Direction
    for (let i = data.length - 1; i >= 0; i--) {
      const rowVoter = String(data[i][1] || '');
      const rowKey   = String(data[i][2] || '');
      if (rowVoter === voterId && rowKey === songKey) {
        if (direction === 0) {
          sheet.deleteRow(i + 2);
        } else {
          sheet.getRange(i + 2, 1, 1, 4).setValues([[submittedAt, voterId, songKey, direction]]);
        }
        return;
      }
    }
  }

  if (direction !== 0) {
    sheet.appendRow([submittedAt, voterId, songKey, direction]);
  }
}

/**
 * Aggregates global vote tallies as { songKey: totalScore }.
 */
function getVotes_() {
  const rows = readSheet_(SHEETS.vote.name);
  const map = {};
  rows.forEach(r => {
    const key = String(r['Song Key'] || '');
    if (!key) return;
    const dir = Number(r['Direction']) || 0;
    map[key] = (map[key] || 0) + dir;
  });
  return map;
}

/**
 * Deletes a row from the given sheet by matching its "Submitted At" timestamp
 * (column A, ISO string). Returns true if a row was deleted. Submitted-at
 * timestamps are effectively unique because they're created server-side.
 */
function deleteRowBySubmittedAt_(sheetName, submittedAtIso) {
  if (!submittedAtIso) return false;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return false;
  const lastRow = sheet.getLastRow();
  const data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = data.length - 1; i >= 0; i--) {
    const v = data[i][0];
    const iso = v instanceof Date ? v.toISOString() : String(v);
    if (iso === submittedAtIso) {
      sheet.deleteRow(i + 2);
      return true;
    }
  }
  return false;
}

/**
 * Updates a row in the given sheet by matching its "Submitted At" timestamp
 * (column A, ISO string). The `updates` object is keyed by header name and
 * may include any subset of editable columns; "Submitted At" is always
 * preserved. Returns true if a row was updated.
 *
 * Intentionally does NOT trigger any guest notifications.
 */
function updateRowBySubmittedAt_(sheetName, headers, submittedAtIso, updates) {
  if (!submittedAtIso) return false;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return false;
  ensureHeaders_(sheet, headers);
  if (updates) ensureHeaders_(sheet, Object.keys(updates));
  // Operate against the sheet's ACTUAL header row so edits match columns by
  // name. This keeps writes correct even when the sheet carries columns that
  // aren't in config.headers (email-tracking columns) or a newer one (Tags),
  // and guarantees an update never clobbers an unrelated column by position.
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const physical = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  for (let i = data.length - 1; i >= 0; i--) {
    const v = data[i][0];
    const iso = v instanceof Date ? v.toISOString() : String(v);
    if (iso !== submittedAtIso) continue;
    const newRow = physical.map((h, idx) => {
      if (idx === 0) return data[i][0];
      if (updates && Object.prototype.hasOwnProperty.call(updates, h)) {
        const val = updates[h];
        return val == null ? '' : val;
      }
      return data[i][idx];
    });
    sheet.getRange(i + 2, 1, 1, lastCol).setValues([newRow]);
    return true;
  }
  return false;
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

/* =============================================================
   RSVP CONFIRMATION EMAIL
   ============================================================= */

const SITE_URL  = 'https://colin-and-lydia-wedding.vercel.app';
const FROM_NAME = 'Colin & Lydia';

/**
 * Sends the confirmation email. Skips silently if no email address is given.
 * Uses MailApp; the first time you re-deploy after adding this you will be
 * prompted to grant Gmail send permission. Free Gmail = 100 sends/day.
 */
function sendRsvpConfirmation_(data) {
  const to = String(data && data.email || '').trim();
  if (!to || !/^\S+@\S+\.\S+$/.test(to)) return;

  const ctx = {
    fullname:    String(data.fullname || 'Friend').trim(),
    firstName:   String(data.fullname || 'Friend').trim().split(/\s+/)[0],
    attending:   String(data.attending || '').toLowerCase() === 'yes',
    plusOne:     String(formatPlusOne_(data.plusOne) || '').trim(),
    transport:   String(data.transport || '').trim(),
    songTitle:   String(data.songTitle || '').trim(),
    songArtist:  String(data.songArtist || '').trim()
  };

  const subject = ctx.attending
    ? 'Your seat is saved \u2014 October 10'
    : 'Thank you for letting us know';

  const html = buildRsvpConfirmEmail_(ctx);
  const textBody = buildRsvpConfirmText_(ctx);

  MailApp.sendEmail({
    to: to,
    subject: subject,
    htmlBody: html,
    body: textBody,
    name: FROM_NAME
  });
}

function buildRsvpConfirmEmail_(c) {
  const transportLabel = {
    drive:    'Driving myself',
    rideshare:'Rideshare / taxi',
    other:    'Other'
  }[c.transport] || (c.transport ? c.transport : '');

  const plusOneLine = c.plusOne
    ? row_('Plus one', escapeHtml_(c.plusOne === 'yes' ? 'Yes (name to follow)' : c.plusOne))
    : '';
  const transportLine = transportLabel
    ? row_('Arriving by', escapeHtml_(transportLabel))
    : '';
  const songLine = c.songTitle
    ? row_('Song request', escapeHtml_(c.songTitle) + (c.songArtist ? ' &mdash; <em style="font-style:italic;color:#5a6476;">' + escapeHtml_(c.songArtist) + '</em>' : ''))
    : '';

  const heroCopy = c.attending
    ? 'It means everything that you\u2019ll be there. We\u2019ll send the final details closer to the day &mdash; until then, save the date and rest up for the dance floor.'
    : 'Thank you for letting us know. We\u2019ll be thinking of you on the tenth, and we\u2019d love to celebrate with you whenever our paths cross next.';

  const ctaLabel = c.attending ? 'Visit the wedding site' : 'See the details';

  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>Your RSVP \u2014 Colin &amp; Lydia</title>',
    '<style>',
    '@import url("https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400;0,6..96,500;1,6..96,400&family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400&family=Inter:wght@400;500;600&display=swap");',
    'body{margin:0;padding:0;background:#f8f4ec;-webkit-font-smoothing:antialiased;}',
    'table{border-collapse:collapse;}',
    'a{color:#1e3a8a;text-decoration:none;}',
    '@media only screen and (max-width:620px){',
    '  .outer-pad{padding:0 0 40px!important;}',
    '  .container{width:100%!important;border:none!important;}',
    '  .px{padding-left:22px!important;padding-right:22px!important;}',
    '  .px-tight{padding-left:22px!important;padding-right:22px!important;padding-top:32px!important;padding-bottom:8px!important;}',
    '  .h1{font-size:28px!important;line-height:1.15!important;}',
    '  .monogram{font-size:60px!important;}',
    '  .label{font-size:9px!important;letter-spacing:.3em!important;}',
    '  .lead{font-size:15px!important;line-height:1.6!important;}',
    '  .section-label{font-size:10px!important;letter-spacing:.2em!important;}',
    '  .reply-row td{display:block!important;width:100%!important;border-bottom:none!important;padding:0!important;}',
    '  .reply-row td.reply-label{padding:14px 0 4px!important;font-size:10px!important;letter-spacing:.2em!important;width:auto!important;}',
    '  .reply-row td.reply-value{padding:0 0 14px!important;font-size:15px!important;border-bottom:1px solid rgba(30,58,138,0.10)!important;}',
    '  .day-display{font-size:28px!important;line-height:1.15!important;}',
    '  .day-venue{font-size:13px!important;}',
    '  .cta-btn{display:block!important;font-size:10px!important;letter-spacing:.28em!important;padding:14px 12px!important;}',
    '  .cta-helper{font-size:12px!important;}',
    '  .signature{font-size:12px!important;}',
    '  .footer-date{font-size:8px!important;letter-spacing:.32em!important;}',
    '  .footer-disclaimer{font-size:11px!important;padding:0 12px!important;}',
    '}',
    '</style></head>',
    '<body style="margin:0;padding:0;background:#f8f4ec;font-family:\'Inter\',-apple-system,BlinkMacSystemFont,\'Helvetica Neue\',Arial,sans-serif;color:#0f1a33;">',
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">',
    (c.attending
      ? 'We\u2019ve saved your seat for October 10 at Calamigos Ranch.'
      : 'We received your reply. Thank you for letting us know.'),
    '</div>',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f4ec;">',
    '<tr><td align="center" class="outer-pad" style="padding:40px 16px;">',
    '<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid rgba(30,58,138,0.18);">',

    '<tr><td class="px" style="padding:48px 56px 12px;text-align:center;">',
    '<div class="label" style="font-family:\'Bodoni Moda\',Georgia,serif;font-size:11px;letter-spacing:.5em;text-transform:uppercase;color:#1e3a8a;">Ten &middot; Ten &middot; 2026</div>',
    '</td></tr>',

    '<tr><td class="px" style="padding:8px 56px 0;text-align:center;">',
    '<div class="monogram" style="font-family:\'Bodoni Moda\',\'Didot\',Georgia,serif;font-weight:400;font-size:96px;line-height:.9;letter-spacing:-0.02em;color:#0f1a33;">C<em style="font-style:italic;font-size:.62em;vertical-align:.18em;color:#1e3a8a;margin:0 6px;">&amp;</em>L</div>',
    '</td></tr>',

    '<tr><td class="px" style="padding:24px 56px 8px;text-align:center;">',
    '<div style="height:1px;background:rgba(30,58,138,0.22);width:60px;margin:0 auto;"></div>',
    '</td></tr>',

    '<tr><td class="px" style="padding:24px 56px 0;text-align:center;">',
    '<h1 class="h1" style="margin:0;font-family:\'Bodoni Moda\',Georgia,serif;font-weight:500;font-size:46px;line-height:1.05;letter-spacing:-0.01em;color:#0f1a33;">',
    (c.attending
      ? 'Your seat is <em style="font-style:italic;color:#1e3a8a;">saved</em>, ' + escapeHtml_(c.firstName) + '.'
      : 'Thank you, <em style="font-style:italic;color:#1e3a8a;">' + escapeHtml_(c.firstName) + '</em>.'),
    '</h1>',
    '</td></tr>',

    '<tr><td class="px" style="padding:18px 56px 0;text-align:center;">',
    '<p class="lead" style="margin:0;font-family:\'Inter\',-apple-system,BlinkMacSystemFont,\'Helvetica Neue\',Arial,sans-serif;font-size:16px;font-weight:400;line-height:1.65;color:#5a6476;">',
    heroCopy,
    '</p>',
    '</td></tr>',

    '<tr><td class="px" style="padding:36px 56px 0;">',
    '<div style="border-top:1px solid rgba(30,58,138,0.18);padding-top:28px;">',
    '<div style="font-family:\'Inter\',-apple-system,BlinkMacSystemFont,\'Helvetica Neue\',Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:#1e3a8a;margin-bottom:14px;" class="section-label">Your Reply</div>',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="reply-table">',
    row_('Name', escapeHtml_(c.fullname)),
    row_('Attending', c.attending
      ? '<span style="color:#1e3a8a;font-weight:500;">Yes</span>'
      : '<span style="color:#5a6476;">Sending love from afar</span>'),
    plusOneLine,
    transportLine,
    songLine,
    '</table>',
    '</div>',
    '</td></tr>',

    '<tr><td class="px" style="padding:36px 56px 0;">',
    '<div style="border-top:1px solid rgba(30,58,138,0.18);padding-top:28px;text-align:center;">',
    '<div style="font-family:\'Inter\',-apple-system,BlinkMacSystemFont,\'Helvetica Neue\',Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:#1e3a8a;margin-bottom:14px;" class="section-label">The Day</div>',
    '<div style="font-family:\'Bodoni Moda\',\'Didot\',Georgia,serif;font-style:italic;font-size:38px;line-height:1.1;color:#0f1a33;letter-spacing:-0.01em;" class="day-display">Saturday, October 10</div>',
    '<div style="font-family:\'Inter\',-apple-system,BlinkMacSystemFont,\'Helvetica Neue\',Arial,sans-serif;font-size:14px;color:#5a6476;margin-top:6px;" class="day-venue">Calamigos Ranch &middot; Malibu, California</div>',
    '</div>',
    '</td></tr>',

    '<tr><td class="px" style="padding:36px 56px 0;text-align:center;">',
    '<a href="' + SITE_URL + '" style="display:inline-block;background:#1e3a8a;color:#f8f4ec;padding:16px 32px;font-family:\'Bodoni Moda\',Georgia,serif;font-size:11px;letter-spacing:.42em;text-transform:uppercase;text-decoration:none;" class="cta-btn">' + ctaLabel + '</a>',
    '<div style="font-family:\'Inter\',-apple-system,BlinkMacSystemFont,\'Helvetica Neue\',Arial,sans-serif;font-size:13px;color:#5a6476;margin-top:14px;" class="cta-helper">Need to change your reply? Just visit the site again.</div>',
    '</td></tr>',

    '<tr><td class="px" style="padding:48px 56px 16px;text-align:center;">',
    '<div style="font-family:\'Bodoni Moda\',Georgia,serif;font-style:italic;font-weight:400;font-size:13px;color:#0f1a33;line-height:1.4;" class="signature">Colin &amp; Lydia &amp; Zoomie</div>',
    '</td></tr>',

    '<tr><td class="px" style="padding:8px 56px 48px;text-align:center;">',
    '<div style="font-family:\'Bodoni Moda\',Georgia,serif;font-size:9px;letter-spacing:.45em;text-transform:uppercase;color:#5a6476;" class="footer-date">10 &middot; 10 &middot; 2026</div>',
    '</td></tr>',

    '</table>',
    '<div style="font-family:\'Inter\',-apple-system,BlinkMacSystemFont,\'Helvetica Neue\',Arial,sans-serif;font-size:12px;color:#8a93a3;margin-top:18px;" class="footer-disclaimer">You received this because you replied to Colin &amp; Lydia\u2019s wedding invitation.</div>',
    '</td></tr>',
    '</table></body></html>'
  ].join('');
}

function row_(label, value) {
  return [
    '<tr class="reply-row"><td class="reply-label" style="padding:12px 0;border-bottom:1px solid rgba(30,58,138,0.10);font-family:\'Inter\',-apple-system,BlinkMacSystemFont,\'Helvetica Neue\',Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:#5a6476;width:130px;vertical-align:top;">',
    label,
    '</td><td class="reply-value" style="padding:12px 0;border-bottom:1px solid rgba(30,58,138,0.10);font-family:\'Inter\',-apple-system,BlinkMacSystemFont,\'Helvetica Neue\',Arial,sans-serif;font-size:15px;font-weight:400;color:#0f1a33;">',
    value,
    '</td></tr>'
  ].join('');
}

function buildRsvpConfirmText_(c) {
  const lines = [
    'Colin & Lydia · October 10, 2026',
    'Calamigos Ranch · Malibu, California',
    '',
    (c.attending
      ? 'Your seat is saved, ' + c.firstName + '.'
      : 'Thank you, ' + c.firstName + '.'),
    '',
    (c.attending
      ? 'It means everything that you\u2019ll be there. We\u2019ll send the final details closer to the day.'
      : 'Thank you for letting us know. We\u2019ll be thinking of you on the tenth.'),
    '',
    'YOUR REPLY',
    '  Name: ' + c.fullname,
    '  Attending: ' + (c.attending ? 'Yes' : 'No')
  ];
  if (c.plusOne)    lines.push('  Plus one: ' + c.plusOne);
  if (c.transport)  lines.push('  Arriving by: ' + c.transport);
  if (c.songTitle)  lines.push('  Song request: ' + c.songTitle + (c.songArtist ? ' — ' + c.songArtist : ''));
  lines.push('', SITE_URL, '', 'With love,', 'Colin & Lydia & Zoomie');
  return lines.join('\n');
}

function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* =============================================================
   ANTHROPIC STYLIST PROXY
   Frontend posts { type:'stylist', mediaType, base64 } and gets back
   { ok:true, text:'...VERDICT/HEADLINE/NOTES...' }.
   Requires Script Property: ANTHROPIC_API_KEY
   ============================================================= */

const STYLIST_MODEL  = 'claude-sonnet-4-5';
const STYLIST_PROMPT =
  'You are a warm, tasteful wedding stylist with a kind but honest voice. ' +
  'A guest is attending a garden-formal wedding at Calamigos Ranch in Malibu on October 10th \u2014 ' +
  'outdoor ceremony on grass, reception in a barn, golden-hour into evening. The dress code is ' +
  'garden-formal / cocktail-to-formal: midi and floor-length dresses, jumpsuits, suits, and elevated ' +
  'separates are all welcome. A wide range of colors, prints, and silhouettes is encouraged \u2014 ' +
  'jewel tones, pastels, florals, metallics, yellows, golds, lace, and chiffon all work beautifully.\n\n' +
  'They have uploaded a photo of an outfit they are considering. Default to YES. Most thoughtful, ' +
  'formal-leaning outfits are appropriate \u2014 only say NO when something is clearly inappropriate.\n\n' +
  'You MUST respond in exactly this format, no preamble:\n\n' +
  'VERDICT: YES  (or NO \u2014 ONLY these two, never "maybe". Pick a side.)\n' +
  'HEADLINE: <five to eight words, punchy and warm \u2014 e.g. "Absolutely wear this." ' +
  'or "Let\'s try something a touch dressier.">\n' +
  'NOTES: <ONE short, warm sentence \u2014 max 20 words. Highlight what works (for YES) or the single ' +
  'specific reason it doesn\'t (for NO). Be concise and never harsh.>\n\n' +
  'Only say NO if the outfit is one of these:\n' +
  '  \u2022 White, ivory, cream, or champagne as the dominant color (reserved for the bride). Yellow, ' +
  'gold, beige, blush, and pastels are NOT bridal \u2014 those are YES.\n' +
  '  \u2022 Clearly casual: jeans, denim, sneakers, t-shirts, hoodies, athleisure, beachwear, sundress ' +
  'in casual cotton.\n' +
  '  \u2022 Club-wear: very short bodycon mini, extreme cutouts, lingerie-like.\n' +
  '  \u2022 Costume or themed (Halloween, cosplay, novelty prints).\n' +
  '  \u2022 All-black head-to-toe in a way that reads funereal or gothic (a chic black cocktail dress ' +
  'is FINE \u2014 that\'s a YES).\n\n' +
  'Everything else is YES. Lace, sheer panels, backless, halter, slip dresses, jumpsuits, suits, bold ' +
  'colors, florals, sequins, and metallics are all welcome at this wedding. When in doubt, lean YES ' +
  'and offer one warm styling thought in NOTES.';

function askStylist_(body) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return { ok: false, error: 'Stylist is not configured yet. Email Lydia and we\'ll take a look.' };
  }

  const mediaType = String(body.mediaType || 'image/jpeg');
  const base64    = String(body.base64 || '');
  if (!base64) {
    return { ok: false, error: 'We couldn\'t read that image. Try a different photo.' };
  }
  if (!/^image\/(jpeg|png|gif|webp)$/.test(mediaType)) {
    return { ok: false, error: 'Please upload a jpg, png, gif, or webp.' };
  }
  if (base64.length > 6 * 1024 * 1024) {
    return { ok: false, error: 'That photo is a bit too large \u2014 try one under ~5MB.' };
  }

  const payload = {
    model: STYLIST_MODEL,
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text',  text: STYLIST_PROMPT }
      ]
    }]
  };

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = res.getResponseCode();
  let parsed;
  try { parsed = JSON.parse(res.getContentText()); } catch (e) { parsed = null; }

  if (status < 200 || status >= 300) {
    const apiMsg = parsed && parsed.error && parsed.error.message;
    console.error('Anthropic stylist failed:', status, apiMsg || res.getContentText());
    return { ok: false, error: 'The stylist isn\'t available right now. Try again in a moment.' };
  }

  const text = parsed && parsed.content && parsed.content[0] && parsed.content[0].text || '';
  if (!text.trim()) {
    return { ok: false, error: 'The stylist didn\'t have much to say about that one. Try a clearer full-body shot in good light.' };
  }
  return { ok: true, text: text };
}

/**
 * Run this ONCE from the Apps Script editor (Run button) to grant the
 * permissions this script needs:
 *   - Spreadsheet access (RSVPs, Gifts, Songs)
 *   - Send email (RSVP confirmations)
 *   - Connect to external service (Anthropic, for the stylist)
 *   - Read script properties (ANTHROPIC_API_KEY, ADMIN_TOKEN)
 *
 * After granting permission, redeploy:
 *   Deploy -> Manage deployments -> pencil icon -> Version: New version -> Deploy
 */
function authorizeAll() {
  SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  MailApp.getRemainingDailyQuota();
  UrlFetchApp.fetch('https://www.google.com/generate_204', { muteHttpExceptions: true });
  console.log('All permissions granted. Now redeploy from Deploy -> Manage deployments.');
}

/**
 * Run from the Apps Script editor to send yourself a sample email.
 * Replace YOUR_EMAIL with your address before running.
 */
function sendTestRsvpEmail() {
  sendRsvpConfirmation_({
    email: 'YOUR_EMAIL@example.com',
    fullname: 'Sample Guest',
    attending: 'yes',
    plusOne: 'Alex Doe',
    transport: 'drive',
    songTitle: 'Love Story',
    songArtist: 'Taylor Swift'
  });
}

/* =============================================================
   DINNER-SELECTION EMAIL BLAST
   -------------------------------------------------------------
   Sends the meal-survey invitation straight from the Sheet — no
   CSV export, no laptop script. Reads guests from the RSVPs sheet,
   emails everyone who has an address, and stamps a "Dinner Emailed
   At" column so re-running only catches people who haven't been
   sent yet. Drive it from the "Wedding" menu that appears when you
   open the spreadsheet (reload the sheet once after deploying).

   Free Gmail limit: 100 recipients/day. If the list is larger the
   run stops at the quota and tells you how many remain.
   ============================================================= */

const DINNER = {
  surveyUrl:     SITE_URL + '/survey',
  rsvpUrl:       SITE_URL + '/RSVP',
  hotelLink:     'https://www.hilton.com/en/attend-my-event/agohwhw-90b-1879cb72-dad9-4e7a-9a57-42c2a1c665e1/',
  partifulLink:  'https://partiful.com/e/uhI2HRJexpkBs4QihIdJ?c=F4ZarFCP',
  hotelName:     'Hilton, Calamigos wedding block (group code 90B)',
  hotelDeadline: 'September 9, 2026',
  mealDeadline:  'July 18, 2026',
  subject:         "Action required: select your dinner for Lydia & Colin's wedding",
  reminderSubject: "Reminder: please pick your dinner for Lydia & Colin's wedding",
  finalSubject:    "Last call: your dinner choice for Lydia & Colin's wedding",
  defaultSubject:  "Your wedding dinner has defaulted to chicken \u2014 change by Aug 1",
  chickenName:     'Garlic Herb Jidori Chicken',
  changeDeadline:  'August 1, 2026',
  contactEmail:    'lydiahongp@gmail.com',
  testRecipient:   'Lydiahongp@gmail.com',
  emailedCol:      'Dinner Emailed At',
  reminderCol:     'Meal Reminder At',
  finalCol:        'Final Notice At',
  defaultCol:      'Default Notice At'
};

/** Adds the "Wedding" menu to the spreadsheet UI. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Wedding')
    .addItem('Dinner email: preview recipients', 'dinnerPreviewRecipients')
    .addItem('Dinner email: send test to me', 'dinnerSendTest')
    .addItem('Dinner email: send test to an address\u2026', 'dinnerSendTestTo')
    .addSeparator()
    .addItem('Dinner email: SEND to all unsent', 'dinnerSendAll')
    .addSeparator()
    .addItem('Meal reminder: preview no-meal-yet', 'dinnerRemindPreview')
    .addItem('Meal reminder: SEND to no-meal-yet', 'dinnerRemindSend')
    .addSeparator()
    .addItem('Final call: preview no-meal-yet', 'finalNoticePreview')
    .addItem('Final call: SEND to no-meal-yet', 'finalNoticeSend')
    .addSeparator()
    .addItem('Default notice: preview no-meal-yet', 'defaultNoticePreview')
    .addItem('Default notice: SEND to no-meal-yet', 'defaultNoticeSend')
    .addToUi();
}

/** Gathers counts + a small sample of who would receive the blast. */
function dinnerRecipientInfo_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.rsvp.name);
  const out = { total: 0, valid: 0, alreadyEmailed: 0, pending: 0,
                quota: MailApp.getRemainingDailyQuota(), sample: [] };
  if (!sheet || sheet.getLastRow() < 2) return out;

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const nameIdx = headers.indexOf('Name');
  const emailIdx = headers.indexOf('Email');
  const emailedIdx = headers.indexOf(DINNER.emailedCol);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();

  const seen = {};
  data.forEach(row => {
    out.total++;
    const email = String(row[emailIdx] || '').trim();
    const name = String(row[nameIdx] || '').trim();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return;
    const key = email.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    out.valid++;
    const already = emailedIdx !== -1 && String(row[emailedIdx] || '').trim();
    if (already) { out.alreadyEmailed++; return; }
    out.pending++;
    if (out.sample.length < 8) out.sample.push('  \u2022 ' + (name || '(no name)') + ' <' + email + '>');
  });
  return out;
}

/** Builds the personalized survey link for one guest. */
function dinnerSurveyUrl_(fullName, email) {
  return DINNER.surveyUrl + '?name=' + encodeURIComponent(fullName || '') +
         '&email=' + encodeURIComponent(email || '');
}

/** Sends a single dinner email. Throws on failure so the caller can record it. */
function sendOneDinnerEmail_(email, fullName, subject, emailOpts) {
  const first = String(fullName || '').trim().split(/\s+/)[0] || 'there';
  const url = dinnerSurveyUrl_(fullName, email);
  const opts = emailOpts || {};
  MailApp.sendEmail({
    to: email,
    subject: subject || DINNER.subject,
    htmlBody: buildDinnerEmail_(first, url, opts),
    body: buildDinnerText_(first, url, opts),
    name: FROM_NAME
  });
}

/**
 * Sends to every guest with a valid email. By default only those who
 * haven't been emailed yet (blank "Dinner Emailed At"). Stamps the column
 * after each successful send and stops cleanly at the daily Gmail quota.
 */
function sendDinnerEmails_(opts) {
  opts = opts || {};
  const onlyUnsent = opts.onlyUnsent !== false;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.rsvp.name);
  if (!sheet || sheet.getLastRow() < 2) {
    return { sent: 0, skipped: 0, failed: [], remainingQuota: MailApp.getRemainingDailyQuota(), notes: ['No RSVP rows.'] };
  }

  let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  if (headers.indexOf(DINNER.emailedCol) === -1) {
    sheet.getRange(1, headers.length + 1).setValue(DINNER.emailedCol);
    headers.push(DINNER.emailedCol);
  }
  const nameIdx = headers.indexOf('Name');
  const emailIdx = headers.indexOf('Email');
  const emailedIdx = headers.indexOf(DINNER.emailedCol);

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  const quota = MailApp.getRemainingDailyQuota();
  const seen = {};
  let sent = 0, skipped = 0;
  const failed = [], notes = [];

  for (let i = 0; i < data.length; i++) {
    const email = String(data[i][emailIdx] || '').trim();
    const name = String(data[i][nameIdx] || '').trim();
    const already = emailedIdx !== -1 && String(data[i][emailedIdx] || '').trim();

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) { skipped++; continue; }
    const key = email.toLowerCase();
    if (seen[key]) { skipped++; continue; }
    if (onlyUnsent && already) { skipped++; continue; }
    seen[key] = true;

    if (sent >= quota) {
      notes.push('Reached today\u2019s Gmail quota (' + quota + '). Run again tomorrow to send the rest.');
      break;
    }
    try {
      sendOneDinnerEmail_(email, name);
      sheet.getRange(i + 2, emailedIdx + 1).setValue(new Date());
      sent++;
    } catch (err) {
      failed.push(email + ': ' + err);
    }
  }
  return { sent: sent, skipped: skipped, failed: failed, remainingQuota: MailApp.getRemainingDailyQuota(), notes: notes };
}

/** Counts + sample of guests who still owe a meal choice (no Entree). */
function reminderRecipientInfo_(col) {
  col = col || DINNER.reminderCol;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.rsvp.name);
  const out = { noMealValidEmail: 0, alreadyReminded: 0, pending: 0, noEmail: 0,
                quota: MailApp.getRemainingDailyQuota(), sample: [] };
  if (!sheet || sheet.getLastRow() < 2) return out;

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const nameIdx = headers.indexOf('Name');
  const emailIdx = headers.indexOf('Email');
  const entreeIdx = headers.indexOf('Entree');
  const remindIdx = headers.indexOf(col);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();

  const seen = {};
  data.forEach(row => {
    const entree = entreeIdx !== -1 ? String(row[entreeIdx] || '').trim() : '';
    if (entree) return;                                  // already chose a meal
    const email = String(row[emailIdx] || '').trim();
    const name = String(row[nameIdx] || '').trim();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) { out.noEmail++; return; }
    const key = email.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    out.noMealValidEmail++;
    const reminded = remindIdx !== -1 && String(row[remindIdx] || '').trim();
    if (reminded) { out.alreadyReminded++; return; }
    out.pending++;
    if (out.sample.length < 10) out.sample.push('  \u2022 ' + (name || '(no name)') + ' <' + email + '>');
  });
  return out;
}

/**
 * Sends a reminder to guests who have a valid email but no Entree yet.
 * Stamps a "Meal Reminder At" column so re-running only catches new stragglers.
 */
function sendMealReminders_(opts) {
  opts = opts || {};
  const onlyUnsent = opts.onlyUnsent !== false;
  const col = opts.col || DINNER.reminderCol;
  const subject = opts.subject || DINNER.reminderSubject;
  const emailOpts = opts.emailOpts || { reminder: true };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.rsvp.name);
  if (!sheet || sheet.getLastRow() < 2) {
    return { sent: 0, skipped: 0, failed: [], remainingQuota: MailApp.getRemainingDailyQuota(), notes: ['No RSVP rows.'] };
  }

  let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  if (headers.indexOf(col) === -1) {
    sheet.getRange(1, headers.length + 1).setValue(col);
    headers.push(col);
  }
  const nameIdx = headers.indexOf('Name');
  const emailIdx = headers.indexOf('Email');
  const entreeIdx = headers.indexOf('Entree');
  const remindIdx = headers.indexOf(col);

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  const quota = MailApp.getRemainingDailyQuota();
  const seen = {};
  let sent = 0, skipped = 0;
  const failed = [], notes = [];

  for (let i = 0; i < data.length; i++) {
    const entree = entreeIdx !== -1 ? String(data[i][entreeIdx] || '').trim() : '';
    const email = String(data[i][emailIdx] || '').trim();
    const name = String(data[i][nameIdx] || '').trim();
    const reminded = remindIdx !== -1 && String(data[i][remindIdx] || '').trim();

    if (entree) { skipped++; continue; }                 // already picked a meal
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) { skipped++; continue; }
    const key = email.toLowerCase();
    if (seen[key]) { skipped++; continue; }
    if (onlyUnsent && reminded) { skipped++; continue; }
    seen[key] = true;

    if (sent >= quota) {
      notes.push('Reached today\u2019s Gmail quota (' + quota + '). Run again tomorrow to send the rest.');
      break;
    }
    try {
      sendOneDinnerEmail_(email, name, subject, emailOpts);
      sheet.getRange(i + 2, remindIdx + 1).setValue(new Date());
      sent++;
    } catch (err) {
      failed.push(email + ': ' + err);
    }
  }
  return { sent: sent, skipped: skipped, failed: failed, remainingQuota: MailApp.getRemainingDailyQuota(), notes: notes };
}

/* ---- Menu handlers (show dialogs) ---- */

function dinnerPreviewRecipients() {
  const info = dinnerRecipientInfo_();
  const ui = SpreadsheetApp.getUi();
  const lines = [
    'RSVP rows: ' + info.total,
    'With a valid email: ' + info.valid,
    'Already emailed: ' + info.alreadyEmailed,
    'Will receive now: ' + info.pending,
    'Gmail quota left today: ' + info.quota,
    '',
    'Sample of who will receive now:'
  ].concat(info.sample.length ? info.sample : ['  (none pending)']);
  ui.alert('Dinner email \u2014 preview', lines.join('\n'), ui.ButtonSet.OK);
}

function dinnerSendTest() {
  const ui = SpreadsheetApp.getUi();
  try {
    sendOneDinnerEmail_(DINNER.testRecipient, 'Lydia Test');
    ui.alert('Test sent', 'A sample dinner email was sent to ' + DINNER.testRecipient + '.', ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Test failed', String(err), ui.ButtonSet.OK);
  }
}

/**
 * Prompts for a recipient and sends a single test email. Accepts either a bare
 * email ("john@example.com") or a name + email ("John Culver <john@example.com>")
 * so the test greeting and survey link look like a real send. Does not touch the sheet.
 */
function dinnerSendTestTo() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt('Send a test dinner email',
    'Enter the recipient. You can include a name:\n\n' +
    '  John Culver <john@example.com>\n\n' +
    'or just the email address.', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  const raw = String(resp.getResponseText() || '').trim();
  let name = '';
  let to = raw;
  const m = raw.match(/^(.*?)<\s*([^>]+?)\s*>\s*$/);
  if (m) { name = m[1].trim(); to = m[2].trim(); }

  if (!/^\S+@\S+\.\S+$/.test(to)) {
    ui.alert('Invalid email', '\u201c' + to + '\u201d doesn\u2019t look like a valid email address.', ui.ButtonSet.OK);
    return;
  }
  try {
    sendOneDinnerEmail_(to, name || 'there');
    ui.alert('Test sent', 'A sample dinner email was sent to ' + (name ? name + ' <' + to + '>' : to) + '.', ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Test failed', String(err), ui.ButtonSet.OK);
  }
}

function dinnerSendAll() {
  const ui = SpreadsheetApp.getUi();
  const info = dinnerRecipientInfo_();
  if (info.pending === 0) {
    ui.alert('Nothing to send', 'No guests are pending. Everyone with an email has already been sent.', ui.ButtonSet.OK);
    return;
  }
  const resp = ui.alert(
    'Send dinner emails',
    'Send to ' + info.pending + ' guest(s) who have an email and haven\u2019t been sent yet?\n\n' +
    'Gmail quota left today: ' + info.quota,
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  const r = sendDinnerEmails_({ onlyUnsent: true });
  const summary = [
    'Sent: ' + r.sent,
    'Skipped (no/dup email or already sent): ' + r.skipped,
    'Failed: ' + r.failed.length,
    'Gmail quota left: ' + r.remainingQuota
  ];
  if (r.failed.length) summary.push('', 'Failures:', ...r.failed.slice(0, 10));
  if (r.notes.length) summary.push('', ...r.notes);
  ui.alert('Dinner email \u2014 done', summary.join('\n'), ui.ButtonSet.OK);
}

function dinnerRemindPreview() {
  const info = reminderRecipientInfo_();
  const ui = SpreadsheetApp.getUi();
  const lines = [
    'No meal yet + valid email: ' + info.noMealValidEmail,
    'Already reminded: ' + info.alreadyReminded,
    'Will be reminded now: ' + info.pending,
    'No meal + no reachable email: ' + info.noEmail,
    'Gmail quota left today: ' + info.quota,
    '',
    'Sample of who will be reminded now:'
  ].concat(info.sample.length ? info.sample : ['  (none pending)']);
  ui.alert('Meal reminder \u2014 preview', lines.join('\n'), ui.ButtonSet.OK);
}

function dinnerRemindSend() {
  const ui = SpreadsheetApp.getUi();
  const info = reminderRecipientInfo_();
  if (info.pending === 0) {
    ui.alert('Nothing to send', 'No one is pending a reminder \u2014 everyone with a valid email has either picked a meal or already been reminded.', ui.ButtonSet.OK);
    return;
  }
  const resp = ui.alert(
    'Send meal reminders',
    'Send a reminder to ' + info.pending + ' guest(s) who have a valid email but haven\u2019t picked a meal yet?\n\n' +
    'Gmail quota left today: ' + info.quota,
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  const r = sendMealReminders_({ onlyUnsent: true });
  const summary = [
    'Reminders sent: ' + r.sent,
    'Skipped (has meal / no-dup email / already reminded): ' + r.skipped,
    'Failed: ' + r.failed.length,
    'Gmail quota left: ' + r.remainingQuota
  ];
  if (r.failed.length) summary.push('', 'Failures:', ...r.failed.slice(0, 10));
  if (r.notes.length) summary.push('', ...r.notes);
  ui.alert('Meal reminder \u2014 done', summary.join('\n'), ui.ButtonSet.OK);
}

function finalNoticePreview() {
  const info = reminderRecipientInfo_(DINNER.finalCol);
  const ui = SpreadsheetApp.getUi();
  const lines = [
    'No meal yet + valid email: ' + info.noMealValidEmail,
    'Already sent final call: ' + info.alreadyReminded,
    'Will be sent now: ' + info.pending,
    'No meal + no reachable email: ' + info.noEmail,
    'Gmail quota left today: ' + info.quota,
    '',
    'Sample of who will receive the final call now:'
  ].concat(info.sample.length ? info.sample : ['  (none pending)']);
  ui.alert('Final call \u2014 preview', lines.join('\n'), ui.ButtonSet.OK);
}

function finalNoticeSend() {
  const ui = SpreadsheetApp.getUi();
  const info = reminderRecipientInfo_(DINNER.finalCol);
  if (info.pending === 0) {
    ui.alert('Nothing to send', 'No one is pending a final call \u2014 everyone with a valid email has either picked a meal or already been sent one.', ui.ButtonSet.OK);
    return;
  }
  const resp = ui.alert(
    'Send final call',
    'Send a final-call email to ' + info.pending + ' guest(s) who have a valid email but haven\u2019t picked a meal yet?\n\n' +
    'This tells them today is the last day and their entree will default to ' + DINNER.chickenName + '.\n\n' +
    'Gmail quota left today: ' + info.quota,
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  const r = sendMealReminders_({
    onlyUnsent: true,
    col: DINNER.finalCol,
    subject: DINNER.finalSubject,
    emailOpts: { finalNotice: true }
  });
  const summary = [
    'Final calls sent: ' + r.sent,
    'Skipped (has meal / dup email / already sent): ' + r.skipped,
    'Failed: ' + r.failed.length,
    'Gmail quota left: ' + r.remainingQuota
  ];
  if (r.failed.length) summary.push('', 'Failures:', ...r.failed.slice(0, 10));
  if (r.notes.length) summary.push('', ...r.notes);
  ui.alert('Final call \u2014 done', summary.join('\n'), ui.ButtonSet.OK);
}

function defaultNoticePreview() {
  const info = reminderRecipientInfo_(DINNER.defaultCol);
  const ui = SpreadsheetApp.getUi();
  const lines = [
    'No meal yet + valid email: ' + info.noMealValidEmail,
    'Already sent default notice: ' + info.alreadyReminded,
    'Will be sent now: ' + info.pending,
    'No meal + no reachable email: ' + info.noEmail,
    'Gmail quota left today: ' + info.quota,
    '',
    'Sample of who will receive the default notice now:'
  ].concat(info.sample.length ? info.sample : ['  (none pending)']);
  ui.alert('Default notice \u2014 preview', lines.join('\n'), ui.ButtonSet.OK);
}

function defaultNoticeSend() {
  const ui = SpreadsheetApp.getUi();
  const info = reminderRecipientInfo_(DINNER.defaultCol);
  if (info.pending === 0) {
    ui.alert('Nothing to send', 'No one is pending a default notice \u2014 everyone with a valid email has either picked a meal or already been sent one.', ui.ButtonSet.OK);
    return;
  }
  const resp = ui.alert(
    'Send default notice',
    'Send a \u201cdefaulted to chicken\u201d notice to ' + info.pending + ' guest(s) who have a valid email but haven\u2019t picked a meal yet?\n\n' +
    'This tells them their entree is now the ' + DINNER.chickenName + ' and to email ' + DINNER.contactEmail + ' before ' + DINNER.changeDeadline + ' to change it.\n\n' +
    'Gmail quota left today: ' + info.quota,
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  const r = sendMealReminders_({
    onlyUnsent: true,
    col: DINNER.defaultCol,
    subject: DINNER.defaultSubject,
    emailOpts: { defaultNotice: true }
  });
  const summary = [
    'Default notices sent: ' + r.sent,
    'Skipped (has meal / dup email / already sent): ' + r.skipped,
    'Failed: ' + r.failed.length,
    'Gmail quota left: ' + r.remainingQuota
  ];
  if (r.failed.length) summary.push('', 'Failures:', ...r.failed.slice(0, 10));
  if (r.notes.length) summary.push('', ...r.notes);
  ui.alert('Default notice \u2014 done', summary.join('\n'), ui.ButtonSet.OK);
}

/* ---- Email template (ported from send_emails.py, Gmail-safe) ---- */

function _dinnerDot_(color) {
  return '<td width="18" style="width:18px;height:18px;background:' + color +
         ';border-radius:50%;font-size:0;line-height:0;">&nbsp;</td>' +
         '<td width="6" style="width:6px;font-size:0;line-height:0;">&nbsp;</td>';
}

function _dinnerSwatchRow_(colors) {
  const cells = colors.map(_dinnerDot_).join('');
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="left" ' +
         'style="margin:0;"><tr>' + cells + '</tr></table>';
}

function buildDinnerEmail_(firstName, surveyUrl, opts) {
  opts = opts || {};
  const BG = '#f8f4ec', BAND = '#efe8d9', CARD = '#faf7f0', BORDER = '#ddd6c8';
  const INK = '#0f1a33', SECOND = '#5a6476', MUTED = '#8a8070', BLUE = '#1e3a8a';
  const SERIF = "Georgia, 'Times New Roman', serif";
  const SANS = "Arial, Helvetica, sans-serif";

  const surveyHref = String(surveyUrl).replace(/&/g, '&amp;');
  const hotelHref = DINNER.hotelLink.replace(/&/g, '&amp;');
  const partifulHref = DINNER.partifulLink.replace(/&/g, '&amp;');
  const rsvpHref = DINNER.rsvpUrl.replace(/&/g, '&amp;');
  const gents = _dinnerSwatchRow_(['#1b2a4a', '#111418', '#36454f']);
  const ladies = _dinnerSwatchRow_(['#ff7f6b', '#9caf88', '#e8a0b4', '#eaa221', '#b8a4d4', '#3a9a9a', '#c66b4a']);
  const fn = escapeHtml_(firstName);
  const hotelName = escapeHtml_(DINNER.hotelName);
  const leadText = opts.defaultNotice
    ? `Without a response, your dinner entree has been set to the <strong>${escapeHtml_(DINNER.chickenName)}</strong> by default. If you&rsquo;d like a different entree, please email <a href="mailto:${DINNER.contactEmail}" style="color:${BLUE};text-decoration:none;">${DINNER.contactEmail}</a> before <strong>${DINNER.changeDeadline}</strong>.`
    : opts.finalNotice
    ? `This is a friendly last call. Today is the <strong>last day</strong> to choose your dinner entree. Without a response, your entree will default to the <strong>${escapeHtml_(DINNER.chickenName)}</strong>.`
    : opts.reminder
    ? `Just a friendly reminder that we haven&rsquo;t received your dinner choice yet. Please select your dinner entree by <strong>${DINNER.mealDeadline}</strong> so we can share your preference with our caterer.`
    : `Please select your dinner entree by <strong>${DINNER.mealDeadline}</strong> so we can share your preference with our caterer.`;
  const eyebrow = opts.defaultNotice ? 'Your dinner selection' : 'One thing we need from you';
  const ctaLabel = 'Select your dinner';
  // The default-notice email has no CTA button — the guest is told to email
  // instead, so the survey button is omitted for that variant only.
  const ctaButton = opts.defaultNotice ? '' :
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
          <td style="background:${BLUE};">
            <a href="${surveyHref}" style="display:inline-block;font-family:${SANS};font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${BG};text-decoration:none;padding:15px 34px;">${ctaLabel}</a>
          </td>
        </tr></table>`;
  // Default-notice email omits the "don't forward" line (there's no
  // personalized action to protect); other variants keep it.
  const forwardLead = opts.defaultNotice ? '' : 'Please don&rsquo;t forward this email. ';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  @media only screen and (max-width:600px) {
    .email-container { width:100% !important; max-width:100% !important; }
    .m-body { font-size:18px !important; line-height:1.6 !important; }
    .m-lead { font-size:19px !important; }
    .m-desc { font-size:16px !important; }
    .m-label { font-size:12px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${BG};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};">
<tr><td align="center" style="padding:32px 0;">
<table role="presentation" class="email-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${BG};">

  <!-- 1. HEADER -->
  <tr><td align="center" style="padding:32px 40px 0;">
    <div style="font-family:${SANS};font-size:11px;letter-spacing:3px;text-transform:uppercase;color:${BLUE};">October 10, 2026 &middot; Calamigos Ranch, Malibu</div>
    <div style="font-family:${SERIF};font-style:italic;font-size:44px;color:${INK};padding:16px 0 0;">Colin &amp; Lydia</div>
    <div style="font-size:0;line-height:0;padding:22px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td width="48" style="width:48px;height:1px;background:${BLUE};opacity:0.3;font-size:0;line-height:0;">&nbsp;</td></tr></table></div>
    <div class="m-body" style="font-family:${SERIF};font-size:15px;color:#2a3347;line-height:1.5;">Hi ${fn},</div>
  </td></tr>

  <!-- 2. CTA BAND -->
  <tr><td style="padding:28px 0 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BAND};">
      <tr><td align="center" style="padding:30px 40px;">
        <div style="font-family:${SANS};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${BLUE};margin-bottom:12px;">${eyebrow}</div>
        <div class="m-lead" style="font-family:${SERIF};font-size:16px;color:${INK};line-height:1.55;margin-bottom:22px;">${leadText}</div>
        ${ctaButton}
        <div style="font-family:${SERIF};font-size:13px;font-style:italic;color:${MUTED};line-height:1.5;margin-top:18px;">${forwardLead}If your plus-one hasn&rsquo;t received an email, please contact <a href="mailto:lydiahongp@gmail.com" style="color:${BLUE};text-decoration:none;">lydiahongp@gmail.com</a>.</div>
      </td></tr>
    </table>
  </td></tr>

  <!-- 3. HOTEL BLOCK -->
  <tr><td style="padding:28px 40px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CARD};border:1px solid ${BORDER};">
      <tr><td style="padding:22px 24px;">
        <div style="font-family:${SANS};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${BLUE};margin-bottom:10px;">Hotel block</div>
        <div style="font-family:${SERIF};font-size:16px;color:${INK};margin-bottom:6px;">${hotelName}</div>
        <div style="font-family:${SERIF};font-size:14px;color:${SECOND};margin-bottom:14px;">Book by ${DINNER.hotelDeadline} to hold the group rate.</div>
        <a href="${hotelHref}" style="font-family:${SANS};font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${BLUE};text-decoration:none;">Book your room &rarr;</a>
      </td></tr>
    </table>
  </td></tr>

  <!-- 4. DRESS CODE -->
  <tr><td style="padding:28px 40px 0;">
    <div style="font-family:${SANS};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${BLUE};margin-bottom:16px;">Dress code</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${BORDER};"><tr>
      <td width="50%" valign="top" align="left" style="padding:30px 22px;">
        <div style="font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${BLUE};margin-bottom:14px;">Gentlemen</div>
        <div style="font-family:${SERIF};font-size:15px;color:${SECOND};margin-bottom:16px;white-space:nowrap;">A <strong style="color:${INK};">dark suit</strong></div>
        ${gents}
      </td>
      <td width="50%" valign="top" align="left" style="padding:30px 22px;border-left:1px solid ${BORDER};">
        <div style="font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${BLUE};margin-bottom:14px;">Ladies</div>
        <div style="font-family:${SERIF};font-size:15px;color:${SECOND};margin-bottom:16px;white-space:nowrap;">A long dress in a <strong style="color:${INK};">summer color</strong></div>
        ${ladies}
      </td>
    </tr></table>
  </td></tr>

  <!-- 5. DAY OF -->
  <tr><td style="padding:28px 40px 0;">
    <div style="font-family:${SANS};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${BLUE};margin-bottom:16px;">Day of</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CARD};border:1px solid ${BORDER};">
      <tr><td style="padding:16px 22px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="90" valign="middle" style="font-family:${SANS};font-size:11px;font-weight:bold;color:${BLUE};padding:8px 0;">4:45 pm</td>
            <td valign="middle" style="font-family:${SERIF};font-size:15px;color:${INK};padding:8px 0;">Guest arrival starts</td>
          </tr>
          <tr>
            <td width="90" valign="middle" style="font-family:${SANS};font-size:11px;font-weight:bold;color:${BLUE};padding:8px 0;border-top:1px solid ${BORDER};">5:30 pm</td>
            <td valign="middle" style="font-family:${SERIF};font-size:15px;color:${INK};padding:8px 0;border-top:1px solid ${BORDER};">Ceremony starts</td>
          </tr>
          <tr>
            <td width="90" valign="middle" style="font-family:${SANS};font-size:11px;font-weight:bold;color:${BLUE};padding:8px 0;border-top:1px solid ${BORDER};">11:30 pm</td>
            <td valign="middle" style="font-family:${SERIF};font-size:15px;color:${INK};padding:8px 0;border-top:1px solid ${BORDER};">Reception ends</td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>

  <!-- 6. STAY IN THE LOOP -->
  <tr><td style="padding:28px 40px 0;" align="center">
    <div style="font-family:${SANS};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${BLUE};margin-bottom:14px;text-align:left;">Stay in the loop</div>
    <div class="m-body" style="font-family:${SERIF};font-size:15px;color:${SECOND};line-height:1.6;margin:0 0 22px;text-align:left;">Partiful is our home base for the wedding. It&rsquo;s the place to ask questions, catch updates, and stay connected with us leading up to the big day.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${BORDER};margin-bottom:24px;"><tr>
      <td width="33%" valign="top" align="left" style="padding:24px 14px;">
        <div style="font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${BLUE};margin-bottom:10px;">Ask Questions</div>
        <div class="m-desc" style="font-family:${SERIF};font-size:14px;color:${SECOND};line-height:1.5;">Anything about the day? We&rsquo;re happy to help.</div>
      </td>
      <td width="34%" valign="top" align="left" style="padding:24px 14px;border-left:1px solid ${BORDER};">
        <div style="font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${BLUE};margin-bottom:10px;">Find a Carpool</div>
        <div class="m-desc" style="font-family:${SERIF};font-size:14px;color:${SECOND};line-height:1.5;">Coordinate rides with other guests heading to Malibu.</div>
      </td>
      <td width="33%" valign="top" align="left" style="padding:24px 14px;border-left:1px solid ${BORDER};">
        <div style="font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${BLUE};margin-bottom:10px;">Day-of Updates</div>
        <div class="m-desc" style="font-family:${SERIF};font-size:14px;color:${SECOND};line-height:1.5;">Timing, weather, and any last-minute notes.</div>
      </td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="center" style="background:${BLUE};">
        <a href="${partifulHref}" style="display:block;font-family:${SANS};font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${BG};text-decoration:none;padding:15px 34px;text-align:center;">Join us on Partiful</a>
      </td>
    </tr></table>
  </td></tr>

  <!-- 7. FOOTER -->
  <tr><td style="padding:28px 0 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BAND};">
      <tr><td align="center" style="padding:28px 40px;">
        <div style="font-family:${SERIF};font-style:italic;font-size:18px;color:${INK};">With love</div>
        <div style="font-family:${SANS};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${MUTED};margin-top:10px;">Colin &amp; Lydia &middot; 10.10.2026</div>
        <div style="margin-top:16px;"><a href="${rsvpHref}" style="font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${BLUE};text-decoration:none;">Visit our wedding website &rarr;</a></div>
      </td></tr>
    </table>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

function buildDinnerText_(firstName, surveyUrl, opts) {
  opts = opts || {};
  const oneThing = opts.defaultNotice
    ? "YOUR DINNER SELECTION: Without a response, your dinner entree has been set to the " + DINNER.chickenName + " by default. If you'd like a different entree, email " + DINNER.contactEmail + " before " + DINNER.changeDeadline + "."
    : opts.finalNotice
    ? "ONE THING WE NEED FROM YOU: This is a friendly last call. Today is the last day to choose your dinner entree. Without a response, your entree will default to the " + DINNER.chickenName + "."
    : opts.reminder
    ? "ONE THING WE NEED FROM YOU: Just a friendly reminder that we haven't received your dinner choice yet. Please select your dinner entree by " + DINNER.mealDeadline + '.'
    : 'ONE THING WE NEED FROM YOU: Please select your dinner entree by ' + DINNER.mealDeadline + '.';
  return [
    'Colin & Lydia \u00b7 October 10, 2026 \u00b7 Calamigos Ranch, Malibu',
    '',
    'Hi ' + firstName + ',',
    '',
    oneThing,
    'Select your dinner: ' + surveyUrl,
    '',
    (opts.defaultNotice ? '' : "Please don't forward this email. ") + "If your plus-one hasn't received an email, please contact lydiahongp@gmail.com.",
    '',
    'HOTEL BLOCK: ' + DINNER.hotelName + '. Book by ' + DINNER.hotelDeadline + ': ' + DINNER.hotelLink,
    '',
    'Stay in the loop on Partiful: ' + DINNER.partifulLink,
    '',
    'Visit our wedding website: ' + DINNER.rsvpUrl,
    '',
    'With love, Colin & Lydia \u00b7 10.10.2026'
  ].join('\n');
}
