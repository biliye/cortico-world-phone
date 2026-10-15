#!/usr/bin/env python3
"""Preview (default) or apply the Pulse idle setting; never restart a service."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default='/opt/rtc/bridge.json')
    parser.add_argument('--boot', default='/opt/rtc-src/boot-rtc.sh')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    config_path, boot_path = Path(args.config), Path(args.boot)
    original = config_path.read_bytes()
    cfg = json.loads(original)
    if cfg['audio']['backend'] != 'pulse':
        raise RuntimeError('Only the Pulse backend is supported')
    old = cfg['audio'].get('idleDrainMs', 100)
    if old not in (100, 1500):
        raise RuntimeError('Unexpected idleDrainMs; inspect before overwriting')
    token = Path(cfg['tokenFile']).read_text().strip()
    request = urllib.request.Request(
        'http://127.0.0.1:' + str(cfg['port']) + '/v1/status',
        headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=5) as response:
        status = json.load(response)
    active = [c for c in status.get('calls', []) if c.get('state') not in ('ended', 'failed')]
    if active:
        raise RuntimeError('Active call present; do not change playback configuration')
    boot = boot_path.read_bytes()
    # Preserve every other byte of the deployment's startup script.
    pattern = rb'(?m)^(\s*)"frameMs": 20,\r?$'
    if b'"idleDrainMs"' in boot:
        if b'"idleDrainMs": 1500,' not in boot:
            raise RuntimeError('Unexpected startup idleDrainMs; inspect first')
        next_boot = boot
    else:
        matches = list(re.finditer(pattern, boot))
        if len(matches) != 1:
            raise RuntimeError('Startup audio block is not uniquely identifiable')
        match = matches[0]
        newline = b'\r\n' if match.group().endswith(b'\r') else b'\n'
        next_boot = boot[:match.end()] + newline + match.group(1) + b'"idleDrainMs": 1500,' + boot[match.end():]
    cfg['audio']['idleDrainMs'] = 1500
    next_config = (json.dumps(cfg, ensure_ascii=False, indent=2) + '\n').encode()
    changes = [(config_path, original, next_config), (boot_path, boot, next_boot)]
    changes = [(p, before, after) for p, before, after in changes if before != after]
    print(json.dumps({'mode': 'apply' if args.apply else 'preview', 'activeCalls': 0,
                      'idleDrainMs': {'before': old, 'after': 1500},
                      'files': [str(p) for p, _, _ in changes], 'restartPerformed': False}))
    if not args.apply:
        return
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backups = []
    for path, before, _ in changes:
        if path.read_bytes() != before:
            raise RuntimeError('File changed during preflight: ' + str(path))
        backup = Path(str(path) + '.before-playback-idle-' + stamp)
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(before)
        backups.append(str(backup))
    for path, _, after in changes:
        stat = path.stat()
        fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(after)
                os.fchmod(stream.fileno(), stat.st_mode & 0o777)
                os.fchown(stream.fileno(), stat.st_uid, stat.st_gid)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    print(json.dumps({'backups': backups, 'restartRequired': True}))


if __name__ == '__main__':
    main()
