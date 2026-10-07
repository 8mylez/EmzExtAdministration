#!/usr/bin/env python3
"""Install the pinned, unmodified Ext JS GPL runtime from Sencha's SDK archive."""

import argparse
import hashlib
from pathlib import Path
import shutil
import tempfile
import urllib.request
import zipfile

URL = 'https://cdn.sencha.com/ext/gpl/ext-7.0.0-gpl.zip'
SHA256 = '4afa3328474486173eb7cdd04f67d1ad241c4972b50cd7e0656bc1fbb4df757c'
DESTINATION = Path(__file__).resolve().parents[1] / 'src/Resources/public/vendor/ext'


def install(archive):
    with archive.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    if digest != SHA256:
        raise ValueError('SDK-Prüfsumme stimmt nicht mit Ext JS 7.0.0 GPL überein.')
    count = 0
    with zipfile.ZipFile(archive) as sdk:
        for member in sdk.infolist():
            path = member.filename.removeprefix('ext-7.0.0/')
            runtime = path.removeprefix('build/')
            include = path in ('license.txt', 'license-include.txt') or path.startswith('build/') and (
                runtime in ('ext-all.js', 'classic/locale/locale-de.js', 'classic/theme-triton/theme-triton.js')
                or runtime.startswith('classic/theme-triton/resources/')
            )
            if not include or member.is_dir() or '-debug' in runtime or '-rtl' in runtime:
                continue
            target = DESTINATION / runtime
            if not target.resolve().is_relative_to(DESTINATION.resolve()):
                raise ValueError('Ungültiger SDK-Dateipfad.')
            target.parent.mkdir(parents=True, exist_ok=True)
            with sdk.open(member) as source, target.open('wb') as output:
                shutil.copyfileobj(source, output)
            count += 1
    print(f'Ext JS 7.0.0 GPL: {count} Dateien nach {DESTINATION} installiert.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, help='Bereits heruntergeladenes ext-7.0.0-gpl.zip')
    args = parser.parse_args()
    if args.archive:
        install(args.archive)
        return
    with tempfile.TemporaryDirectory(prefix='emz-ext-sdk-') as directory:
        archive = Path(directory) / 'ext-7.0.0-gpl.zip'
        print(f'Lade SDK von {URL} (ca. 230 MB) …')
        with urllib.request.urlopen(URL, timeout=120) as response, archive.open('wb') as output:
            shutil.copyfileobj(response, output)
        install(archive)


if __name__ == '__main__':
    main()
