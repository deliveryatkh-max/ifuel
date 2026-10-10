# OT Request & Approval App: setup and user guide

The app has three parts:

- **The form** at **https://isteel-app.pages.dev/overtime/**, which is also the ថែមម៉ោង tile on the home menu. Employees use it to request OT and check their requests. They don't need to sign in, just their Employee ID.
- **The OT script**, `OT.gs`, which lives inside your **SSK_OT_DATA** Google Sheet. It saves requests, finds each employee's line manager and talks to Telegram.
- **The OT bot** on Telegram. It sends each request to that employee's own line manager, with ✅ Approve and ❌ Reject buttons.

The Google Sheet stays the only database. The script never deletes, moves or rewrites existing rows.

---

## 1. Sheet structure and how the app uses it

**OT Data.** One row per request. Existing columns are kept as they are.

| Column | Header | Filled by the app with |
|---|---|---|
| A | Nº | Last number + 1 |
| B | Date | OT date |
| C | ID No. | Employee ID (same cell type as the employee list) |
| D | Name | English name from *Employee & Approver* |
| E | Khmer Name | Khmer name from *Employee & Approver*, or from an older OT row if blank there |
| F | From: | Start time |
| G | To: | End time (earlier than the start means it ends the next morning) |
| H | OT hr | Hours worked, calculated (for example 10:00 PM – 12:30 AM = 2.5) |
| I | Reason of OT | Reason or work description |
| J | Date & Time Record | When the request was submitted |
| K | LatLong | Phone GPS (only when the site check is turned on) |
| L | Reviewed By | The manager who approved or rejected |
| M | **Request ID** *(new)* | For example OT-261010-7PHBA |
| N | **Status** *(new)* | Pending, Approved, Rejected or Requires Follow-up |
| O | **Approver** *(new)* | Line manager at the time of submission |
| P | **Decision Time** *(new)* | When it was approved or rejected |
| Q | **Rejection Reason** *(new)* | The manager's reply to the bot (optional) |
| R | **Telegram Ref** *(new)* | Internal: which Telegram message to update |
| S | **Note** *(new)* | Why a request needs follow-up |

Old rows keep a blank Status. The app treats them as already recorded, so nobody can enter the same OT twice.

**Employee & Approver.** The app reads it and never writes to it:

- ID No.
- Name
- Khmer Name
- Direct Manager (Approver)
- Telegram, the manager's @username

**OT Reason.** The quick-pick reasons shown on the form.

**New tabs made by `setup()`:**

- **OT Approvers.** Each manager's verified Telegram chat, filled in automatically when the manager presses Start on the bot. To turn a manager off, set Active to No.
- **OT Log.** The audit trail: every submission, notification, approval, rejection, refused attempt and registration.
- **OT App Settings.** Optional rules. A blank value means the rule is not enforced. None of them are set yet, because the company rules were not in the sheet.
  - `MAX_HOURS_PER_REQUEST`
  - `MAX_DAYS_IN_PAST`
  - `MAX_DAYS_IN_FUTURE`
  - `ALLOW_OVERNIGHT` (default Yes)
  - `SITE_LATLONG` plus `SITE_RADIUS_M` for the GPS site check

**Data check on 10 Oct 2026:**

- 278 employees, no duplicate IDs, all with an English name and a line manager.
- **Khmer Name is blank for all 278.** 54 of them have a Khmer name in old OT rows, and the app uses that. Please fill column C for the rest.
- All 278 currently map to Kim Sopheakdey, @pheakdeykim.

To run the same check again at any time, run `checkData()` in the script editor.

---

## 2. Create the Telegram bot

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Name it, for example *ISI OT Approval*, with the username `isi_ot_approval_bot` (it must end in "bot").
3. BotFather replies with a **token** like `123456789:AA...`. Keep it private, never paste it in a chat or the sheet, and treat it like a password.

A new bot is used, not the fuel bot, so the fuel group setup is not affected.

## 3. Put the script in the OT sheet

1. Open **SSK_OT_DATA** and go to **Extensions → Apps Script**.
2. Delete what is in `Code.gs` and paste the whole of **`OT.gs`**. The file name in the editor doesn't matter.
3. Click ⚙️ **Project Settings** and tick **Show "appsscript.json"**. Back in the editor, replace `appsscript.json` with the one from this folder. It sets the Phnom Penh time zone and the permissions.
4. Click 💾 Save.

