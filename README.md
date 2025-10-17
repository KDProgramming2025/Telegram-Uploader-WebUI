# Telegram Uploader WebUI

A simple web interface to download files from links or your server and upload them to your Telegram account. Built for everyday use, no developer knowledge required.

- Upload files to Telegram (Saved Messages, groups, or channels)
- Paste links (including .m3u8 streaming links) and let the server fetch them
- Save downloads locally and browse them in a tree view
- Upload any saved file or folder to Telegram (folders enqueue all files)
- See live progress and status with a clear percent indicator

This app runs on your own server and connects to your Telegram account using your Telegram API credentials.

---

## 1) What you need

- A Linux server (or a computer) with:
  - Node.js 18+ and npm
  - FFmpeg (ffmpeg and ffprobe)
  - systemd (optional but recommended for auto-run at boot)
- Telegram API credentials (API_ID and API_HASH) from https://my.telegram.org
- Your numeric Telegram ID (TARGET_CHATID), or the target chat/channel/group ID

Optional but useful:
- A reverse proxy (e.g., Nginx) if you want HTTPS or a custom domain

---

### 1.1) Install prerequisites (Linux)

Below are quick ways to install Node.js 18+ (with npm) and FFmpeg (ffmpeg + ffprobe).

- Recommended: use nvm for Node.js so you can pick a specific version and keep it isolated per user.
- Alternatively: use your distro packages or the NodeSource repo.

Verify prerequisites after installation:

```bash
node -v
npm -v
ffmpeg -version | head -n1
ffprobe -version | head -n1
```

Ubuntu/Debian

Option A: nvm (recommended)
```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 18
```
Then install FFmpeg:
```bash
sudo apt update
sudo apt install -y ffmpeg
```

Option B: NodeSource + apt
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
sudo apt install -y ffmpeg
```

RHEL/CentOS/Alma/Rocky

Option A: NodeSource + dnf/yum
```bash
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo dnf install -y nodejs || sudo yum install -y nodejs
```
FFmpeg (via RPM Fusion; enable then install):
```bash
sudo dnf install -y epel-release || sudo yum install -y epel-release
# EL9: enable CRB; EL8: enable PowerTools
sudo dnf config-manager --set-enabled crb || sudo yum config-manager --set-enabled powertools || true
sudo dnf install -y https://download1.rpmfusion.org/free/el/rpmfusion-free-release-$(rpm -E %rhel).noarch.rpm || sudo yum install -y https://download1.rpmfusion.org/free/el/rpmfusion-free-release-$(rpm -E %rhel).noarch.rpm
sudo dnf install -y ffmpeg || sudo yum install -y ffmpeg
```

Arch/Manjaro
```bash
sudo pacman -Syu --noconfirm nodejs npm ffmpeg
```

Notes
- systemd is included by default on these distros; you can confirm with `systemctl --version`.
- If your distro packages provide Node < 18, prefer nvm or NodeSource to meet the 18+ requirement.

---

## 2) Install

Clone the repository and install the server dependencies.

```bash
# On your server
cd /var/www
git clone https://github.com/KDProgramming2025/Telegram-Uploader-WebUI.git uploader
cd uploader/server
npm install
npm run build
```

Create a downloads folder if it doesn’t exist:

```bash
sudo mkdir -p /var/www/dl
sudo chown -R $(whoami):$(whoami) /var/www/dl
```

---

## 3) Configure

Copy the example environment file and fill in your values.

```bash
cd /var/www/uploader
cp .env.example .env
```

Open `.env` and set:

- `PORT`: Web UI port (default 11000)
- `API_ID` and `API_HASH`: from https://my.telegram.org
- `TARGET_CHATID`: numeric Telegram ID of the destination (for Saved Messages, use your user ID)
- `UI_USERNAME` and `UI_PASSWORD`: the login you’ll enter in the web UI form

Security notes:
- `.env` is not committed to Git.
- `session.txt` (Telegram login session) is stored next to the app and is also ignored by Git.

---

## 4) Run the server

Quick run (foreground):

```bash
cd /var/www/uploader/server
npm run build
npm start
```

Systemd service (background):

```bash
sudo cp /var/www/uploader/server/uploader-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable uploader-server
sudo systemctl start uploader-server
sudo systemctl status uploader-server --no-pager
```

Open the Web UI at:

```
http://YOUR_SERVER_IP:11000
```

If you put the app behind a reverse proxy (recommended), visit the proxied path you configure instead (for example: `https://your-domain/uploader/`). See the next section for Nginx/Apache examples.

---

### 4.1) Reverse proxy (Nginx/Apache) and static /dl

