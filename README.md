# Burner Selection Matrix

Internal field-sales tool for choosing Beckett and Wayne (incl. Comet) oil and gas burners.
Filter by fuel, required firing rate (GPH or MBH), power available, firing mode, application
and footprint; the chart shows every matching burner's firing range against the job.

It is a static page (`html/index.html`) that reads its data from `html/burners.json`, served by nginx. The official Beckett and Wayne
logos are downloaded from each maker's website when the image is built.

## 1. Build (automatic)

Every push to `main` runs the GitHub Action, which builds the image and publishes
`ghcr.io/trev9575/burner-matrix:latest`.

The package inherits the repository's visibility. For a **private** repo, Unraid has to log in
to pull it (step 2, note). For a **public** repo, open GitHub → your profile → **Packages →
burner-matrix → Package settings** after the first build and set visibility to **Public**.

## 2. Install on Unraid

**Option A – template (recommended)**

1. Copy `unraid/burner-matrix.xml` to your flash drive at
   `/boot/config/plugins/dockerMan/templates-user/my-burner-matrix.xml`.
2. Docker → **Add Container**, pick **burner-matrix** from the template list, check the port
   (default `8088`), click **Apply**.

**Option B – by hand**

| Field | Value |
|---|---|
| Repository | `ghcr.io/trev9575/burner-matrix:latest` |
| Port | container `80` → host `8088` (or any free port) |

Then open `http://YOUR-UNRAID-IP:8088`.

> **Private package:** create a GitHub personal access token (classic) with only `read:packages`,
> then in the Unraid terminal run
> `docker login ghcr.io -u trev9575` and paste the token as the password. Unraid remembers it.

## 3. Updating

Edit `html/burners.json` or `html/index.html` (on GitHub, or locally and push) → wait for the Action to finish
(a minute or two) → in Unraid click **Check for Updates** on the Docker tab, then
**Apply update**.

## Adding or changing burners

All burner data is in **`html/burners.json`**, one burner per line. You don't touch the page code.

**Easiest way:** open the tool, scroll to **Add a burner**, and fill in the form. It won't produce an
entry until every required field is complete and sensible (e.g. GPH for oil, MBH for gas, min below max,
a real https link). Click **Check & preview** to see it on the chart, then **Copy entry**, open
`burners.json` on GitHub (the form links straight to the editor), paste it after the last `}` and
before the final `]`, and **Commit changes**.

**Editing an existing burner:** change its line in `burners.json` on GitHub and commit.

Every commit runs `scripts/validate.js` first. If an entry is incomplete or a comma is missing, the
build stops with a message saying which burner and which field, and the running site is left as it was.
Check it locally with `node scripts/validate.js`.

| Field | What to put |
|---|---|
| `name`, `brand` | Model and brand. New brands appear in the brand filter automatically. |
| `fuel` | `"oil"` or `"gas"` |
| `min`, `max` | Firing range: **GPH** for oil, **MBH** (1,000 Btu/h input) for gas |
| `power` | Any of `"12 VDC"`, `"24 VDC"`, `"120 VAC"`, `"208-240 VAC 1P"`, `"208-240 VAC 3P"`, `"480 VAC 3P"`, `"no power"` |
| `powerText` | The wording shown in the table, e.g. `"120 VAC std; 240 VAC 1φ option"` |
| `modes` | Any of `"on/off"`, `"low-high-low"`, `"modulating"` |
| `dims` | `[height, width, depth]` in inches, or `"spec sheet"`, or `"not published"` |
| `airTube` | Air tube lengths or insertion |
| `applications` | Any of `"residential"`, `"light commercial"`, `"commercial/industrial"`, `"mobile/DC equipment"`, `"oil-to-gas conversion"`, `"ovens/process"` |
| `notes` | Short selling note |
| `link` | `https://` product page or spec sheet |
| `biofuel`, `propane`, `discontinued` | Optional. e.g. `"B20"`, `"Conversion kit"`, `true` |

The allowed values live in `html/schema.js`, which the form and the build check share.

## Run without GitHub

```bash
docker build -t burner-matrix .
docker run -d --name burner-matrix --restart unless-stopped -p 8088:80 burner-matrix
```

## Notes

- **Logos:** the Beckett and Wayne sites block cloud build servers, so the container downloads the logos
  when it starts on your server (see the container log: `logos: downloaded ...`). If that's blocked too,
  the page shows the brand names as text. For a permanent fix, upload the files to the repo as
  `html/logos/beckett.png` and `html/logos/wayne.svg` (GitHub → `html` folder → **Add file → Upload files**,
  type `logos/` in the name box); committed files are always used.
- The page has no login. For reps outside the office, put it behind a reverse proxy with auth
  or a VPN (Tailscale/WireGuard) rather than opening the port.
- Specifications were compiled from beckettcorp.com, waynecombustion.com and preferred-mfg.com
  on 20 Nov 2026. Confirm against current spec sheets before quoting.
