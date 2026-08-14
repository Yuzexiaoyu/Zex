#!/bin/bash
cd "$(dirname "$0")"
echo "Launching ZEX..."
"./src-tauri/target/debug/zex.exe" &
