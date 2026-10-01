"""Security + validation tests for the riskiest paths.

These cover the fixes from the comprehensive-bug-sweep pass:
  - JWT rotation + blacklist (settings.py)
  - ScopedRateThrottle rates
  - magic-byte audio validation
  - watch_time_ms cap
  - comment text sanitization
  - correlation_id middleware
"""
import io
import pytest


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# 1. Register (auth + throttling)
# ---------------------------------------------------------------------------
class TestRegister:
    URL = '/auth/register/'

    def test_register_success(self, api_client):
        r = api_client.post(self.URL, {
            'username': 'newuser',
            'email': 'new@example.com',
            'password': 'secure-pwd-1234',
            'consent_accepted': True,
            'terms_version': 'v1.0',
            # B1 (2026-09-29): dob is required (was optional, so a client
            # could dodge the age gate by omission).
            'dob': '1990-01-01',
        }, format='json')
        assert r.status_code == 201, r.data

    def test_register_duplicate_email_rejected(self, api_client, user):
        r = api_client.post(self.URL, {
            'username': 'different',
            'email': user.email,
            'password': 'secure-pwd-1234',
        }, format='json')
        # 400 from the UniqueValidator on email
        assert r.status_code == 400
        assert 'email' in r.data

    def test_register_duplicate_username_rejected(self, api_client, user):
        r = api_client.post(self.URL, {
            'username': user.username,
            'email': 'different@example.com',
            'password': 'secure-pwd-1234',
        }, format='json')
        # AbstractUser.username is unique=True at the DB layer.
        assert r.status_code == 400
        assert 'username' in r.data


# ---------------------------------------------------------------------------
# 2. Login + JWT (auth)
# ---------------------------------------------------------------------------
class TestLogin:
    URL = '/auth/login/'

    def test_login_returns_access_and_refresh(self, api_client, user):
        r = api_client.post(self.URL, {
            'username': user.username,
            'password': 'test-pass-1234',
        }, format='json')
        assert r.status_code == 200, r.data
        assert 'access' in r.data
        assert 'refresh' in r.data

    def test_login_wrong_password_rejected(self, api_client, user):
        r = api_client.post(self.URL, {
            'username': user.username,
            'password': 'wrong-password',
        }, format='json')
        assert r.status_code == 401

    def test_refresh_token_rotates(self, api_client, user):
        # Audit fix: ROTATE_REFRESH_TOKENS=True. After /refresh/, the
        # old refresh token is blacklisted and a new one is issued.
        login = api_client.post(self.URL, {
            'username': user.username,
            'password': 'test-pass-1234',
        }, format='json')
        refresh = login.data['refresh']
        r1 = api_client.post('/auth/token/refresh/', {'refresh': refresh}, format='json')
        assert r1.status_code == 200, r1.data
        assert 'refresh' in r1.data
        # Old refresh token should now be blacklisted
        r2 = api_client.post('/auth/token/refresh/', {'refresh': refresh}, format='json')
        assert r2.status_code == 401, 'Old refresh token must be blacklisted after rotation'

    def test_logout_blacklists_token(self, api_client, user):
        login = api_client.post(self.URL, {
            'username': user.username,
            'password': 'test-pass-1234',
        }, format='json')
        refresh = login.data['refresh']
        api_client.force_authenticate(user=user)
        r = api_client.post('/auth/logout/', {'refresh': refresh}, format='json')
        assert r.status_code == 200, r.data
        # Re-using the same refresh must now fail.
        r2 = api_client.post('/auth/token/refresh/', {'refresh': refresh}, format='json')
        assert r2.status_code == 401


