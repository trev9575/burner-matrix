# Burner Selection Matrix

Internal field-sales tool for choosing Beckett and Wayne (incl. Comet) oil and gas burners.
Filter by fuel, required firing rate (GPH or MBH), power available, firing mode, application
and footprint; the chart shows every matching burner's firing range against the job.

- **Public page:** `http://YOUR-SERVER:8088/`, no sign-in.
- **Admin:** `http://YOUR-SERVER:8088/admin`, sign-in required. Add, edit, duplicate and delete burners,
  upload photos, undo any change, and manage who can sign in.

It is a small Node server (no dependencies) in one container. Burner data, uploaded photos,
users and the change history live in the `/data` folder (your Unraid appdata).

## 1. Build (automatic)

Every push to `main` checks `html/burners.json`, builds the image and publishes
`ghcr.io/trev9575/burner-matrix:latest`. If the package is private, run
`docker login ghcr.io -u trev9575` once on Unraid with a token that has `read:packages`.

## 2. Install / upgrade on Unraid

**Template:** copy `unraid/burner-matrix.xml` to
`/boot/config/plugins/dockerMan/templates-user/my-burner-matrix.xml`, then Docker → Add Container →
**burner-matrix**. If you already have the container, edit it and make these changes:

| Field | Value |
|---|---|
| Repository | `ghcr.io/trev9575/burner-matrix:latest` |
| Port | container **`8080`** → host `8088` (TCP) — the container port changed from 80 |
| Path | container `/data` → host `/mnt/user/appdata/burner-matrix` |
| Variable `ADMIN_USER` | your username, e.g. `trevor` |
| Variable `ADMIN_PASSWORD` | 8+ characters |

`ADMIN_USER`/`ADMIN_PASSWORD` are only used the **first** time, to create the first admin. After that,
sign in at `/admin`, change your password, and add other people under **Users**. You can then blank
the password variable.

**Everyone needs an account.** The whole site (matrix, photos, data) is behind sign-in. Give each rep
a **Rep** account (matrix + RFQs only); **Editors** can also change burners; **Admins** also manage people.
Each person's full name, phone and email fill in *Prepared by* on their RFQs. Admins set these under
**Users**; anyone can change their own from **My profile** at the top of the main page.
**Photos are stored on the server.** Any burner photo that points at a website (the Wayne/Comet
ones in the seed list, or a URL pasted in admin) is downloaded into `/data/photos` when the container
starts and after each edit, and the burner is switched to the local copy. Admin → History has a
**Store web photos on server** button to retry; anything that can't be downloaded is listed so you can upload it by hand.

**Saved RFQs.** RFQs are saved on the server (`/data/rfqs`). Reps see their own under **My RFQs**;
editors and admins see everyone's (**RFQs**, with an *Only mine* filter). Draft RFQs can be reopened and edited by the rep who made them; once an RFQ is **emailed** it's locked (download, print or resend only), and **Copy to new RFQ** starts a revision with a new number. The server enforces the same rule.

**RFQ status.** Each RFQ shows Draft or Emailed automatically; the rep (or an editor/admin) can mark it
Quoted, Won or Lost from the list. Counts per status and the win rate (won ÷ won + lost) sit above the list
and filter it when clicked.

**Jobs.** The Jobs tab shows jobs won, the quarterly win rate, and *Lost Jobs*: a pie chart and
table of lost reasons (count, share, quoted value) with a period picker (all time, this quarter, last quarter,
last 4 quarters), followed by the list of lost jobs and their notes. Reps see their own; editors and admins can
pick a rep or everyone, and the lost-reason numbers follow that choice.

**Quarterly report.** Jobs → *Quarterly report* opens a printable one-page sales performance report for any
quarter (and, for editors/admins, any rep): headline numbers, win-rate trend, by-rep table, burners quoted and jobs won.
Use *Print / Save PDF*.

