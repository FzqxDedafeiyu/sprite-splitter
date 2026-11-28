import json
import struct
import sys
from io import BytesIO
from pathlib import PurePosixPath
from zipfile import BadZipFile, ZipFile
from PIL import Image


def inspect(path):
    with ZipFile(path) as archive:
        names = archive.namelist()
        assert len(names) == len(set(names)), 'duplicate ZIP entry'
        for name in names:
            parts = PurePosixPath(name).parts
            assert not name.startswith('/') and '\\' not in name and ':' not in name
            assert '..' not in parts
        assert archive.testzip() is None, 'CRC failure'
        manifests = [name for name in names if name.endswith('.json')]
        assert len(manifests) == 1
        data = json.loads(archive.read(manifests[0]))
        assert data['format'] == 'spatial-scene-layout/v2'
        sprites = data['sprites']
        assert len({s['id'] for s in sprites}) == len(sprites)
        assert {'sprites/' + s['file'] for s in sprites} == set(names) - set(manifests)
        for sprite in sprites:
            png = archive.read('sprites/' + sprite['file'])
            assert png[:8] == bytes.fromhex('89504e470d0a1a0a') and png[12:16] == b'IHDR'
            rect = sprite['sourceRect']
            assert struct.unpack_from('>II', png, 16) == (rect['width'], rect['height'])
            with Image.open(BytesIO(png)) as image:
                image.load()
                assert image.mode == 'RGBA'
        print(json.dumps({
            'members': len(names), 'sprites': len(sprites), 'canvas': data['canvas'],
            'unicode_names': sum(not s['file'].isascii() for s in sprites),
            'manifest_entry': manifests[0], 'crc': 'pass', 'dimensions': 'pass', 'rgba_decode': 'pass'
        }, ensure_ascii=True))


if __name__ == '__main__':
    inspect(sys.argv[1])
    try:
        inspect(BytesIO(b'PK\x03\x04'))
    except BadZipFile:
        print('truncated input rejected')
    else:
        raise AssertionError('truncated input accepted')
