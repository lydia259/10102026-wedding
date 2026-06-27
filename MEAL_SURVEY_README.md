# Dinner survey + email blast

Two pieces, wired into the wedding site's existing Google Apps Script + Google
Sheets backend (no separate server or database):

1. **`send_emails.py`** — a Gmail mail-merge that emails each guest a personalized
   link to the dinner survey.
2. **`survey.html`** — the guest-facing survey. It writes the entree choice
   straight back to the **RSVPs** Google Sheet, so selections show up in your
   existing `admin.html`.

## How it fits together

```
send_emails.py  ──email──►  guest  ──clicks──►  survey.html
                                                     │ POST {type:'meal', ...}
                                                     ▼
                                   Apps Script (Code.gs)  ──►  RSVPs sheet
                                                                  │
                                                          admin.html shows it
```

## 1. Backend (Apps Script) — one-time deploy

`apps-script/Code.gs` now has:
- `Entree` and `Dietary` columns on the RSVPs sheet.
- A `type:'meal'` handler that finds the guest's row by email and writes their
  entree + dietary note (or appends a row if the email isn't found yet).

Re-deploy so it goes live:
1. Open the Apps Script project → paste the updated `Code.gs`.
2. **Deploy → Manage deployments → (pencil) → Version: New version → Deploy.**
   (Re-using the same deployment keeps the existing `/exec` URL, so no frontend
   change is needed.)

The `Entree`/`Dietary` columns are added automatically the first time a survey
is submitted — no manual sheet editing required.

## 2. Survey page

`survey.html` is static — it deploys with the rest of the site to Vercel and is
reachable at `https://colin-and-lydia-wedding.vercel.app/survey`.

- If the link includes `?name=...&email=...` (as the email sends), the name/email
  fields are hidden and the greeting is personalized.
- If those params are missing (forwarded link), it falls back to name + email
  inputs so it never breaks.
- It reads the backend URL from `assets/wedding-config.js` (same as RSVP.html).

Test locally: `http://localhost:3002/survey?name=Troy%20Koyama&email=you@gmail.com`

## 3. Email blast — `send_emails.py`

No third-party packages needed (pure Python standard library).

**Setup**
1. Create a Gmail **App Password** (needs 2-Step Verification on the account):
   <https://myaccount.google.com/apppasswords>
2. In `send_emails.py`, set `GMAIL_ADDRESS` and `GMAIL_APP_PASS`.
3. Export your guest list from the **RSVPs** Google Sheet to `rsvps.csv` with
   columns: `First Name`, `Last Name`, `Email`.

**Trigger / test**
- **Preview (no send):** keep `DRY_RUN = True` → `python send_emails.py`.
  Prints every recipient + their link and writes `preview.html` to open.
- **Test to yourself:** set `TEST_RECIPIENTS = ["you@gmail.com"]`, `DRY_RUN = False`,
  run again. The CSV is ignored while `TEST_RECIPIENTS` is set.
- **Real blast:** `TEST_RECIPIENTS = []`, `DRY_RUN = False`, `python send_emails.py`.
  Sends with a 1.5s delay between messages.

**Edge cases handled**
- Missing email in CSV → skipped and logged.
- Duplicate emails → first occurrence used.
- Missing URL params on the survey → falls back to manual name/email entry.
- Per-guest send failure → logged, the rest keep going.

## Notes / things to confirm
- `HOTEL_NAME` in `send_emails.py` is a placeholder — set the exact property name.
- Hotel booking deadline is set to **Sep 9** (matches the website); the original
  spec said Sep 1. Meal deadline is **July 18, 2026**.
- Free Gmail SMTP caps around ~500 recipients/day.
- `rsvps.csv` may contain guest emails — keep it out of public commits if needed.
