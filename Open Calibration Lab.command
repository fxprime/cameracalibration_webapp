#!/bin/zsh
cd "$(dirname "$0")"
if curl -fsS http://localhost:8765/health 2>/dev/null | /usr/bin/grep -q 'Camera Calibration Lab'; then
  open http://localhost:8765
  exit 0
fi
if [[ -x .venv/bin/python ]]; then
  export CALIB_PYTHON="$PWD/.venv/bin/python"
elif [[ -x /Users/thanabadeebulunseechart/.pyenv/versions/3.12.11/bin/python3 ]]; then
  export CALIB_PYTHON=/Users/thanabadeebulunseechart/.pyenv/versions/3.12.11/bin/python3
else
  export CALIB_PYTHON=python3
fi
cargo run &
lab_pid=$!
trap 'kill -INT "$lab_pid" 2>/dev/null' INT TERM EXIT
while kill -0 "$lab_pid" 2>/dev/null; do
  if curl -fsS http://localhost:8765/health >/dev/null 2>&1; then
    open http://localhost:8765
    break
  fi
  sleep 0.5
done
wait "$lab_pid"