**Customer address book.** Company and Contact suggest names from past RFQs (everyone's). Picking a known company
fills in its site address and most recent contact; picking a contact fills their phone and email. It never overwrites
anything typed in by hand.

**Follow-up reminders.** Emailed or Quoted RFQs with no activity (email, status change, or "Followed up" click) for a set
number of days are flagged "Follow up", counted on the My RFQs tab and filterable. Admins set the days in
**Admin → Settings** (0 turns reminders off).

**Quote value and lost reason.** Marking an RFQ Quoted or Won asks for an optional dollar value; Lost asks why
(price, lead time, competitor, cancelled, technical fit, no response, other) plus a note. Values show in RFQs, Jobs
and the quarterly report, which also breaks down lost reasons.

**Export to Excel.** RFQs → *Export to Excel* downloads every RFQ you can see (reps: their own; editors/admins: all)
as an .xlsx with all fields, status, value and lost reason.

**Nightly backup.** Every night at 1:00 a.m. (container `TZ`, default America/New_York) the server copies everything in
`/data` except old backups into `/data/backups/YYYY-MM-DD_HHMM`, keeping the last 14. If the server was off at 1:00 it
takes one a minute after starting. Admin → Settings shows the last backup and has *Back up now*. To restore, stop the
container and copy the files from a backup folder back into the appdata folder.

**Customers.** The Customers tab lists every company from past RFQs (contact, RFQs, won, win rate, last RFQ).
Click one for its history: contacts, totals, burners quoted and every RFQ. Reps see other reps' RFQs for that customer as
summary rows only (who, when, burner, status). Company names in RFQs and Jobs link here too.
*+ Add customer* saves a company (address, any number of contacts, notes) before it has any RFQs; it shows up in the
list and in the RFQ address book right away. *Edit details* on a customer's page changes its saved address, contacts
and notes (allowed for whoever added it, any rep who has quoted it, editors and admins). Saved details are stored in
`customers.json` in the data folder and are included in the nightly backup.

**Duplicate warning.** When a company on a new RFQ already had an RFQ in the last 90 days, the sheet shows who quoted it,
when, which burner and its status (red when it's the same burner).

**Install as an app (needs https).** On iPhone/iPad: Safari → Share → *Add to Home Screen*. On Android: Chrome offers
*Install app* (or use the account menu → *Install app*). The app opens full screen with the Beckett icon. With no signal it
still shows the matrix, photos and your RFQ list, and new RFQs are saved on the phone, then uploaded and numbered when
the signal is back. *Keep me signed in* on the sign-in page keeps a session for 30 days (`REMEMBER_DAYS`); it's ticked by
default inside the installed app. Signing out clears everything the app saved on that device.

**Replacing a burner? (cross-reference).** Next to *Biofuel rated* in the matrix filters, reps type another maker's (or an older)
model, e.g. *Carlin 301CRD*, and see the Beckett/Wayne burner(s) to sell instead, plus any note. *Show all in the matrix*
narrows the chart and table to just that entry's replacements (other filters cleared; a banner offers *Show all burners*); *Create RFQ* starts an RFQ with "Replaces Carlin 301CRD."
in Notes. Editors and admins keep the list in **Admin → Cross-reference** (the brand box suggests brands already used): add, edit or delete entries one at a time,
or paste many rows from a spreadsheet (Brand, Model, Replacement(s) separated by `;`, Note). The table filters by brand, model and fuel (oil/gas, from the replacement burners). Tick *No current replacement* (or put `none` in a pasted row) when nothing in the line replaces a model; reps then see that instead of a burner. Stored in `xref.json`
(included in backups); renaming a burner keeps its cross-references pointing at it.

**Info buttons.** A small **?** next to technical terms (firing rate, firing mode, power, turndown, overfire pressure,
flame size, footprint, biofuel, air tube, insertion depth, mounting, oil supply, venting, altitude, gas pressure,
controls, and the table's fit tags) opens a plain-English explanation. They're hidden on printouts and PDFs.

**Incompatible filters are grayed out.** Any fuel, brand, firing mode, power supply, application, turndown, biofuel
option that would leave no burners together with what's already chosen (including the firing rate) is
grayed out and can't be picked. 120 VAC is always selectable, since it records that the site has 120 V (which
turns off the step-down transformer warning). Hover it to see why; change another filter or press Reset to free it up.

**Step-down transformer warning.** Tick *Step-down transformer warning* on a burner in Admin → Burners. When a rep
clicks *Create RFQ* for that burner with only voltages above 120 V ticked in the Power filter (and 120 VAC not ticked),
a popup says a step-down transformer is required if 120 VAC isn't available at the site, which adds cost; they can go
back or continue. Admin → Settings has a master switch to turn these popups off for everyone.
If they continue, the RFQ sheet (and its PDF and copied text) carries a locked **Step-down transformer required** note
with the site power they selected. Nobody can edit or remove it; *Copy to new RFQ* carries it over.

**Oil-To-Gas Conversion Tool.** Pick 1 or 2 nozzles (each can be a different size) and the pump pressure; it works out the real
firing rate (sum of nozzles × √(psi ÷ 100), × 140 MBH per GPH) and lists every gas burner that covers it,
conversion burners tagged and first, each with Create RFQ. It can also set the matrix filters.
RFQs made from there note the oil nozzle being replaced.

**Email PDF.** The server turns the RFQ into a PDF (headless Chromium, built into the image) and emails it.
Fill in the SMTP variables on the container: `SMTP_HOST`, `SMTP_PORT` (465 SSL or 587 STARTTLS), `SMTP_USER`,
`SMTP_PASS`, optional `SMTP_FROM`. The default "Send to" address is set by an admin in **Admin → Settings** (falls back to the `RFQ_TO` variable when blank); reps can change it per RFQ.
For Gmail, turn on 2-step verification and create an **App Password**; use that as `SMTP_PASS`.
Replies go to the rep's email on the sheet; the rep can tick "Send me a copy".

RFQ numbers are `YYMMDD-NNMODEL`, where NN counts RFQs made that day across everyone (kept in `/data/rfq-seq.json`).

Optional: `COOKIE_SECURE=true` if you only open it over https, `TRUST_PROXY=true` behind Nginx Proxy
Manager / SWAG / a Cloudflare tunnel, `SESSION_HOURS` (default 12).

## 3. Editing burners

Use `/admin`. Saves go live immediately; there is no rebuild. Every save is logged under
**History & undo** with who made it, and any change can be undone.

**Roles:** *Editors* change burners. *Admins* also add/remove people and reset passwords.
Logins are rate-limited (8 wrong tries per 15 minutes per address).

### Where the data lives

| In `/data` | What |
|---|---|
| `burners.json` | The live burner list |
| `photos/` | Photos uploaded in admin |
| `history/` | One file per change (last 200 kept), used for undo |
| `users.json` | Usernames, roles and hashed passwords |
| `.secret` | Key that signs sign-in cookies (delete it to sign everyone out) |

`html/burners.json` in this repo is only the **starting list** copied into `/data` the first time
the container runs. To keep the repo in step, use **Download burners.json** in admin and commit it.
To throw away the live list and start again from the repo copy, stop the container, delete
`/data/burners.json`, and start it.

**Backups:** the Appdata Backup plugin covers `/mnt/user/appdata/burner-matrix`, or copy the folder.

### Field reference

| Field | What to put |
|---|---|
| `name`, `brand` | Model and brand. New brands appear in the brand filter automatically. |
| `fuel` | `"oil"` or `"gas"` |
| `min`, `max` | Firing range: **GPH** for oil, **MBH** for gas |
| `power` | Any of `"12 VDC"`, `"24 VDC"`, `"120 VAC"`, `"208-240 VAC 1P"`, `"208-240 VAC 3P"`, `"480 VAC 3P"`, `"no power"` |
| `powerStd` | Optional. Which `power` value is standard; shown as a **Std** tag |
| `powerText` | Reference notes on the electrical options (not shown in the table) |
| `modes` | Any of `"on/off"`, `"low-high-low"`, `"modulating"` |
| `dims` | `[height, width, depth]` in inches, or `"spec sheet"`, or `"not published"` |
| `airTube` | Air tube lengths or insertion |
| `applications` | Any of `"residential"`, `"light commercial"`, `"commercial/industrial"`, `"pressure washers/road equipment"`, `"oil-to-gas conversion"`, `"ovens/process"` |
| `notes` | Short selling note |
| `link` | `https://` product page |
| `image` | Optional. `https://` photo, or `photos/<file>` |
| `flameLength`, `flameWidth` | Optional. Flame size in inches (used by the "Flame must fit" filter) |
| `turndown` | Optional. Modulation turndown as a number, e.g. `8` for 8:1. On/off-only burners count as 1:1 |
| `overfire` | Optional. Max overfire (combustion chamber) pressure the burner handles, inches WC |
| `parts` | Optional. Aftermarket part availability: `"best"`, `"good"` or `"bad"` |
| `service` | Optional. Ease of service: `"easy"`, `"medium"` or `"hard"` |
| `airTubes` | Optional. Air tube lengths you can order, in inches (decimals OK), e.g. `["6", "7.5", "9"]`. Picked in admin from a dropdown of every length used on any burner, or added there. The RFQ's Air Tube Length becomes a dropdown of these plus “Other (see notes)” |
| `airTubeStd` | Optional. The standard length, one of `airTubes`. Marked “(std)” and preselected on the RFQ |
| `stepDown` | Optional. `true` = show the step-down transformer warning for this burner (admin checkbox *Step-down transformer warning*) |
| `biofuel` | Optional. Fuel ratings, comma-separated, picked in admin from `#2`, `B20`, `B100`, `R100` (e.g. `"B20, B100, R100"`; every oil burner has B20) |
| `propane` | Optional. e.g. `"Conversion kit"` |

The rules live in `html/schema.js`, shared by the admin screen, the server and the build check.

## Photos

Wayne and Comet photos load from their websites. Beckett's site blocks other sites from showing its
images, so Beckett photos ship in `html/photos/`. Photos uploaded in admin are stored in `/data/photos`.

## Run without Unraid

```bash
docker build -t burner-matrix .
docker run -d --name burner-matrix -p 8088:8080 -v "$PWD/data:/data" \
  -e ADMIN_USER=trevor -e ADMIN_PASSWORD='change-me-now' burner-matrix
```

Or without Docker (Node 20+): `DATA_DIR=./data ADMIN_USER=trevor ADMIN_PASSWORD=... node server.js`

## Security notes

- The public page has no sign-in. To reach it from outside the office, put it behind a VPN
  (Tailscale/WireGuard) or a reverse proxy rather than opening the port.
- Sign-in cookies are HttpOnly and SameSite=Lax (so links from email open signed in); every change also needs a custom request header.
- Passwords are stored as scrypt hashes. Changing or resetting a password signs that person out everywhere.
