#!/usr/bin/env bash
# FUZZ=1 stand-in for bots-dictation: no Speech/mic permission prompts, deterministic output.
# Speaks the helper protocol v2 (bug 101): `speak {json}` → speak-start/speak-end, mute/unmute.
# Bug 105: --list-devices, --meter, --test-speaker and the `devices {json}` stdin command.
for a in "$@"; do
  case "$a" in
    --list-devices)
      echo '{"type":"devices","devices":[{"uid":"FakeMic","name":"Fake Microphone","input":true,"output":false,"transport":"built-in","defaultInput":true,"defaultOutput":false},{"uid":"FakeSpeaker","name":"Fake Speakers","input":false,"output":true,"transport":"built-in","defaultInput":false,"defaultOutput":true},{"uid":"FakeUSB","name":"Fake USB Headset","input":true,"output":true,"transport":"usb","defaultInput":false,"defaultOutput":false}]}'
      exit 0 ;;
    --test-speaker)
      echo '{"type":"devices","input":null,"output":{"uid":"FakeSpeaker","name":"Fake Speakers"},"echoCancellation":false}'
      echo '{"type":"end"}'
      exit 0 ;;
    --meter)
      echo '{"type":"ready","source":"meter"}'
      for db in -50 -35 -20 -35; do echo "{\"type\":\"level\",\"db\":$db}"; done
      while read -r line; do [ "$line" = "stop" ] && break; done
      echo '{"type":"end"}'
      exit 0 ;;
  esac
done
echo '{"type":"ready","source":"fake","mode":"dictation","onDevice":true}'
echo '{"type":"audio","source":"fake","sampleRate":16000,"channels":1}'
while read -r line; do
  case "$line" in
    stop)
      echo '{"type":"final","text":"testing one two"}'
      echo '{"type":"end"}'
      exit 0 ;;
    speak\ *)
      id=$(printf '%s' "$line" | sed -E 's/.*"id":"([A-Za-z0-9_-]{1,64})".*/\1/')
      echo "{\"type\":\"speak-start\",\"id\":\"$id\",\"voice\":\"fake\"}"
      echo "{\"type\":\"speak-end\",\"id\":\"$id\",\"interrupted\":false,\"seconds\":0}" ;;
    devices\ *)
      echo '{"type":"devices","input":{"uid":"FakeMic","name":"Fake Microphone"},"output":{"uid":"FakeSpeaker","name":"Fake Speakers"},"echoCancellation":true}' ;;
    mute) echo '{"type":"muted","muted":true}' ;;
    unmute) echo '{"type":"muted","muted":false}' ;;
  esac
done
echo '{"type":"end"}'
