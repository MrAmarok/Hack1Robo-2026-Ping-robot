#!/usr/bin/env bash
# Run on the VPS as the account that should run the Ping server.
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
server_dir="$(pwd -P)"
service_user="$(id -un)"
service=ping-server.service
port="${PORT:-3000}"

if [[ ! "$port" =~ ^[1-9][0-9]{0,4}$ ]] || (( port > 65535 )); then
  echo "PORT must be an integer from 1 to 65535." >&2
  exit 1
fi

if ! command -v uv >/dev/null; then
  echo "Install uv and make it available on PATH before running this script." >&2
  exit 1
fi

UV_PROJECT_ENVIRONMENT="$server_dir/.venv" uv sync --locked --no-dev

as_root=()
if (( EUID != 0 )); then
  as_root=(sudo)
fi

# systemd expands percent specifiers in paths. ExecStart also parses quotes
# and backslashes, so escape those characters for the executable path.
unit_dir="${server_dir//%/%%}"
python_path="$unit_dir/.venv/bin/python"
python_path="${python_path//\\/\\\\}"
python_path="${python_path//\"/\\\"}"

unit_file="$(mktemp)"
trap 'rm -f -- "$unit_file"' EXIT
cat > "$unit_file" <<EOF
[Unit]
Description=Ping server (FastAPI and Socket.IO)
After=network.target

[Service]
Type=exec
User=$service_user
WorkingDirectory=$unit_dir
Environment=PORT=$port
ExecStart=:"$python_path" -m uvicorn app.main:app --host 0.0.0.0 --port $port
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

"${as_root[@]}" install -m 0644 -- "$unit_file" "/etc/systemd/system/$service"
"${as_root[@]}" systemctl daemon-reload
"${as_root[@]}" systemctl restart "$service"
"${as_root[@]}" systemctl enable "$service"

printf 'Check the server: curl -fsS http://127.0.0.1:%s/health\n' "$port"
printf 'Follow the logs: sudo journalctl -u %s -f\n' "$service"
