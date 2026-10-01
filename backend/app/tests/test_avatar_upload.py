"""Avatar upload validation (B1, docs/frontend_rebuild_plan.md §4).

`ProfileUpdateSerializer` declared `profile_picture` with a username check and
nothing else, so any authenticated user could POST an arbitrarily large file to
object storage. The frontend label ("Max 5MB") enforced nothing on either side.

Scope note, because it changes what these tests can and cannot claim:
`profile_picture` is `models.ImageField`, so DRF already validates *content*
via Pillow's real decode. The gap was the size cap and the extension
allowlist — not content sniffing. The content assertions below are therefore
regression guards on the pre-existing Pillow behaviour (they document that the
size/extension checks did not weaken it), not new coverage.
"""
import io

import pytest

from backend.app.serializers import ProfileUpdateSerializer


pytestmark = pytest.mark.django_db


def _real_image(fmt: str = 'PNG', size=(8, 8), noisy: bool = False) -> bytes:
    """A genuinely decodable image, so content checks are exercised for real.

    Using a synthetic header would test Pillow's rejection of garbage rather
    than the size/extension rules, and the two failure modes are
    indistinguishable from the error text alone.

    `noisy=True` fills the image with incompressible random data, which is the
    only way to make a PNG exceed megabytes — a flat-colour 1400x1400 PNG is
    9 KB, not 6 MB, so a solid-colour fixture silently fails to exercise the
    size cap at all.
    """
    import os

    from PIL import Image

    width, height = size
    if noisy:
        pixels = Image.frombytes(
            'RGB', (width, height), os.urandom(width * height * 3)
        )
    else:
        pixels = Image.new('RGB', size, (120, 90, 60))

    buffer = io.BytesIO()
    pixels.save(buffer, format=fmt)
    return buffer.getvalue()


# Payloads a rename attack would carry: a valid `.png` extension over content
# Pillow cannot decode.
PE_EXE = b'MZ\x90\x00\x03\x00\x00\x00' + b'\x00' * 200
ELF = b'\x7fELF' + b'\x00' * 200
SCRIPT = b'#!/bin/sh\nrm -rf /\n' + b'\x00' * 200
PDF = b'%PDF-1.4\n' + b'\x00' * 200
GIF = b'GIF89a' + b'\x00' * 200
PLAIN_TEXT = b'this is just some text, not an image at all' * 8


def _upload(content: bytes, name: str = 'avatar.png'):
    from django.core.files.uploadedfile import SimpleUploadedFile
    return SimpleUploadedFile(name, content, content_type='application/octet-stream')


def _run(user, upload):
    """Drive the serializer exactly as `views/profile.py::update_me` does."""
    from rest_framework.test import APIRequestFactory

    request = APIRequestFactory().patch('/profile/me/update/')
    request.user = user
    serializer = ProfileUpdateSerializer(
        user, data={'profile_picture': upload}, partial=True, context={'request': request}
    )
    return serializer.is_valid(), serializer


class TestAvatarSizeLimit:
    """The actual vulnerability: no upper bound on bytes."""

    def test_rejects_file_over_5mb(self, user, settings):
        # Shrink the cap rather than allocating 5 MB of padding per test.
        monkey = 1024
        original = ProfileUpdateSerializer.MAX_SIZE
        ProfileUpdateSerializer.MAX_SIZE = monkey
        try:
            valid, serializer = _run(user, _upload(_real_image() + b'\x00' * 4096))
        finally:
            ProfileUpdateSerializer.MAX_SIZE = original

        assert valid is False
        assert 'exceeds' in str(serializer.errors).lower()

    def test_accepts_file_at_the_cap(self, user):
        original = ProfileUpdateSerializer.MAX_SIZE
        ProfileUpdateSerializer.MAX_SIZE = 64 * 1024
        try:
            valid, serializer = _run(user, _upload(_real_image()))
        finally:
            ProfileUpdateSerializer.MAX_SIZE = original

        assert valid is True, serializer.errors

    def test_production_cap_is_five_megabytes(self):
        assert ProfileUpdateSerializer.MAX_SIZE == 5 * 1024 * 1024

    def test_rejects_a_genuinely_oversized_image(self, user):
        """Unpatched: a real >5 MB image is the case the fix exists for.

        Incompressible random pixels, because a flat-colour PNG of the same
        dimensions is a few KB and would not reach the cap.
        """
        oversized = _real_image(size=(1600, 1600), fmt='PNG', noisy=True)
        assert len(oversized) > 5 * 1024 * 1024, (
            f'fixture is {len(oversized)} bytes, must exceed '
            f'{5 * 1024 * 1024} to exercise the cap'
        )
        valid, serializer = _run(user, _upload(oversized))

        assert valid is False
        assert 'exceeds' in str(serializer.errors).lower()


