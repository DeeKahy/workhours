# WorkHours

A tiny self-hosted work-hours tracker. Clock in / clock out (or edit days by hand),
see hours and after-tax pay per 21st-to-20th pay period, and email a styled summary
for the current period. Phone + desktop friendly; installable to the iOS home screen.

- **Backend:** one `server.js`, Node.js built-in modules only (no npm, no `node_modules`).
- **Storage:** a single JSON file at `$DATA_DIR/db.json`.
- **Auth:** open signup, **plaintext passwords** — intentional, acceptable **only** behind a
  trusted network (LAN/VPN). Do **not** expose this to the public internet.
- **Packaging:** a Nix flake exposing `packages.workhours` + `nixosModules.default`.

## Run locally

```bash
DATA_DIR=./data PORT=8080 node server.js
# open http://localhost:8080
```

## Configuration (environment)

| Var         | Default        | Meaning                                              |
|-------------|----------------|------------------------------------------------------|
| `PORT`      | `8080`         | TCP port                                             |
| `ADDRESS`   | `0.0.0.0`      | Bind address                                         |
| `DATA_DIR`  | `./data`       | Directory holding `db.json`                          |
| `SEED_FILE` | `$DATA_DIR/seed.json` | First-run seed (a full `{users:{...}}` document) |

On first run, if `db.json` doesn't exist it's created from `SEED_FILE` (if present),
otherwise as an empty user list. See [`seed.example.json`](seed.example.json) for the
format. Keep real/personal seed data out of the repo (it's gitignored).

## NixOS

```nix
inputs.workhours.url = "github:DeeKahy/workhours";
# ...
modules = [
  workhours.nixosModules.default
  { services.workhours = { enable = true; port = 8080; openFirewall = true; }; }
];
```

The module runs the service under `DynamicUser` with `StateDirectory=workhours`
(`/var/lib/workhours`) and a nightly backup timer that keeps ~14 copies of `db.json`.