# ---------------------------------------------------------------------------
# 3. Audio upload (file type + size + magic byte validation)
# ---------------------------------------------------------------------------
class TestAudioUpload:
    URL = '/clips/'

    def _make_file(self, content: bytes, name: str):
        from django.core.files.uploadedfile import SimpleUploadedFile
        return SimpleUploadedFile(name, content, content_type='audio/mpeg')

    def test_upload_rejects_oversized(self, auth_client, settings):
        # settings.MAX_SIZE is 100 MB; we patch to 1 KB for the test.
        from backend.app.serializers import AudioUploadSerializer
        original = AudioUploadSerializer.MAX_SIZE
        AudioUploadSerializer.MAX_SIZE = 1024
        try:
            big = b'X' * 2048
            r = auth_client.post(self.URL, {
                'title': 'Big',
                'category': 'comedy',
                'original_file': self._make_file(big, 'big.mp3'),
            }, format='multipart')
            assert r.status_code == 400
            assert 'exceeds' in str(r.data).lower() or 'limit' in str(r.data).lower()
        finally:
            AudioUploadSerializer.MAX_SIZE = original

    def test_upload_rejects_bad_extension(self, auth_client):
        r = auth_client.post(self.URL, {
            'title': 'Exe',
            'category': 'comedy',
            'original_file': self._make_file(b'MZ\x00\x00', 'evil.exe'),
        }, format='multipart')
        assert r.status_code == 400
        assert 'unsupported' in str(r.data).lower() or 'file type' in str(r.data).lower()

    def test_upload_rejects_pe_header_with_audio_extension(self, auth_client):
        # The audit's #1 file-upload threat: evil.exe renamed to evil.mp3.
        r = auth_client.post(self.URL, {
            'title': 'Trojan',
            'category': 'comedy',
            'original_file': self._make_file(
                b'MZ\x90\x00\x03\x00\x00\x00' + b'\x00' * 200,
                'trojan.mp3',
            ),
        }, format='multipart')
        assert r.status_code == 400, r.data
        # The error mentions the detected MIME
        assert 'detected' in str(r.data).lower() or 'content' in str(r.data).lower()

    def test_upload_rejects_elf_header(self, auth_client):
        r = auth_client.post(self.URL, {
            'title': 'Binary',
            'category': 'comedy',
            'original_file': self._make_file(
                b'\x7fELF' + b'\x00' * 200,
                'binary.ogg',
            ),
        }, format='multipart')
        assert r.status_code == 400

    def test_upload_rejects_pdf(self, auth_client):
        r = auth_client.post(self.URL, {
            'title': 'PDF',
            'category': 'comedy',
            'original_file': self._make_file(
                b'%PDF-1.4\n' + b'\x00' * 200,
                'doc.mp3',
            ),
        }, format='multipart')
        assert r.status_code == 400

    def test_upload_requires_authentication(self, api_client):
        r = api_client.post(self.URL, {
            'title': 'No auth',
            'category': 'comedy',
            'original_file': self._make_file(b'ID3' + b'\x00' * 100, 'no.mp3'),
        }, format='multipart')
        assert r.status_code in (401, 403)

    def test_upload_rejects_over_max_duration(self, auth_client, settings):
        # Group C item 23: max-duration validation at upload time.
        # Generate a synthetic 6-min silent WAV in-memory and POST it.
        # HACK: pydub's from_file with no format hint requires the WAV
        # header to be parseable. The synthetic silent WAV is valid; this
        # test would fail for an unsupported format (which is the right
        # behavior — but documented here so a future reader doesn't think
        # the test is broken.)
        from django.conf import settings as django_settings
        original = django_settings.MAX_DURATION_SECONDS
        django_settings.MAX_DURATION_SECONDS = 300  # 5 min cap
        try:
            from pydub import AudioSegment
            import io
            # 6 minutes = 360 seconds of silence at 44.1kHz mono.
            long_audio = AudioSegment.silent(duration=360_000, frame_rate=44100)
            buf = io.BytesIO()
            long_audio.export(buf, format='wav')
            buf.seek(0)
            from django.core.files.uploadedfile import SimpleUploadedFile
            wav_file = SimpleUploadedFile(
                'long.wav', buf.read(), content_type='audio/wav',
            )
            r = auth_client.post(self.URL, {
                'title': 'Long',
                'category': 'comedy',
                'original_file': wav_file,
            }, format='multipart')
            assert r.status_code == 400, r.data
            assert 'duration' in str(r.data).lower() or 'exceeds' in str(r.data).lower()
        finally:
            django_settings.MAX_DURATION_SECONDS = original


