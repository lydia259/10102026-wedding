#!/usr/bin/env python3
"""
Wedding dinner-survey email blast (Gmail SMTP mail merge).

Reads a guest list CSV and sends each guest a branded, Gmail-safe HTML email
with a personalized link to the dinner-selection survey. The survey writes the
guest's entree choice straight back to the wedding's Google Sheet (via the
existing Apps Script backend), so there is no separate database here.

QUICK START
-----------
1. Fill in GMAIL_ADDRESS and GMAIL_APP_PASS below.
   - The app password is NOT your normal password. Create one at
     https://myaccount.google.com/apppasswords (requires 2-Step Verification).
2. Export your guest list from the RSVPs Google Sheet to rsvps.csv with the
   columns: "First Name", "Last Name", "Email".
3. Preview without sending:        python send_emails.py        (DRY_RUN = True)
   -> prints every recipient + writes preview.html you can open in a browser.
4. Send a test only to yourself:   set TEST_RECIPIENTS = ["you@gmail.com"],
   set DRY_RUN = False, run again. The CSV is ignored while TEST_RECIPIENTS is set.
5. Real blast:                     TEST_RECIPIENTS = [], DRY_RUN = False, run.

No third-party packages required — this uses only the Python standard library.
"""

import csv
import os
import smtplib
import ssl
import sys
import time
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from urllib.parse import quote

# ======================================================================
# CONFIG
# ======================================================================
# Read from environment so your app password is never written into this file
# (and never committed). Set them inline when you run, e.g.:
#   GMAIL_ADDRESS="you@gmail.com" GMAIL_APP_PASS="abcd efgh ijkl mnop" python3 send_emails.py
GMAIL_ADDRESS  = os.environ.get("GMAIL_ADDRESS", "your@gmail.com")
GMAIL_APP_PASS = os.environ.get("GMAIL_APP_PASS", "xxxx xxxx xxxx xxxx")  # Gmail App Password, NOT your login password
FROM_NAME      = "Colin & Lydia"

CSV_PATH       = "rsvps.csv"
SURVEY_URL     = "https://colin-and-lydia-wedding.vercel.app/survey"
RSVP_URL       = "https://colin-and-lydia-wedding.vercel.app/RSVP"
HOTEL_LINK     = "https://www.hilton.com/en/attend-my-event/agohwhw-90b-1879cb72-dad9-4e7a-9a57-42c2a1c665e1/"
PARTIFUL_LINK  = "https://partiful.com/e/uhI2HRJexpkBs4QihIdJ?c=F4ZarFCP"

# Content knobs (edit freely)
HOTEL_NAME      = "Hilton — Calamigos wedding block (group code 90B)"
HOTEL_DEADLINE  = "September 9, 2026"       # matches the cut-off on the website
MEAL_DEADLINE   = "July 18, 2026"
SUBJECT         = "Action required: select your dinner for Lydia & Colin's wedding"

# Sending controls
DRY_RUN         = False                     # True = print/preview only, send nothing
SEND_DELAY_SEC  = 1.5                       # pause between sends (Gmail rate limits)

# When non-empty, the CSV is ignored and the email is sent ONLY to these
# addresses (with the name below). Use this to land a real test in your inbox.
TEST_RECIPIENTS = ["Lydiahongp@gmail.com"]  # e.g. ["you@gmail.com"]
TEST_NAME       = "Lydia"

# ======================================================================
# PALETTE (kept in one place so the template stays consistent)
# ======================================================================
C_BG       = "#f8f4ec"
C_BAND     = "#efe8d9"
C_CARD     = "#faf7f0"
C_BORDER   = "#ddd6c8"
C_INK      = "#0f1a33"
C_SECOND   = "#5a6476"
C_MUTED    = "#8a8070"
C_BLUE     = "#1e3a8a"

SERIF = "Georgia, 'Times New Roman', serif"
SANS  = "Arial, Helvetica, sans-serif"


