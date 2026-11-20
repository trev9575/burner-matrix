# Burner Selection Matrix

Internal field-sales tool for choosing Beckett and Wayne (incl. Comet) oil and gas burners.
Filter by fuel, required firing rate (GPH or MBH), power available, firing mode, application
and footprint; the chart shows every matching burner's firing range against the job.

It is a single static page (`html/index.html`) served by nginx. The official Beckett and Wayne
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

Edit `html/index.html` (on GitHub, or locally and push) → wait for the Action to finish
(a minute or two) → in Unraid click **Check for Updates** on the Docker tab, then
**Apply update**.

Burner data lives in the `const D=[ ... ]` array near the bottom of `index.html`, one line per
burner. Fields: `n` name, `b` brand, `f` fuel (`oil`/`gas`), `lo`/`hi` firing range (GPH for
oil, MBH for gas), `v` power codes (`12dc`, `24dc`, `120`, `240` = 208-240 1P, `3p240`,
`3p480`, `none`), `m` modes (`onoff`, `hilo`, `mod`), `dim` [H, W, D] inches or `'spec'`/`null`,
`a` applications (`res`, `lc`, `ci`, `mob`, `conv`, `proc`), plus `bio`, `lp`, `disc`, `note`, `u` link.

## Run without GitHub

```bash
docker build -t burner-matrix .
docker run -d --name burner-matrix --restart unless-stopped -p 8088:80 burner-matrix
```

## Notes

- If a logo URL changes and the build fails, commit your own files as `html/logos/beckett.png`
  and `html/logos/wayne.svg` and delete the two `ADD` lines in the `Dockerfile`.
- The page has no login. For reps outside the office, put it behind a reverse proxy with auth
  or a VPN (Tailscale/WireGuard) rather than opening the port.
- Specifications were compiled from beckettcorp.com, waynecombustion.com and preferred-mfg.com
  on 20 Nov 2026. Confirm against current spec sheets before quoting.