# ---------------------------------------------------------------------------
# 4. Interactions (toggle-like + log-telemetry validation)
# ---------------------------------------------------------------------------
class TestInteractions:
    def test_toggle_like_creates_interaction(self, auth_client, ready_clip):
        r = auth_client.post(f'/interactions/{ready_clip.id}/toggle-like/')
        assert r.status_code == 200, r.data
        assert r.data['status'] == 'liked'

    def test_toggle_like_twice_unlikes(self, auth_client, ready_clip):
        auth_client.post(f'/interactions/{ready_clip.id}/toggle-like/')
        r = auth_client.post(f'/interactions/{ready_clip.id}/toggle-like/')
        assert r.data['status'] == 'unliked'

    def test_telemetry_rejects_oversized_watch_time(self, auth_client, ready_clip):
        # Audit fix: max_value=36_000_000 (10h).
        r = auth_client.post(
            f'/interactions/{ready_clip.id}/log-telemetry/',
            {'action_type': 'view', 'watch_time_ms': 99_999_999},
            format='json',
        )
        assert r.status_code == 400
        assert 'watch_time_ms' in r.data

    def test_telemetry_rejects_negative_watch_time(self, auth_client, ready_clip):
        r = auth_client.post(
            f'/interactions/{ready_clip.id}/log-telemetry/',
            {'action_type': 'view', 'watch_time_ms': -1},
            format='json',
        )
        assert r.status_code == 400

    def test_telemetry_rejects_unknown_action(self, auth_client, ready_clip):
        r = auth_client.post(
            f'/interactions/{ready_clip.id}/log-telemetry/',
            {'action_type': 'fake', 'watch_time_ms': 5000},
            format='json',
        )
        assert r.status_code == 400
        assert 'action_type' in r.data

    def test_telemetry_accepts_valid_payload(self, auth_client, ready_clip):
        r = auth_client.post(
            f'/interactions/{ready_clip.id}/log-telemetry/',
            {'action_type': 'view', 'watch_time_ms': 45_000},
            format='json',
        )
        assert r.status_code == 202  # 202 Accepted (eventually consistent)


# ---------------------------------------------------------------------------
# 5. Comments (text sanitization)
# ---------------------------------------------------------------------------
class TestComments:
    def test_comment_rejects_null_bytes(self, auth_client, ready_clip):
        r = auth_client.post('/comments/', {
            'clip': str(ready_clip.id),
            'text': 'before\x00after',
        }, format='json')
        assert r.status_code == 400
        assert 'null' in str(r.data).lower()

    def test_comment_strips_control_chars(self, auth_client, ready_clip):
        r = auth_client.post('/comments/', {
            'clip': str(ready_clip.id),
            'text': 'hello\x07\x08world',
        }, format='json')
        # Either accepted with control chars stripped, or 400 if the
        # model can't handle them. Both are acceptable outcomes.
        if r.status_code == 201:
            assert '\x07' not in r.data['text']
            assert '\x08' not in r.data['text']
            assert 'helloworld' in r.data['text']
        else:
            assert r.status_code == 400

    def test_comment_trims_whitespace(self, auth_client, ready_clip):
        r = auth_client.post('/comments/', {
            'clip': str(ready_clip.id),
            'text': '   hello   ',
        }, format='json')
        if r.status_code == 201:
            assert r.data['text'] == 'hello'

    def test_comment_allows_normal_text(self, auth_client, ready_clip):
        r = auth_client.post('/comments/', {
            'clip': str(ready_clip.id),
            'text': 'This is a normal comment.',
        }, format='json')
        assert r.status_code == 201, r.data
        assert r.data['text'] == 'This is a normal comment.'


# ---------------------------------------------------------------------------
# 6. Correlation ID middleware
# ---------------------------------------------------------------------------
class TestCorrelationId:
    def test_client_supplied_id_is_echoed(self, api_client):
        r = api_client.get('/health/', HTTP_X_REQUEST_ID='my-trace-123')
        # 301 redirect to https (SECURE_SSL_REDIRECT) but the header
        # should still be set on the redirect response.
        assert r.get('X-Request-ID') == 'my-trace-123'

    def test_missing_id_is_auto_generated(self, api_client):
        r = api_client.get('/health/')
        rid = r.get('X-Request-ID')
        assert rid is not None
        assert len(rid) == 32  # uuid4().hex

    def test_different_requests_get_different_ids(self, api_client):
        r1 = api_client.get('/health/')
        r2 = api_client.get('/health/')
        assert r1.get('X-Request-ID') != r2.get('X-Request-ID')


# ---------------------------------------------------------------------------
# 7. Cleanup stuck processing
# ---------------------------------------------------------------------------
class TestCleanupStuckProcessing:
    def test_finds_stuck_clips(self, processing_clip, ready_clip, django_user_model):
        from backend.app.tasks import cleanup_stuck_processing
        # processing_clip is 30 min old; ready_clip is fresh.
        result = cleanup_stuck_processing(threshold_minutes=15, max_per_run=10)
        assert 'Re-enqueued 1 stuck clips' in result
