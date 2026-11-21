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
| `biofuel`, `propane` | Optional. e.g. `"B20"`, `"Conversion kit"` |

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
- Sign-in cookies are HttpOnly and SameSite=Strict; every change also needs a custom request header.
- Passwords are stored as scrypt hashes. Changing or resetting a password signs that person out everywhere.
