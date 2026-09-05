"""Decode HEIC separately so timeout also bounds native decoder work."""
import sys
import warnings

from PIL import Image, ImageOps
from pillow_heif import register_heif_opener


def decode(source, target):
    register_heif_opener(thumbnails=False, decode_threads=1)
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(source) as image:
            image = ImageOps.exif_transpose(image)
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            image.info.clear()
            image.save(target, format="PNG")


if __name__ == "__main__":
    decode(sys.argv[1], sys.argv[2])