# ======================================================================
# EMAIL HTML (Gmail-safe: table layout, fully inline styles, system fonts)
# ======================================================================
def _dot(color):
    """One round colour swatch (mirrors the website's .attire-swatch-dot)."""
    return (
        f'<td width="18" style="width:18px;height:18px;background:{color};'
        f'border-radius:50%;font-size:0;line-height:0;">&nbsp;</td>'
        f'<td width="6" style="width:6px;font-size:0;line-height:0;">&nbsp;</td>'
    )


def _swatch_row(colors):
    cells = "".join(_dot(c) for c in colors)
    return (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="left" '
        f'style="margin:0;"><tr>{cells}</tr></table>'
    )


def build_html(first_name, survey_url):
    # HTML-escape ampersands in URLs used inside href="" attributes. A raw &
    # is invalid in HTML and some clients (notably Gmail) can mangle the link.
    survey_href = survey_url.replace("&", "&amp;")
    hotel_href = HOTEL_LINK.replace("&", "&amp;")
    partiful_href = PARTIFUL_LINK.replace("&", "&amp;")

    gents_swatches  = _swatch_row(["#1b2a4a", "#111418", "#36454f"])
    ladies_swatches = _swatch_row(
        ["#ff7f6b", "#9caf88", "#e8a0b4", "#eaa221", "#b8a4d4", "#3a9a9a", "#c66b4a"])

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body {{ -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }}
  @media only screen and (max-width:600px) {{
    .email-container {{ width:100% !important; max-width:100% !important; }}
    .m-body {{ font-size:18px !important; line-height:1.6 !important; }}
    .m-lead {{ font-size:19px !important; }}
    .m-desc {{ font-size:16px !important; }}
    .m-label {{ font-size:12px !important; }}
  }}