## 4. Save the bot token securely

1. In ⚙️ **Project Settings → Script Properties**, click **Add script property**.
2. Set Property to `OT_BOT_TOKEN` and Value to the token from BotFather. Save.

The token stays on Google's server. It is never sent to the phone or the website.

## 5. Run setup

1. In the editor, choose the function **`setup`** and click ▶ **Run**.
2. Allow the permissions when Google asks. Under "Google hasn't verified this app", click **Advanced → Go to (project)**. It's your own script.

Setup adds the 7 new columns (M–S), the 3 new tabs, a secret code for the Telegram link, and a check every 15 minutes that resends requests that could not be delivered. Running it again is safe.

**Permissions the script asks for:**

- Edit this one spreadsheet only.
- Connect to Telegram.
- Make its own 15-minute trigger.

## 6. Deploy the web app

1. Click **Deploy → New deployment**, then the ⚙️ next to "Select type", then **Web app**.
2. Set **Execute as** to **Me** and **Who has access** to **Anyone**.
   - "Anyone" lets the form and Telegram reach the script.
   - Every request is still checked on the server: the Employee ID, the manager link, and the secret code for Telegram.
3. Click **Deploy** and copy the **Web app URL**. It ends with `/exec`.

After a later code change, use **Deploy → Manage deployments → ✏️ → Version: New version**. That keeps the same URL.

## 7. Connect the form to the script

Open `web/overtime/config.js` in the GitHub repo and paste the URL:

```js
window.OT_CONFIG = {
  OT_API_URL: 'https://script.google.com/macros/s/XXXX/exec',
};
```

Commit the change. Cloudflare updates the site within a minute or two. Until the URL is set, the form runs in DEMO mode: a yellow bar shows, nothing is saved and nothing is sent.

## 8. Connect the Telegram buttons (webhook)

In the editor, run **`connectTelegram`**. It points the bot at:

`https://isteel-app.pages.dev/tg/ot?to=<your deployment>`

That address is a small relay on your Cloudflare site, the file `functions/tg/ot.js`. Telegram needs it because Apps Script answers with a redirect, which Telegram treats as an error. The relay passes Telegram's secret header on to the script, and the script ignores any call without the right secret.

The run log shows `Connected @your_bot`. If it says to deploy first, finish step 6. If it still fails, add a Script Property `OT_WEB_APP_URL` with the /exec URL and run it again.

To check the link at any time, open `https://isteel-app.pages.dev/tg/ot` in a browser. It should say *OT relay is running*.

## 9. Register each line manager (Telegram chat ID)

A bot can't message someone by @username until that person has started a chat with it. So each line manager does this once:

1. Make sure their Telegram **username** is in the *Telegram* column of *Employee & Approver* (for example `@pheakdeykim`), and that they have a username set in Telegram (Settings → Username).
2. Open the bot (link: `t.me/<your bot username>`) and press **Start**.
3. The bot replies **✅ Registered**, and a row appears in *OT Approvers* with their chat ID.

To verify, run `checkData()`. The line *Not yet registered on the bot* should say **none**.

Safety rules:

- Only usernames listed in the Telegram column can register.
- A username that is already registered can't be taken by another Telegram account. To move it, delete the old row in *OT Approvers*.
- A request whose manager hasn't registered yet is saved as **Requires Follow-up**. It is sent to that manager automatically once they press Start. It is never sent to anyone else.

## 10. First live test (before telling staff)

Every employee is mapped to Kim today, so test messages go only to Kim:

1. Kim registers on the bot (step 9).
2. Open the form, enter Kim's own or a test Employee ID, submit a short OT, and check:
   - A new row appears in *OT Data* with Status **Pending**.
   - Kim's Telegram receives the request with both buttons.
3. Tap **Approve** and check that the row shows **Approved**, Reviewed By and Decision Time, and that the Telegram message shows ✅.
4. Submit another and tap **Reject**, then reply with a reason. Check **Rejected** and the reason in column Q.
5. Delete the test rows afterwards if you don't want them kept. That's safe, since they are your own rows.

---

## User guide: employees

