# Downloads every image in resolved.json into assets/sound-art/ as a 256px
# square JPEG, so the app ships its sound art and never hotlinks at runtime.
# Usage (needs Pillow): python3 tools/sound-art/fetch.py
import hashlib, io, json, os, sys, time, urllib.error, urllib.request
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
RESOLVED = os.path.join(ROOT, 'tools', 'sound-art', 'resolved.json')
ART = os.path.join(ROOT, 'assets', 'sound-art')
UA = {'User-Agent': 'BeatriceVoiceChanger/2.2 (https://github.com/satiricalguru/Beatrice-voicechanger-mac)'}


def get(url):
    for attempt in range(4):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read()
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            time.sleep(3 * (attempt + 1))
    raise RuntimeError('rate-limited ' + url)


def square(im):
    # Logos are often transparent: flatten onto white. Wide images (logos,
    # box art banners) are letterboxed so the subject isn't cropped away.
    im = im.convert('RGBA')
    bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
    im = Image.alpha_composite(bg, im).convert('RGB')
    w, h = im.size
    if w / h > 1.4:
        canvas = Image.new('RGB', (w, w), im.getpixel((0, 0)))
        canvas.paste(im, (0, (w - h) // 2))
        im = canvas
    else:
        s = min(w, h)
        top = 0 if h > w else (h - s) // 2  # portraits: keep the face at the top
        im = im.crop(((w - s) // 2, top, (w - s) // 2 + s, top + s))
    return im.resize((256, 256), Image.LANCZOS)


resolved = json.load(open(RESOLVED))
done = {}
for sid, v in resolved.items():
    url = v.get('url')
    if not url:
        continue
    if url not in done:
        name = hashlib.sha1(url.encode()).hexdigest()[:10] + '.jpg'
        try:
            square(Image.open(io.BytesIO(get(url)))).save(os.path.join(ART, name), quality=84)
        except Exception as e:
            print('FAILED', sid, e, file=sys.stderr)
            continue
        done[url] = name
        time.sleep(0.3)
    v['file'] = 'assets/sound-art/' + done[url]
json.dump(resolved, open(RESOLVED, 'w'), indent=2)
open(RESOLVED, 'a').write('\n')
print(len(done), 'images')
