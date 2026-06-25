# Wanna Cry

Wanna Cry adalah MVP **internal control panel** untuk menjalankan Docker Compose jobs dari UI secara lebih aman.

Arsitektur MVP:

- **Control plane**: Node.js + TypeScript + Express + EJS + SQLite
- **Runner**: Python worker yang polling job dari control plane
- **Deployment**: Docker Compose (`api` + `runner`)
- **Security model**: user hanya menjalankan `commandId` yang di-allowlist, bukan shell command bebas

> Penting: runner memakai `/var/run/docker.sock`, jadi runner adalah komponen sensitif. Jangan expose runner ke internet.

## Struktur folder

```text
wanna-cry/
  docker-compose.yml
  .env.example
  control-plane/
    Dockerfile
    package.json
    tsconfig.json
    src/
    views/
    public/
  runner/
    Dockerfile
    app.py
    executor.py
    config.yml
    requirements.txt
```

## Setup cepat

```bash
cp .env.example .env
# edit RUNNER_TOKEN dan SESSION_SECRET

docker compose up -d --build
docker compose exec api npm run seed
```

Buka:

```text
http://<ip-server>:3000
```

Default seed mengikuti `.env`:

- `SEED_ADMIN_EMAIL`
- `SEED_ADMIN_PASSWORD`

## Menambahkan project yang boleh dikontrol

Edit `runner/config.yml`:

```yaml
projects:
  projectku:
    compose_file: /opt/projects/projectku/docker-compose.yml
    workdir: /opt/projects/projectku
```

Pastikan folder project target tersedia di host, misalnya:

```text
/opt/projects/projectku/docker-compose.yml
```

## Command yang diizinkan MVP

Runner hanya menerima command berikut:

- `COMPOSE_UP`
- `COMPOSE_DOWN`
- `COMPOSE_PULL`
- `COMPOSE_LOGS`

Tidak ada fitur menjalankan arbitrary shell command.

## Development lokal control-plane

```bash
cd control-plane
npm install
npm run dev
```

Untuk production gunakan Docker Compose dari root repo.

## GitHub update

Setelah mengganti source di repo:

```bash
git add .
git commit -m "Refactor MVP control-plane and runner"
git push origin master
```
