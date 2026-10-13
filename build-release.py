"""Build the Electron ASAR and external PowerShell scripts without npm/network.

The vendored pdf-lib UMD bundle is pinned to 1.17.1. The desktop executable is
reused from the existing installation; this builds the application payload only.
"""
from pathlib import Path
import hashlib
import json
import shutil
import struct

ROOT = Path(__file__).resolve().parent
RELEASE = ROOT / 'release' / 'resources'
BLOCK = 4 * 1024 * 1024

def digest(data):
    return hashlib.sha256(data).hexdigest()

def main():
    RELEASE.mkdir(parents=True, exist_ok=True)
    files = [ROOT / 'package.json']
    for folder in ('electron', 'dist', 'vendor'):
        files.extend(p for p in (ROOT / folder).rglob('*') if p.is_file() and p.name != 'SOURCES.md')
    header = {'files': {}}
    chunks = []
    offset = 0
    for file in sorted(files):
        rel = file.relative_to(ROOT)
        data = file.read_bytes()
        branch = header
        for part in rel.parts[:-1]:
            branch = branch['files'].setdefault(part, {'files': {}})
        branch['files'][rel.name] = {
            'size': len(data), 'offset': str(offset),
            'integrity': {'algorithm': 'SHA256', 'hash': digest(data),
                          'blockSize': BLOCK,
                          'blocks': [digest(data[i:i+BLOCK]) for i in range(0, len(data), BLOCK)]}
        }
        chunks.append(data)
        offset += len(data)
    raw = json.dumps(header, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    padding = b'\0' * ((-len(raw)) % 4)
    payload_size = 4 + len(raw) + len(padding)
    archive = struct.pack('<IIII', 4, payload_size + 4, payload_size, len(raw)) + raw + padding + b''.join(chunks)
    target = RELEASE / 'app.asar'
    target.write_bytes(archive)
    # Verify every packaged byte against the source before producing a manifest.
    base = 8 + payload_size + 4
    def verify(branch, rel=Path()):
        for name, entry in branch['files'].items():
            path = rel / name
            if 'files' in entry:
                verify(entry, path)
            else:
                start = base + int(entry['offset'])
                assert archive[start:start+entry['size']] == (ROOT/path).read_bytes(), path
    verify(header)
    scripts = RELEASE / 'scripts'
    scripts.mkdir(exist_ok=True)
    for file in (ROOT/'scripts').iterdir():
        if file.suffix not in ('.ps1', '.cs', '.dll'): continue
        if file.suffix == '.ps1':
            # Windows PowerShell 5.1 needs BOM to decode Korean source correctly.
            file.write_text(file.read_text(encoding='utf-8-sig'), encoding='utf-8-sig', newline='\n')
        shutil.copyfile(file, scripts/file.name)
    manifest = {str(p.relative_to(RELEASE)).replace('\\', '/'): digest(p.read_bytes())
                for p in sorted(RELEASE.rglob('*')) if p.is_file()}
    (ROOT/'release'/'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(f'Built and verified {len(files)} archive files; {len(manifest)} release files; ASAR {len(archive):,} bytes.')

if __name__ == '__main__':
    main()