1. Open **isteel-app.pages.dev/overtime/**, or tap ថែមម៉ោង on the home menu.
2. Type your **Employee ID**. Your English name, Khmer name and line manager appear. You can't change them; if they are wrong, tell HR.
3. Choose the **OT date** and the **start and end time**. The total hours appear by themselves. If the end is after midnight, it shows 🌙 Overnight.
4. Tap a reason or type what you did.
5. Tap **📨 Submit OT Request**. You get a **Request ID** and the status **Pending**.
6. Tap **📋 My requests** to see whether it was approved or rejected. To check from another phone, enter your Employee ID and the Request ID.

Status meanings:

- ⏳ **Pending**: waiting for your manager.
- ✅ **Approved**.
- ❌ **Rejected**, with the reason if the manager gave one.
- ⚠️ **Requires Follow-up**: saved, but your manager can't receive it on Telegram yet. HR or the admin will sort it out, and you don't need to submit again.

## User guide: line managers

1. Once only: open the OT bot in Telegram and press **Start**.
2. Each request arrives as a message with the employee, date, time, hours and reason.
3. Tap **✅ Approve** or **❌ Reject**. The message updates to show your decision, and the sheet is updated straight away.
4. After a rejection, the bot asks for a reason. Reply to that message, or ignore it.
5. You can only decide requests from your own team. A request that has already been decided can't be changed from Telegram.

---

## Tests run (10 Oct 2026)

**Backend:** `OT.gs`, run against a copy of the real sheet with Telegram simulated. No real messages were sent. 53 of 53 checks passed.

| # | Scenario | Result |
|---|---|---|
| 1 | Valid ID fills English + Khmer name and manager | Pass |
| 2 | Unknown ID shows an error | Pass |
| 3 | Duplicate ID refused at lookup and at submit | Pass |
| 4 | Employee A's request goes only to A's manager | Pass |
| 5 | Employee B's request goes only to B's manager | Pass |
| 6 | Manager not registered or without a username: saved as Requires Follow-up, sent to nobody; sent to the right manager once they register | Pass |
| 7 | Row saved in OT Data with correct values and formats | Pass |
| 8 | Hours: 2:30–5:15 PM = 2.75; 10:00 PM–12:30 AM = 2.5; same start and end refused | Pass |
| 9 | Initial status Pending | Pass |
| 10 | Assigned manager approves: status, Reviewed By, time, Telegram updated | Pass |
| 11 | Assigned manager rejects, and the reason reply is saved | Pass |
| 12 | Another manager, a wrong secret, a made-up Request ID and bad button data all change nothing | Pass |
| 13 | Already processed: refused; the same Telegram update twice is handled once | Pass |
| 14 | Double tap or retry gives one row and one Request ID (even if the cache is lost); overlapping OT refused, including against old rows | Pass |
| 15 | Telegram down: request kept as Requires Follow-up, token not leaked, resent by the 15-minute retry; sheet problem: clear error, nothing saved, nothing sent | Pass |
| 16 | Form on phone (390 px, Khmer) and desktop (1280 px, English, dark): lookup, overnight hours, double-click submit, My requests, empty-form errors, overlap message | Pass (10/10) |
| 17 | Existing rows 1–1247, columns A–L, unchanged in values and formats | Pass |

Also checked: an employee sees only their own requests, the optional max-hours rule, and the GPS site check (refuses at 400 m, accepts within 100 m).

**Not yet tested:** the live Google Sheet, the real Telegram bot and the Cloudflare relay. They need steps 2–9 first, then the live test in step 10.

## Remaining setup items and limits

- **Fill Khmer names** in *Employee & Approver*, column C (224 are missing everywhere).
- **Company OT rules** (max hours, how late a request can be sent) are not in the sheet, so none are enforced. Set them in *OT App Settings* if you want them.
- **GPS site check** is off until `SITE_LATLONG` is filled.
- **Anyone who knows an Employee ID can submit a request in that person's name**, because the form has no sign-in (as specified). The line manager's approval is the control, and every attempt is in *OT Log*.
- **Telegram usernames:** if a manager changes their Telegram username, update the Telegram column and have them press Start again.
- **There is no Department column** in the sheet, so the request has none. Add a column to *Employee & Approver* if you want it shown.
