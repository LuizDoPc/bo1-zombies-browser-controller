#!/bin/zsh
cd "$(dirname "$0")" || exit 1
printf 'BO1 Zombies — Kino der Toten\nAbra no Chrome: http://localhost:8000/bo1z/kino\nMantenha este terminal aberto. Para encerrar: Ctrl+C.\n\n'
python3 -u run-local.py
