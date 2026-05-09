#!/usr/bin/env bash
# ─── Mac Mini setup script ────────────────────────────────────────────────────
# Run ONCE on the server account after cloning the repo.
# Installs everything and wires up launchd so the gallery, admin panel,
# and Cloudflare Tunnel all start automatically at every boot.
#
# Usage:
#   cd /path/to/static-photos
#   bash scripts/setup.sh
#
# After this script completes, one manual step remains in the browser:
# set up Cloudflare Access to gate photos.ctsmith.org/admin
# (instructions printed at the end).

set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
TUNNEL_NAME="photos-ctsmith"

echo ""
echo "📷  Photo gallery setup"
echo "   Repo: $REPO"
echo ""

# ── 1. Homebrew ───────────────────────────────────────────────────────────────
if ! command -v brew &>/dev/null; then
  echo "→ Installing Homebrew…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add brew to PATH for this session (Apple Silicon)
  eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true
fi
echo "✓ Homebrew"

# ── 2. Install dependencies ───────────────────────────────────────────────────
echo "→ Installing Hugo, Caddy, Node, cloudflared…"
brew install hugo caddy node cloudflared 2>/dev/null || brew upgrade hugo caddy node cloudflared 2>/dev/null || true
echo "✓ Dependencies installed"

# Capture binary paths (needed for launchd, which doesn't inherit PATH)
NODE_BIN="$(which node)"
CADDY_BIN="$(which caddy)"
CLOUDFLARED_BIN="$(which cloudflared)"

echo "   node:        $NODE_BIN"
echo "   caddy:       $CADDY_BIN"
echo "   cloudflared: $CLOUDFLARED_BIN"
echo ""

# ── 3. Node packages ──────────────────────────────────────────────────────────
echo "→ Installing npm packages…"
cd "$REPO" && npm install --silent
cd "$REPO/admin" && npm install --silent
echo "✓ npm packages installed"

# ── 4. Initial build ──────────────────────────────────────────────────────────
echo "→ Building CSS and Hugo site…"
cd "$REPO"
npx tailwindcss -i site/assets/css/input.css -o site/static/css/style.css --minify 2>/dev/null
hugo --source "$REPO/site" --minify
echo "✓ Site built → $REPO/site/public"
echo ""

# ── 5. Cloudflare Tunnel ──────────────────────────────────────────────────────
echo "─────────────────────────────────────────────────────────────────────────"
echo "  CLOUDFLARE LOGIN"
echo "  A browser window will open. Log in to your Cloudflare account."
echo "  Come back here when it says 'You have successfully logged in'."
echo "─────────────────────────────────────────────────────────────────────────"
echo ""
read -p "  Press Enter to open the browser → " _
"$CLOUDFLARED_BIN" tunnel login
echo ""
echo "✓ Logged in to Cloudflare"
echo ""

# Create tunnel (skip if it already exists)
if "$CLOUDFLARED_BIN" tunnel info "$TUNNEL_NAME" &>/dev/null; then
  echo "✓ Tunnel '$TUNNEL_NAME' already exists — skipping creation"
else
  echo "→ Creating tunnel '$TUNNEL_NAME'…"
  "$CLOUDFLARED_BIN" tunnel create "$TUNNEL_NAME"
  echo "✓ Tunnel created"
fi

# Get the tunnel UUID
TUNNEL_ID=$("$CLOUDFLARED_BIN" tunnel info "$TUNNEL_NAME" 2>/dev/null \
  | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
  | head -1)

if [ -z "$TUNNEL_ID" ]; then
  echo "ERROR: Could not get tunnel ID. Run: cloudflared tunnel info $TUNNEL_NAME"
  exit 1
fi
echo "   Tunnel ID: $TUNNEL_ID"

# Write tunnel config
mkdir -p "$HOME/.cloudflared"
cat > "$HOME/.cloudflared/config.yml" <<CONFIG
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: photos.ctsmith.org
    service: http://localhost:80
  - service: http_status:404
CONFIG
echo "✓ Tunnel config written → ~/.cloudflared/config.yml"

