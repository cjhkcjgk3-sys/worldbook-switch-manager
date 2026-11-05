"""Build an installable, dependency-free ZIP with one top-level extension folder."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
import json

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'manifest.json').read_text())['version']
out = root.parent / f'worldbook-switch-manager-v{version}.zip'
files = ['manifest.json', 'index.js', 'core.js', 'controller.js', 'host-adapter.js', 'ui.js', 'style.css',
         'capability-contract.json', 'README.md', 'package.json', 'NEXT.md', '.gitignore', 'LICENSE']
for folder in ['docs', 'tests', 'scripts']:
    files += [str(p.relative_to(root)) for p in (root / folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
with ZipFile(out, 'w', ZIP_DEFLATED) as archive:
    for name in sorted(files):
        archive.write(root / name, f'worldbook-switch-manager/{name}')
checksum = hashlib.sha256(out.read_bytes()).hexdigest()
out.with_suffix('.zip.sha256').write_text(f'{checksum}  {out.name}\n')
print(f'{out}\nSHA256 {checksum}')