Below are minimal, production-friendly examples to:
- Proxy the app under a path prefix, e.g. `/uploader/`
- Serve the Saved Files directory directly from your web server at `/dl/`

The examples assume default HTTP/HTTPS ports (80/443). Adjust as needed.

Note about SSE (live updates): This app uses Server-Sent Events. The Nginx/Apache examples include settings to avoid buffering so progress updates stream correctly.

#### Nginx

1) Create a snippet for the reverse proxy (optional but tidy):

File: `/etc/nginx/snippets/uploader_proxy.conf`

```
# Proxy the app at /uploader/ to the Node server on 127.0.0.1:11000
location /uploader/ {
  proxy_pass          http://127.0.0.1:11000/;  # trailing slash strips /uploader/
  proxy_http_version  1.1;
  proxy_set_header    Host                $host;
  proxy_set_header    X-Real-IP           $remote_addr;
  proxy_set_header    X-Forwarded-For     $proxy_add_x_forwarded_for;
  proxy_set_header    X-Forwarded-Proto   $scheme;
  proxy_set_header    Connection          "";   # keep-alive without hop-by-hop header

  # SSE: don't buffer, allow long-lived connections
  proxy_buffering     off;
  proxy_read_timeout  1h;
  proxy_send_timeout  1h;
}

# Serve Saved Files directly from disk at /dl/
location /dl/ {
  alias /var/www/dl/;           # note trailing slashes on both path and alias
  autoindex on;                  # optional: list files
  # You can add caching headers if desired
  # add_header Cache-Control "public, max-age=60";
}
```

2) Include the snippet in your server block. Example with default ports and optional TLS:

```
server {
  listen 80;
  server_name your-domain.com;

  include /etc/nginx/snippets/uploader_proxy.conf;
}

server {
  listen 443 ssl http2;
  server_name your-domain.com;
  ssl_certificate     /path/to/fullchain.pem;
  ssl_certificate_key /path/to/privkey.pem;

  include /etc/nginx/snippets/uploader_proxy.conf;
}
```

3) Test and reload Nginx:

```
sudo nginx -t && sudo systemctl reload nginx
```

Visit the app at: `https://your-domain.com/uploader/`

Your Saved Files will be available at: `https://your-domain.com/dl/`

Important: Keep the trailing slash on both `location /uploader/` and `proxy_pass .../` so Nginx rewrites `/uploader/...` to `/...` for the backend.

#### Apache (apache2)

1) Enable necessary modules:

```
sudo a2enmod proxy proxy_http headers ssl
sudo systemctl reload apache2
```

2) Add to your site’s VirtualHost. For HTTP:

File: e.g. `/etc/apache2/sites-available/your-domain.conf`

```
<VirtualHost *:80>
  ServerName your-domain.com

  # Reverse proxy for the app under /uploader/
  ProxyPreserveHost On
  RequestHeader set X-Forwarded-Proto expr=%{REQUEST_SCHEME}
  ProxyPass        /uploader/ http://127.0.0.1:11000/ retry=0 flushpackets=on
  ProxyPassReverse /uploader/ http://127.0.0.1:11000/

  # Serve Saved Files at /dl/
  Alias /dl/ "/var/www/dl/"
  <Directory "/var/www/dl/">
    Options +Indexes +FollowSymLinks
    AllowOverride None
    Require all granted
  </Directory>
</VirtualHost>
```

For HTTPS (replace cert paths with yours):

```
<IfModule mod_ssl.c>
<VirtualHost *:443>
  ServerName your-domain.com
  SSLEngine on
  SSLCertificateFile      /etc/letsencrypt/live/your-domain.com/fullchain.pem
  SSLCertificateKeyFile   /etc/letsencrypt/live/your-domain.com/privkey.pem

  ProxyPreserveHost On
  RequestHeader set X-Forwarded-Proto "https"
  ProxyPass        /uploader/ http://127.0.0.1:11000/ retry=0 flushpackets=on
  ProxyPassReverse /uploader/ http://127.0.0.1:11000/

  Alias /dl/ "/var/www/dl/"
  <Directory "/var/www/dl/">
    Options +Indexes +FollowSymLinks
    AllowOverride None
    Require all granted
  </Directory>
</VirtualHost>
</IfModule>
```

Then enable the site and reload Apache:

```
sudo a2ensite your-domain
sudo systemctl reload apache2
```

Visit the app at: `https://your-domain.com/uploader/`

Your Saved Files will be available at: `https://your-domain.com/dl/`

Notes:
- The trailing slashes on `ProxyPass /uploader/ http://127.0.0.1:11000/` ensure the `/uploader/` prefix is stripped before sending to the Node server.
- `flushpackets=on` helps stream SSE events without buffering.
- If you use a different path prefix, just substitute it consistently in both the proxy and your browser URL.