class TestAvatarExtension:
    @pytest.mark.parametrize('name,fmt', [
        ('avatar.jpg', 'JPEG'),
        ('avatar.jpeg', 'JPEG'),
        ('avatar.png', 'PNG'),
        ('avatar.webp', 'WEBP'),
        ('AVATAR.PNG', 'PNG'),
        ('avatar.JPEG', 'JPEG'),
    ])
    def test_accepts_allowed_extensions(self, user, name, fmt):
        valid, serializer = _run(user, _upload(_real_image(fmt), name))
        assert valid is True, serializer.errors

    @pytest.mark.parametrize('name,fmt', [
        ('avatar.gif', 'GIF'),    # Pillow-decodable, not in our allowlist
        ('avatar.bmp', 'BMP'),
        ('avatar.tiff', 'TIFF'),
        ('avatar.xbm', 'XBM'),
    ])
    def test_rejects_pillow_formats_we_do_not_allow(self, user, name, fmt):
        """The layer `validate_profile_picture` actually owns.

        DRF's `ImageField` already has a broad extension allowlist derived from
        Pillow's registered formats, so it rejects `.exe` / `.pdf` / `.sh` on
        its own. What it does *not* do is restrict to the three formats an
        avatar should be. These cases are decodable by Pillow, so DRF passes
        them and our narrower allowlist is what stops them.
        """
        try:
            content = _real_image(fmt)
        except Exception:
            pytest.skip(f'Pillow cannot encode {fmt} in this image')

        valid, serializer = _run(user, _upload(content, name))

        assert valid is False, f'{name} was accepted'
        assert 'unsupported' in str(serializer.errors).lower()

    @pytest.mark.parametrize('name', [
        'evil.exe', 'doc.pdf', 'payload.sh', 'script.py', 'archive.zip',
    ])
    def test_rejects_non_image_extensions(self, user, name):
        """Rejected regardless of which layer catches them.

        Asserting only on the outcome, not the message: the rejection comes
        from Pillow's decode in the cases where the content is also
        non-image, and from the extension check when the content happens to be
        a real image. Pinning the error text here would couple the test to
        which of two layers fired.
        """
        valid, serializer = _run(user, _upload(PE_EXE, name))
        assert valid is False, f'{name} was accepted'

        # A real image under the same bad extension must also be refused —
        # that is the case Pillow cannot catch on its own.
        valid_real_content, serializer_real = _run(user, _upload(_real_image(), name))
        assert valid_real_content is False, f'a PNG named {name} was accepted'
        assert 'unsupported' in str(serializer_real.errors).lower() or \
               'not allowed' in str(serializer_real.errors).lower()


class TestAvatarContent:
    """Regression guard: adding size/extension checks must not weaken Pillow.

    These rejections come from DRF's `ImageField` → `Image.open()`, which
    predates B1. They are asserted here so a future refactor that swaps
    `ImageField` for a plain `FileField` — a plausible-looking way to make
    arbitrary uploads "work" — fails loudly.
    """

    @pytest.mark.parametrize('content,label', [
        (PE_EXE, 'PE executable'),
        (ELF, 'ELF executable'),
        (SCRIPT, 'shell script'),
        (PDF, 'PDF document'),
        (GIF, 'GIF image'),
    ])
    def test_rejects_non_image_content_with_image_extension(self, user, content, label):
        valid, serializer = _run(user, _upload(content, 'avatar.png'))

        assert valid is False, f'{label} was accepted as an avatar'
        assert 'image' in str(serializer.errors).lower()

    def test_rejects_plain_text(self, user):
        valid, serializer = _run(user, _upload(PLAIN_TEXT, 'avatar.png'))
        assert valid is False

    def test_rejects_empty_file(self, user):
        valid, serializer = _run(user, _upload(b'', 'avatar.png'))
        assert valid is False

    def test_rejects_truncated_image(self, user):
        # Header present, body cut short — the shape a fuzzer produces.
        truncated = _real_image()[:20]
        valid, serializer = _run(user, _upload(truncated, 'avatar.png'))
        assert valid is False


class TestAvatarViewIntegration:
    """The same guarantees through the actual PATCH endpoint."""

    URL = '/profile/me/update/'

    def test_patch_rejects_renamed_executable(self, auth_client):
        r = auth_client.patch(
            self.URL, {'profile_picture': _upload(PE_EXE, 'avatar.png')}, format='multipart'
        )
        assert r.status_code == 400, r.data
        assert 'profile_picture' in r.data

    def test_patch_rejects_bad_extension(self, auth_client):
        r = auth_client.patch(
            self.URL, {'profile_picture': _upload(PE_EXE, 'avatar.exe')}, format='multipart'
        )
        assert r.status_code == 400, r.data
        assert 'profile_picture' in r.data

    def test_patch_rejects_oversized(self, auth_client, monkeypatch):
        monkeypatch.setattr(ProfileUpdateSerializer, 'MAX_SIZE', 1024)
        r = auth_client.patch(
            self.URL,
            {'profile_picture': _upload(_real_image() + b'\x00' * 4096)},
            format='multipart',
        )
        assert r.status_code == 400, r.data

    def test_patch_does_not_save_an_invalid_image(self, auth_client, user):
        before = str(user.profile_picture or '')
        auth_client.patch(
            self.URL, {'profile_picture': _upload(PE_EXE, 'avatar.png')}, format='multipart'
        )
        user.refresh_from_db()
        assert str(user.profile_picture or '') == before

    def test_username_still_validates(self, auth_client, other_user):
        """The pre-existing check must survive the addition."""
        r = auth_client.patch(self.URL, {'username': other_user.username}, format='multipart')
        assert r.status_code == 400
        assert 'username' in r.data

    def test_username_only_patch_still_works(self, auth_client):
        r = auth_client.patch(self.URL, {'username': 'renamed-alice'}, format='multipart')
        assert r.status_code == 200, r.data