# Create DNS record (CNAME photos.ctsmith.org → tunnel)
echo "→ Creating DNS record for photos.ctsmith.org…"
"$CLOUDFLARED_BIN" tunnel route dns "$TUNNEL_NAME" photos.ctsmith.org || \
  echo "  (DNS record may already exist — that's fine)"
echo "✓ DNS record set"
echo ""

# ── 6. Logs directory ─────────────────────────────────────────────────────────
mkdir -p "$REPO/logs"

# ── 7. launchd plists ─────────────────────────────────────────────────────────
echo "→ Writing launchd service files…"
mkdir -p "$PLIST_DIR"

# Admin panel
cat > "$PLIST_DIR/com.photos.admin.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>com.photos.admin</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${REPO}/admin/server.js</string>
  </array>
  <key>WorkingDirectory</key>  <string>${REPO}</string>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>         <true/>
  <key>StandardOutPath</key>   <string>${REPO}/logs/admin.log</string>
  <key>StandardErrorPath</key> <string>${REPO}/logs/admin.error.log</string>
</dict>
</plist>
PLIST

# Caddy (web server + reverse proxy)
cat > "$PLIST_DIR/com.photos.caddy.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>com.photos.caddy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${CADDY_BIN}</string>
    <string>run</string>
    <string>--config</string>
    <string>${REPO}/Caddyfile</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>REPO_ROOT</key>       <string>${REPO}</string>
  </dict>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>         <true/>
  <key>StandardOutPath</key>   <string>${REPO}/logs/caddy.log</string>
  <key>StandardErrorPath</key> <string>${REPO}/logs/caddy.error.log</string>
</dict>
</plist>
PLIST

# Cloudflare Tunnel
cat > "$PLIST_DIR/com.photos.cloudflared.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>com.photos.cloudflared</string>
  <key>ProgramArguments</key>
  <array>
    <string>${CLOUDFLARED_BIN}</string>
    <string>tunnel</string>
    <string>--config</string>
    <string>${HOME}/.cloudflared/config.yml</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>         <true/>
  <key>StandardOutPath</key>   <string>${REPO}/logs/cloudflared.log</string>
  <key>StandardErrorPath</key> <string>${REPO}/logs/cloudflared.error.log</string>
</dict>
</plist>
PLIST

echo "✓ launchd plists written"

# ── 8. Load services ──────────────────────────────────────────────────────────
echo "→ Starting services…"

for plist in com.photos.admin com.photos.caddy com.photos.cloudflared; do
  launchctl unload "$PLIST_DIR/${plist}.plist" 2>/dev/null || true
  launchctl load   "$PLIST_DIR/${plist}.plist"
done

echo "✓ Services started (and will restart automatically at every boot)"
echo ""

# ── Done ──────────────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════════════════"
echo ""
echo "  ✅  Setup complete!"
echo ""
echo "  Your gallery is live at:"
echo "  https://photos.ctsmith.org"
echo ""
echo "  Admin panel:"
echo "  https://photos.ctsmith.org/admin"
echo ""
echo "─────────────────────────────────────────────────────────────────────────"
echo "  ONE LAST STEP — set up Cloudflare Access (login gate for /admin)"
echo ""
echo "  1. Go to: https://one.dash.cloudflare.com"
echo "  2. Zero Trust → Access → Applications → Add an application"
echo "  3. Choose: Self-hosted"
echo "  4. Application name: Photo Admin"
echo "  5. Session duration: 24 hours (or whatever you like)"
echo "  6. Application domain: photos.ctsmith.org"
echo "     Path: admin*"
echo "  7. Add policy:"
echo "     - Policy name: Owner only"
echo "     - Action: Allow"
echo "     - Rule: Emails → your email address"
echo "  8. Save"
echo ""
echo "  Also protect the API:"
echo "  Repeat steps 2–8 with Path: api*  (same policy)"
echo ""
echo "  After that, /admin requires a login code sent to your email."
echo "  The public gallery remains open to everyone."
echo "─────────────────────────────────────────────────────────────────────────"
echo ""
echo "  Logs (if anything looks wrong):"
echo "  tail -f $REPO/logs/cloudflared.log"
echo "  tail -f $REPO/logs/admin.log"
echo "  tail -f $REPO/logs/caddy.log"
echo ""