---

## 5) First-time Telegram login

You must sign in your Telegram account once so the server can upload on your behalf. A session will be saved to `session.txt`.

There is no separate UI form for this; use two simple API calls (you can use curl from your laptop or the server):

1) Ask Telegram to send you a login code:

```bash
curl -X POST http://YOUR_SERVER_IP:11000/auth/start -H 'Content-Type: application/json' -d '{"phone":"+1234567890"}'
```

2) Verify using the code you received in Telegram. If you have 2FA password enabled, include it as well.

#### Without 2FA password
```bash
curl -X POST http://YOUR_SERVER_IP:11000/auth/verify -H 'Content-Type: application/json' -d '{"code":"12345"}'
```

#### With 2FA password
```bash
curl -X POST http://YOUR_SERVER_IP:11000/auth/verify -H 'Content-Type: application/json' -d '{"code":"12345","password":"YOUR_2FA_PASSWORD"}'
```

If both calls return `ok`, your session is saved and you’re ready to upload.

Tip: if you ever rotate devices or worry a session was exposed, revoke it in the Telegram app (Settings → Devices → Terminate Other Sessions) and then run the login steps again.

---

## 6) Using the Web UI

Open the site in your browser (`http://YOUR_SERVER_IP:11000`).

- Enter your UI Username/Password (from `.env`) in the form at the top.
- Paste one or more file URLs (one per line).
- Optional: set a base File name (the original extension is kept automatically).
- Choose:
  - Upload → fetch the file and upload it to Telegram
  - Download → fetch and save it to the server (it appears under Saved Files)

Progress & Jobs
- You’ll see each job with status and a numeric percent.
- Remove removes jobs from the list. If a job is active, Remove cancels it and cleans up.
- “Remove All” appears only when there are jobs; it removes everything (active jobs are cancelled).

Saved Files panel
- Browse files in `/var/www/dl`.
- Click a file name to open/download it.
- Rename or Delete files/folders.
- “Upload” (arrow icon) on any file/folder enqueues upload(s) to Telegram. Folders add all files inside (alphabetically) and run sequentially.

Cookie upload for MeTube (optional)
- If you run MeTube on your server, you can upload `cookies.txt` and trigger a MeTube restart from the UI’s “Upload cookies.txt” button (it writes to `/opt/metube/cookies.txt`).

---

## 7) Special link support

- HLS streaming links (`.m3u8`) are supported. The server remuxes them into a single file (MP4/WEBM/TS chosen based on codecs) without re-encoding.
- MKV files are intentionally uploaded as documents (files) on Telegram, not as videos, for best compatibility.

---

## 8) Where files are stored

- Downloads folder: `/var/www/dl` (served at `/dl/<filename>`). You can change ownership/permissions if needed.
- Temporary files for in-progress uploads are stored under `/var/www/uploader/server/tmp`.
- Job state is persisted in `jobs.json` so the list can survive restarts (this file is not committed to Git by default).

---

## 9) Security & privacy

- Keep `.env` and `session.txt` private. They are ignored by Git and should never be uploaded publicly.
- If you accidentally exposed `session.txt`, immediately revoke sessions in the Telegram app and re-login (see above).
- UI requests require your UI username/password on each operation to prevent accidental or unauthorized actions.

---

## 10) Troubleshooting

- “Unauthorized”: The UI username/password in the form must match `UI_USERNAME`/`UI_PASSWORD` in `.env`.
- “User client not connected”: You haven’t logged in yet (see First-time Telegram login).
- Progress doesn’t move: Large files can take time; the app uses live updates. If many jobs are queued, uploads run one-by-one.
- ffmpeg/ffprobe not found: Install `ffmpeg` on your server.
- Upload order: Folder uploads enqueue files alphabetically and process them sequentially.
- Can’t abort mid-upload: Telegram uploads are best-effort cancellable; Remove will stop queued steps and prevent follow-ups.

---

## 11) Updating

```bash
cd /var/www/uploader
git pull
cd server
npm install
npm run build
sudo systemctl restart uploader-server
```

---

## 12) FAQ

- Can I upload to a specific chat or channel?
  - Yes. Set `TARGET_CHATID` to the numeric ID of your Saved Messages, chat, group, or channel. For channels, you may need to add the account as admin.

- Does it re-encode videos?
  - No. For `.m3u8` it remuxes (copy) into a single file; for other links it downloads as-is.

- Why does MKV upload as a file, not a video?
  - Telegram clients handle MKV variably; uploading as a document ensures compatibility.

---

Happy uploading!

```text
Project root: /var/www/uploader
Web UI:       http://YOUR_SERVER_IP:11000
Downloads:    /var/www/dl
```