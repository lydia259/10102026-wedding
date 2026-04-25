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

    if (type === 'stylist') {
      return jsonOut_(askStylist_(body));
    }

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
      try { sendRsvpConfirmation_(body); } catch (mailErr) {
        console.error('RSVP email failed:', mailErr);
      }
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
    '@import url("https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400;0,6..96,500;1,6..96,400&family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400&display=swap");',
    'body{margin:0;padding:0;background:#f8f4ec;-webkit-font-smoothing:antialiased;}',
    'table{border-collapse:collapse;}',
    'a{color:#1e3a8a;text-decoration:none;}',
    '@media only screen and (max-width:620px){',
    '  .container{width:100%!important;}',
    '  .px{padding-left:24px!important;padding-right:24px!important;}',
    '  .h1{font-size:38px!important;line-height:1.05!important;}',
    '  .monogram{font-size:64px!important;}',
    '  .label{font-size:9px!important;letter-spacing:.32em!important;}',
    '  .lead{font-size:17px!important;}',
    '  .reply-row td{padding:10px 0!important;font-size:15px!important;}',
    '}',
    '</style></head>',
    '<body style="margin:0;padding:0;background:#f8f4ec;font-family:\'Cormorant Garamond\',Georgia,serif;color:#0f1a33;">',
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">',
    (c.attending
      ? 'We\u2019ve saved your seat for October 10 at Calamigos Ranch.'
      : 'We received your reply. Thank you for letting us know.'),
    '</div>',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f4ec;">',
    '<tr><td align="center" style="padding:40px 16px;">',
    '<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#fbf7ec;border:1px solid rgba(30,58,138,0.18);">',

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
    '<h1 class="h1" style="margin:0;font-family:\'Bodoni Moda\',Georgia,serif;font-weight:400;font-size:46px;line-height:1.05;letter-spacing:-0.01em;color:#0f1a33;">',
    (c.attending
      ? 'Your seat is <em style="font-style:italic;color:#1e3a8a;">saved</em>, ' + escapeHtml_(c.firstName) + '.'
      : 'Thank you, <em style="font-style:italic;color:#1e3a8a;">' + escapeHtml_(c.firstName) + '</em>.'),
    '</h1>',
    '</td></tr>',

    '<tr><td class="px" style="padding:18px 56px 0;text-align:center;">',
    '<p class="lead" style="margin:0;font-family:\'Cormorant Garamond\',Georgia,serif;font-size:18px;font-style:italic;line-height:1.65;color:#5a6476;">',
    heroCopy,
    '</p>',
    '</td></tr>',

    '<tr><td class="px" style="padding:36px 56px 0;">',
    '<div style="border-top:1px solid rgba(30,58,138,0.18);padding-top:28px;">',
    '<div style="font-family:\'Bodoni Moda\',Georgia,serif;font-size:10px;letter-spacing:.4em;text-transform:uppercase;color:#1e3a8a;margin-bottom:14px;">Your Reply</div>',
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
    '<div style="font-family:\'Bodoni Moda\',Georgia,serif;font-size:10px;letter-spacing:.4em;text-transform:uppercase;color:#1e3a8a;margin-bottom:14px;">The Day</div>',
    '<div style="font-family:\'Bodoni Moda\',\'Didot\',Georgia,serif;font-style:italic;font-size:38px;line-height:1.1;color:#0f1a33;letter-spacing:-0.01em;">Saturday, October 10</div>',
    '<div style="font-family:\'Cormorant Garamond\',Georgia,serif;font-size:17px;color:#5a6476;margin-top:6px;">Calamigos Ranch &middot; Malibu, California</div>',
    '</div>',
    '</td></tr>',

    '<tr><td class="px" style="padding:36px 56px 0;text-align:center;">',
    '<a href="' + SITE_URL + '" style="display:inline-block;background:#1e3a8a;color:#f8f4ec;padding:16px 32px;font-family:\'Bodoni Moda\',Georgia,serif;font-size:11px;letter-spacing:.42em;text-transform:uppercase;text-decoration:none;">' + ctaLabel + '</a>',
    '<div style="font-family:\'Cormorant Garamond\',Georgia,serif;font-style:italic;font-size:14px;color:#5a6476;margin-top:14px;">Need to change your reply? Just visit the site again.</div>',
    '</td></tr>',

    '<tr><td class="px" style="padding:48px 56px 16px;text-align:center;">',
    '<div style="font-family:\'Bodoni Moda\',Georgia,serif;font-style:italic;font-size:24px;color:#0f1a33;line-height:1.4;">Colin &amp; Lydia &amp; Zoomie</div>',
    '</td></tr>',

    '<tr><td class="px" style="padding:8px 56px 48px;text-align:center;">',
    '<div style="font-family:\'Bodoni Moda\',Georgia,serif;font-size:9px;letter-spacing:.45em;text-transform:uppercase;color:#5a6476;">10 &middot; 10 &middot; 2026</div>',
    '</td></tr>',

    '</table>',
    '<div style="font-family:\'Cormorant Garamond\',Georgia,serif;font-size:12px;color:#8a93a3;margin-top:18px;font-style:italic;">You received this because you replied to Colin &amp; Lydia\u2019s wedding invitation.</div>',
    '</td></tr>',
    '</table></body></html>'
  ].join('');
}

function row_(label, value) {
  return [
    '<tr class="reply-row"><td style="padding:12px 0;border-bottom:1px solid rgba(30,58,138,0.10);font-family:\'Bodoni Moda\',Georgia,serif;font-size:10px;letter-spacing:.3em;text-transform:uppercase;color:#5a6476;width:130px;vertical-align:top;">',
    label,
    '</td><td style="padding:12px 0;border-bottom:1px solid rgba(30,58,138,0.10);font-family:\'Cormorant Garamond\',Georgia,serif;font-size:17px;color:#0f1a33;">',
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
  'outdoor ceremony on grass, reception in a barn, golden-hour to evening. They have uploaded a photo ' +
  'of an outfit they are considering. You MUST respond in exactly this format, no preamble:\n\n' +
  'VERDICT: YES  (or NO \u2014 ONLY these two, never "maybe" or anything else. You must pick a side.)\n' +
  'HEADLINE: <five to eight words, punchy, capturing the verdict \u2014 e.g. "Absolutely wear this." ' +
  'or "Let\'s try something lighter.">\n' +
  'NOTES: <ONE short, warm sentence \u2014 max 20 words. Note the single most important thing about ' +
  'the outfit (color, formality, or fit for the setting). Be concise.>\n\n' +
  'Be decisive, and err on the side of NO when in doubt. Say NO (kindly, never harsh) if the outfit is: ' +
  'too gothic or heavy/black-dominant, too casual (jeans, sneakers, t-shirts, sundress, athleisure), ' +
  'club-wear, overly revealing, white/ivory/cream (reserved for the bride), anything that reads costume ' +
  'or themed, or just generally not formal enough for a garden-formal wedding. YES means genuinely fully ' +
  'appropriate. Frame NO as encouragement ("this would be perfect for another night \u2014 for the ' +
  'wedding let\'s try\u2026"). Never hedge.';

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