</style>
</head>
<body style="margin:0;padding:0;background:{C_BG};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{C_BG};">
<tr><td align="center" style="padding:32px 0 0;">
<table role="presentation" class="email-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:{C_BG};">

  <!-- 1. HEADER -->
  <tr><td align="center" style="padding:32px 40px 0;">
    <div style="font-family:{SANS};font-size:11px;letter-spacing:3px;text-transform:uppercase;color:{C_BLUE};">October 10, 2026 &middot; Calamigos Ranch, Malibu</div>
    <div style="font-family:{SERIF};font-style:italic;font-size:44px;color:{C_INK};padding:16px 0 0;">Colin &amp; Lydia</div>
    <div style="font-size:0;line-height:0;padding:22px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td width="48" style="width:48px;height:1px;background:{C_BLUE};opacity:0.3;font-size:0;line-height:0;">&nbsp;</td></tr></table></div>
    <div class="m-body" style="font-family:{SERIF};font-size:17px;color:#2a3347;line-height:1.5;">Hi {first_name},</div>
  </td></tr>

  <!-- 2. CTA BAND -->
  <tr><td style="padding:28px 0 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{C_BAND};">
      <tr><td align="center" style="padding:30px 40px;">
        <div style="font-family:{SANS};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:{C_BLUE};margin-bottom:12px;">One thing we need from you</div>
        <div class="m-lead" style="font-family:{SERIF};font-size:17px;color:{C_INK};line-height:1.55;margin-bottom:22px;">Please select your dinner entree by {MEAL_DEADLINE} so we can share your preference with our caterer.</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
          <td style="background:{C_BLUE};">
            <a href="{survey_href}" style="display:inline-block;font-family:{SANS};font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:{C_BG};text-decoration:none;padding:15px 34px;">Select your dinner</a>
          </td>
        </tr></table>
        <div style="font-family:{SERIF};font-size:14px;font-style:italic;color:{C_MUTED};line-height:1.5;margin-top:18px;">Please don&rsquo;t forward this email &mdash; your plus-one will receive their own at the address they used to RSVP.</div>
      </td></tr>
    </table>
  </td></tr>

  <!-- 3. HOTEL BLOCK -->
  <tr><td style="padding:28px 40px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{C_CARD};border:1px solid {C_BORDER};">
      <tr><td style="padding:22px 24px;">
        <div style="font-family:{SANS};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:{C_BLUE};margin-bottom:10px;">Hotel block</div>
        <div style="font-family:{SERIF};font-size:18px;color:{C_INK};margin-bottom:6px;">{HOTEL_NAME}</div>
        <div style="font-family:{SERIF};font-size:15px;color:{C_SECOND};margin-bottom:14px;">Book by {HOTEL_DEADLINE} to hold the group rate.</div>
        <a href="{hotel_href}" style="font-family:{SANS};font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:{C_BLUE};text-decoration:none;">Book your room &rarr;</a>
      </td></tr>
    </table>
  </td></tr>

  <!-- 4. DRESS CODE (mirrors the website's bordered two-column attire block) -->
  <tr><td style="padding:28px 40px 0;">
    <div style="font-family:{SANS};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:{C_BLUE};margin-bottom:16px;">Dress code</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid {C_BORDER};"><tr>
      <td width="50%" valign="top" align="left" style="padding:30px 22px;">
        <div style="font-family:{SANS};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:{C_BLUE};margin-bottom:14px;">Gentlemen</div>
        <div style="font-family:{SERIF};font-size:16px;color:{C_SECOND};margin-bottom:16px;white-space:nowrap;">A <strong style="color:{C_INK};">dark suit</strong></div>
        {gents_swatches}
      </td>
      <td width="50%" valign="top" align="left" style="padding:30px 22px;border-left:1px solid {C_BORDER};">
        <div style="font-family:{SANS};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:{C_BLUE};margin-bottom:14px;">Ladies</div>
        <div style="font-family:{SERIF};font-size:16px;color:{C_SECOND};margin-bottom:16px;white-space:nowrap;">A long dress in a <strong style="color:{C_INK};">summer color</strong></div>
        {ladies_swatches}
      </td>
    </tr></table>
  </td></tr>

  <!-- 5. DAY OF -->
  <tr><td style="padding:28px 40px 0;">
    <div style="font-family:{SANS};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:{C_BLUE};margin-bottom:16px;">Day of</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{C_CARD};border:1px solid {C_BORDER};">
      <tr><td style="padding:16px 22px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="90" valign="middle" style="font-family:{SANS};font-size:11px;font-weight:bold;color:{C_BLUE};padding:8px 0;">4:45 pm</td>
            <td valign="middle" style="font-family:{SERIF};font-size:16px;color:{C_INK};padding:8px 0;">Guest arrival starts</td>
          </tr>
          <tr>
            <td width="90" valign="middle" style="font-family:{SANS};font-size:11px;font-weight:bold;color:{C_BLUE};padding:8px 0;border-top:1px solid {C_BORDER};">5:30 pm</td>
            <td valign="middle" style="font-family:{SERIF};font-size:16px;color:{C_INK};padding:8px 0;border-top:1px solid {C_BORDER};">Ceremony starts</td>
          </tr>
          <tr>
            <td width="90" valign="middle" style="font-family:{SANS};font-size:11px;font-weight:bold;color:{C_BLUE};padding:8px 0;border-top:1px solid {C_BORDER};">11:30 pm</td>
            <td valign="middle" style="font-family:{SERIF};font-size:16px;color:{C_INK};padding:8px 0;border-top:1px solid {C_BORDER};">Reception ends</td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>

  <!-- 7. STAY IN THE LOOP (mirrors website "Join the conversation") -->
  <tr><td style="padding:28px 40px 0;" align="center">
    <div style="font-family:{SANS};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:{C_BLUE};margin-bottom:14px;text-align:left;">Stay in the loop</div>
    <div class="m-body" style="font-family:{SERIF};font-size:17px;color:{C_SECOND};line-height:1.6;margin:0 0 22px;text-align:left;">Partiful is our home base for the wedding &mdash; the place to ask questions, catch updates, and stay connected with us leading up to the big day.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid {C_BORDER};margin-bottom:24px;"><tr>
      <td width="33%" valign="top" align="left" style="padding:24px 14px;">
        <div style="font-family:{SANS};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:{C_BLUE};margin-bottom:10px;">Ask Questions</div>
        <div class="m-desc" style="font-family:{SERIF};font-size:15px;color:{C_SECOND};line-height:1.5;">Anything about the day &mdash; we&rsquo;re happy to help.</div>
      </td>
      <td width="34%" valign="top" align="left" style="padding:24px 14px;border-left:1px solid {C_BORDER};">
        <div style="font-family:{SANS};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:{C_BLUE};margin-bottom:10px;">Find a Carpool</div>
        <div class="m-desc" style="font-family:{SERIF};font-size:15px;color:{C_SECOND};line-height:1.5;">Coordinate rides with other guests heading to Malibu.</div>
      </td>
      <td width="33%" valign="top" align="left" style="padding:24px 14px;border-left:1px solid {C_BORDER};">
        <div style="font-family:{SANS};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:{C_BLUE};margin-bottom:10px;">Day-of Updates</div>
        <div class="m-desc" style="font-family:{SERIF};font-size:15px;color:{C_SECOND};line-height:1.5;">Timing, weather, and any last-minute notes.</div>
      </td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="center" style="background:{C_BLUE};">
        <a href="{partiful_href}" style="display:block;font-family:{SANS};font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:{C_BG};text-decoration:none;padding:15px 34px;text-align:center;">Join us on Partiful</a>
      </td>
    </tr></table>
  </td></tr>

  <!-- 8. FOOTER -->
  <tr><td style="padding:28px 0 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{C_BAND};">
      <tr><td align="center" style="padding:28px 40px;">
        <div style="font-family:{SERIF};font-style:italic;font-size:20px;color:{C_INK};">With love</div>
        <div style="font-family:{SANS};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:{C_MUTED};margin-top:10px;">Colin &amp; Lydia &middot; 10.10.2026</div>
        <div style="margin-top:16px;"><a href="{RSVP_URL}" style="font-family:{SANS};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:{C_BLUE};text-decoration:none;">Visit our wedding website &rarr;</a></div>
      </td></tr>
    </table>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>"""


def build_text(first_name, survey_url):
    return "\n".join([
        "Colin & Lydia · October 10, 2026 · Calamigos Ranch, Malibu",
        "",
        f"Hi {first_name},",
        "",
        f"ONE THING WE NEED FROM YOU: Please select your dinner entree by {MEAL_DEADLINE}.",
        f"Select your dinner: {survey_url}",
        "",
        "Please don't forward this email — your plus-one will receive their own at the address they used to RSVP.",
        "",
        f"HOTEL BLOCK: {HOTEL_NAME}. Book by {HOTEL_DEADLINE}: {HOTEL_LINK}",
        "",
        f"Stay in the loop on Partiful: {PARTIFUL_LINK}",
        "",
        f"Visit our wedding website: {RSVP_URL}",
        "",
        "With love, Colin & Lydia · 10.10.2026",
    ])


# ======================================================================
# GUEST LIST
# ======================================================================
def load_guests(csv_path):
    """Read guests, skip rows with no email, dedupe by email (first wins)."""
    if not os.path.exists(csv_path):
        sys.exit(f"ERROR: CSV not found at '{csv_path}'. Export your guest list "
                 f"with columns: First Name, Last Name, Email.")

    guests, skipped, seen = [], [], set()
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        # tolerate header spacing/case differences
        field_map = {(k or "").strip().lower(): k for k in (reader.fieldnames or [])}
        fn = field_map.get("first name")
        ln = field_map.get("last name")
        em = field_map.get("email")
        if not em:
            sys.exit("ERROR: CSV must contain an 'Email' column.")

        for row in reader:
            first = (row.get(fn, "") if fn else "").strip()
            last  = (row.get(ln, "") if ln else "").strip()
            email = (row.get(em, "") or "").strip()
            full  = (first + " " + last).strip()

            if not email:
                skipped.append({"reason": "no email", "name": full or "(blank)"})
                continue
            key = email.lower()
            if key in seen:
                skipped.append({"reason": "duplicate email", "name": full, "email": email})
                continue
            seen.add(key)
            guests.append({"first": first or "there", "full": full or email, "email": email})

    return guests, skipped


def survey_url_for(full_name, email):
    return f"{SURVEY_URL}?name={quote(full_name)}&email={quote(email)}"


# ======================================================================
# SENDING
# ======================================================================
def build_message(to_email, full_name, first_name):
    url = survey_url_for(full_name, to_email)
    msg = MIMEMultipart("alternative")
    msg["Subject"] = SUBJECT
    msg["From"] = formataddr((FROM_NAME, GMAIL_ADDRESS))
    msg["To"] = to_email
    msg.attach(MIMEText(build_text(first_name, url), "plain", "utf-8"))
    msg.attach(MIMEText(build_html(first_name, url), "html", "utf-8"))
    return msg


def main():
    # Build the recipient list.
    if TEST_RECIPIENTS:
        guests = [{"first": TEST_NAME.split()[0], "full": TEST_NAME, "email": e.strip()}
                  for e in TEST_RECIPIENTS if e.strip()]
        skipped = []
        print(f"TEST MODE: sending only to {len(guests)} test recipient(s); CSV ignored.\n")
    else:
        guests, skipped = load_guests(CSV_PATH)

    print(f"{len(guests)} recipient(s) queued, {len(skipped)} skipped.")
    for s in skipped:
        print(f"  - skipped ({s['reason']}): {s.get('name','')} {s.get('email','')}".rstrip())
    print("")

    # DRY RUN: print + write a preview file, send nothing.
    if DRY_RUN:
        for g in guests:
            print(f"  [dry-run] {g['full']} <{g['email']}>")
            print(f"            {survey_url_for(g['full'], g['email'])}")
        if guests:
            sample = guests[0]
            preview = build_html(sample["first"], survey_url_for(sample["full"], sample["email"]))
            with open("preview.html", "w", encoding="utf-8") as f:
                f.write(preview)
            print(f"\nWrote preview.html (rendered for {sample['full']}). Open it in a browser.")
        print("\nDRY_RUN is True — no emails were sent. Set DRY_RUN = False to send.")
        return

    # Guard against placeholder credentials.
    if "your@gmail.com" in GMAIL_ADDRESS or "xxxx" in GMAIL_APP_PASS:
        sys.exit("ERROR: set GMAIL_ADDRESS and GMAIL_APP_PASS before sending.")

    sent, failed = 0, []
    context = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context) as server:
        server.login(GMAIL_ADDRESS, GMAIL_APP_PASS)
        for g in guests:
            try:
                msg = build_message(g["email"], g["full"], g["first"])
                server.sendmail(GMAIL_ADDRESS, [g["email"]], msg.as_string())
                sent += 1
                print(f"  sent -> {g['full']} <{g['email']}>")
            except Exception as e:  # noqa: BLE001 - keep going on per-guest failures
                failed.append({"email": g["email"], "error": str(e)})
                print(f"  FAILED -> {g['email']}: {e}")
            time.sleep(SEND_DELAY_SEC)

    print(f"\nDone. Sent {sent}, failed {len(failed)}, skipped {len(skipped)}.")
    for fobj in failed:
        print(f"  - failed: {fobj['email']} ({fobj['error']})")


if __name__ == "__main__":
    main()
