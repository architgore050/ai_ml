"""Two input gates in `backend/app/serializers.py` that did not fire.

1. `RegisterSerializer` never called `validate_password()`, so
   `AUTH_PASSWORD_VALIDATORS` (four validators, fully configured in
   `EchoFlow/settings.py:467-480`) was dead code on the registration path.
   `POST /auth/register/` with `password: "123"` returned 201.

2. `AudioUploadSerializer.validate()` required `copyright_acknowledgement`
   unconditionally. DRF's `partial=True` skips *field-level* validation for
   absent fields but still calls the object-level `validate()`, so every
   `PATCH /clips/{id}/` that did not re-send the acknowledgement got a 400.
   The clip-edit feature could never have worked end to end.

The two halves of the copyright gate are pinned separately on purpose: making
`PATCH` work by dropping the requirement outright would also drop the legal
gate on `POST`, and a test that only checked "PATCH now returns 200" would
happily pass on that broken fix. Test 7 is the counterweight to test 6.
"""
import io

import pytest
from django.urls import reverse

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Throttle budget
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _throttle_budget(settings):
    """Raise the scopes these tests spend budget on.

    Why not `clear_throttle_cache`: that fixture calls `cache.clear()` on the
    shared Redis, and the feed queues (`user_feed:{id}`) live in that same
    Redis — so clearing it would wipe state belonging to whatever else is
    running against this stack. Reassigning `REST_FRAMEWORK` with a fresh
    dict is enough to make DRF recompute its cached settings (its
    `setting_changed` receiver fires on the assignment) and does not touch
    any stored data.

    The counters themselves are still in Redis, so the point is only to stop
    a *rate* from being mistaken for a *validation* result.
    """
    rates = dict(settings.REST_FRAMEWORK['DEFAULT_THROTTLE_RATES'])
    for scope in ('upload', 'register', 'register_username', 'anon', 'user'):
        rates[scope] = '10000/hour'
    settings.REST_FRAMEWORK = {
        **settings.REST_FRAMEWORK,
        'DEFAULT_THROTTLE_RATES': rates,
    }


# ---------------------------------------------------------------------------
# Password (Finding 1)
# ---------------------------------------------------------------------------

def _register(client, *, username, password, email=None, dob='1990-01-01'):
    """POST /auth/register/ with a complete, otherwise-valid payload.

    Every field the regulatory gate needs is supplied, so the only thing
    that can turn a case into a 400 is the password.
    """
    return client.post(reverse('register'), {
        'username': username,
        'email': email or f'{username}@example.com',
        'password': password,
        'consent_accepted': True,
        'terms_version': 'v1.0',
        'dob': dob,
    })


class TestPasswordPolicy:
    """`AUTH_PASSWORD_VALIDATORS` must actually run on registration.

    The validator set is fixed in settings.py:467-480 — all four classes are
    enabled with their default arguments, so the table below is read off
    `settings.AUTH_PASSWORD_VALIDATORS` rather than assumed.
    """

    def test_the_four_validators_are_configured(self, settings):
        """Pins the premise. If someone removes a validator from settings,
        the per-validator tests below would start failing for the wrong
        reason, and this says which configuration they were written against.
        """
        names = [v['NAME'] for v in settings.AUTH_PASSWORD_VALIDATORS]
        assert names == [
            'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
            'django.contrib.auth.password_validation.MinimumLengthValidator',
            'django.contrib.auth.password_validation.CommonPasswordValidator',
            'django.contrib.auth.password_validation.NumericPasswordValidator',
        ]

    def test_short_password_rejected_and_no_user_created(self, api_client):
        from backend.app.models import User

        before = User.objects.count()
        r = _register(api_client, username='shortpw', password='123')

        assert r.status_code == 400, r.content
        assert User.objects.count() == before, (
            "a rejected registration must not leave a User row behind"
        )
        assert not User.objects.filter(username='shortpw').exists()

    def test_minimum_length_validator_enforced(self, api_client):
        """`Vg7!q` is 5 chars, not common, and not numeric — so the only
        rule it can trip is MinimumLengthValidator (min_length=8).
        """
        r = _register(api_client, username='minlen', password='Vg7!q')

        assert r.status_code == 400, r.content
        messages = r.json()['password']
        assert any('too short' in m for m in messages), messages
        # Proves this validator and not merely *some* validator.
        assert not any('too common' in m for m in messages), messages
        assert not any('numeric' in m for m in messages), messages

    def test_common_password_validator_enforced(self, api_client):
        """`password` is 8 chars and non-numeric, so CommonPasswordValidator
        is the only rule available to reject it.
        """
        r = _register(api_client, username='commonpw', password='password')

        assert r.status_code == 400, r.content
        messages = r.json()['password']
        assert any('too common' in m for m in messages), messages
        assert not any('too short' in m for m in messages), messages

    def test_numeric_password_validator_enforced(self, api_client):
        """`9182736455098172634` is long enough and NOT in Django's common
        list (verified: `CommonPasswordValidator` accepts it), so
        NumericPasswordValidator is the only rule that can reject it.
        """
        r = _register(
            api_client, username='numericpw', password='9182736455098172634'
        )

        assert r.status_code == 400, r.content
        messages = r.json()['password']
        assert any('entirely numeric' in m for m in messages), messages
        assert not any('too common' in m for m in messages), messages

    def test_similarity_validator_receives_the_username(self, api_client):
        """The test that proves `user=` was passed.

        `UserAttributeSimilarityValidator` is a no-op without a `user` — it
        iterates `getattr(user, attr)` for username/first_name/last_name/email
        and skips everything it cannot read. `validate_password(value)` with no
        second argument therefore silently enforces nothing here.

        `Margaret99` against username `margaret` scores SequenceMatcher ratio
        0.778 (> the validator's 0.7 max_similarity) and is 10 chars, not
        common and non-numeric, so it passes the other three. The email is
        deliberately unrelated so the message can only be about the username.
        """
        r = _register(
            api_client,
            username='margaret',
            password='Margaret99',
            email='mira.singh@example.com',
        )

        assert r.status_code == 400, r.content
        messages = r.json()['password']
        assert any('too similar to the username' in m for m in messages), messages
        # If the message named a different attribute it would prove the
        # validator ran but the wrong value was supplied.
        assert not any('too similar to the email' in m for m in messages), messages
        # And it is the *only* rule this password trips.
        assert len(messages) == 1, messages

    def test_similarity_message_is_case_sensitive_match(self, api_client):
        """Control for the test above: a password that is merely *near* the
        username's alphabet, not near its characters, is accepted. Without
        this, a fix that hard-coded "reject anything containing the username
        as a substring" would also pass the previous test.
        """
        r = _register(api_client, username='margaret', password='Summer!Storm77')

        assert r.status_code == 201, r.content

    def test_compliant_strong_password_accepted(self, api_client):
        """Must-preserve: the fix must not lock legitimate users out."""
        from backend.app.models import User

        r = _register(api_client, username='strongpw', password='zephyrus-quill-88')

        assert r.status_code == 201, r.content
        assert User.objects.filter(username='strongpw').exists()

    def test_error_is_reported_on_the_password_field(self, api_client):
        """Field-level, not non-field.

        `client.ts:166` flattens `Object.values(data).flat().join(" ")`, so
        either shape renders, but a field error is what lets a client attach
        the message to the input. The rest of this file reports validation
        failures on the offending field (`dob`, `parent_email`,
        `original_file`, `copyright_acknowledgement`), so this one does too.
        """
        r = _register(api_client, username='shapecheck', password='123')

        assert r.status_code == 400, r.content
        body = r.json()
        assert 'password' in body, body
        # DRF renders a non-field error under 'detail' (or a bare list). A
        # field error must not produce either.
        assert 'detail' not in body, body
        assert isinstance(body, dict), body
        assert isinstance(body['password'], list), body
        assert all(isinstance(m, str) for m in body['password']), body


# ---------------------------------------------------------------------------
# Partial update (Finding 2)
# ---------------------------------------------------------------------------

@pytest.fixture
def wav_factory():
    """A fresh, genuinely decodable 1-second WAV per call.

    Built with pydub rather than a hand-rolled RIFF header so
    `validate_original_file`'s duration probe (ffmpeg/pydub) genuinely
    decodes it — a synthetic header would make the test pass or fail for a
    reason unrelated to the acknowledgement.
    """
    from django.core.files.uploadedfile import SimpleUploadedFile
    from pydub import AudioSegment

    buf = io.BytesIO()
    AudioSegment.silent(duration=1000, frame_rate=44100).export(buf, format='wav')
    payload = buf.getvalue()

    def _make(name='tone.wav'):
        return SimpleUploadedFile(name, payload, content_type='audio/wav')

    return _make


class TestCopyrightAcknowledgement:
    """Create requires it. Update must not, and must never accept a false."""

    def _post(self, client, wav_factory, **overrides):
        payload = {
            'title': 'Gated Clip',
            'category': 'comedy',
            'original_file': wav_factory(),
            'license_type': 'Owned',
            'copyright_owner_name': 'Someone',
        }
        payload.update(overrides)
        return client.post('/clips/', payload, format='multipart')

    def test_patch_with_only_title_succeeds(self, auth_client, ready_clip, wav_factory):
        """The bug: a client editing a clip's title sends `{"title": ...}` and
        got 400 because `validate()` demanded the acknowledgement.
        """
        assert ready_clip.copyright_acknowledgement is False

        r = auth_client.patch(
            f'/clips/{ready_clip.id}/',
            {'title': 'A Better Title'},
            format='json',
        )

        assert r.status_code == 200, r.data
        ready_clip.refresh_from_db()
        assert ready_clip.title == 'A Better Title'

    def test_post_without_acknowledgement_still_rejected(self, auth_client, wav_factory):
        """Must-preserve half. The legal gate on *publishing new content*
        stays exactly where it was.
        """
        from backend.app.models import AudioClip

        before = AudioClip.objects.count()
        r = self._post(auth_client, wav_factory)

        assert r.status_code == 400, r.data
        assert 'copyright_acknowledgement' in r.data, r.data
        assert AudioClip.objects.count() == before, (
            "a rejected upload must not create an AudioClip row"
        )

    def test_post_with_acknowledgement_unchanged(self, auth_client, wav_factory):
        """The success path for create, asserted so the fix cannot make
        `POST` accidentally permissive and get away with it.
        """
        from backend.app.models import AudioClip

        r = self._post(auth_client, wav_factory, copyright_acknowledgement='true')

        assert r.status_code == 202, r.data
        clip = AudioClip.objects.get(pk=r.data['clip_id'])
        assert clip.copyright_acknowledgement is True

    def test_post_with_explicit_false_rejected(self, auth_client, wav_factory):
        """`required=True` only means the key must be present; the value is
        the gate. Sending `false` must not count as acknowledging.
        """
        r = self._post(auth_client, wav_factory, copyright_acknowledgement='false')

        assert r.status_code == 400, r.data
        assert 'copyright_acknowledgement' in r.data, r.data

    def test_patch_may_not_revoke_an_existing_acknowledgement(
        self, auth_client, ready_clip
    ):
        """Chosen semantics for an update that *does* carry the field.

        Required-on-create, but never revocable: `false` is rejected, `true`
        is accepted and persists. The column is the durable record of a
        declaration made at upload time; letting any client flip it to False
        would let the record be erased by the one actor with no standing to
        erase it, and would mean the gate is only enforced until someone
        PATCHes.
        """
        ready_clip.copyright_acknowledgement = True
        ready_clip.save(update_fields=['copyright_acknowledgement'])

        r = auth_client.patch(
            f'/clips/{ready_clip.id}/',
            {'copyright_acknowledgement': False},
            format='json',
        )

        assert r.status_code == 400, r.data
        assert 'copyright_acknowledgement' in r.data, r.data
        ready_clip.refresh_from_db()
        assert ready_clip.copyright_acknowledgement is True, (
            "the stored acknowledgement must survive a rejected PATCH"
        )

    def test_patch_accepts_a_true_acknowledgement(self, auth_client, ready_clip):
        """The mirror of the above: re-affirming is harmless and permitted."""
        ready_clip.copyright_acknowledgement = True
        ready_clip.save(update_fields=['copyright_acknowledgement'])

        r = auth_client.patch(
            f'/clips/{ready_clip.id}/',
            {'title': 'Renamed', 'copyright_acknowledgement': True},
            format='json',
        )

        assert r.status_code == 200, r.data
        ready_clip.refresh_from_db()
        assert ready_clip.title == 'Renamed'
        assert ready_clip.copyright_acknowledgement is True

    def test_patch_leaves_the_stored_value_untouched_when_absent(
        self, auth_client, ready_clip
    ):
        """A PATCH that omits the field must not write a default over it.

        This is the failure mode a "fix" of `data.get(..., False)` would
        introduce: the column would be silently reset to False on every title
        edit, for clips that acknowledged correctly at upload time.
        """
        ready_clip.copyright_acknowledgement = True
        ready_clip.save(update_fields=['copyright_acknowledgement'])

        r = auth_client.patch(
            f'/clips/{ready_clip.id}/', {'title': 'Untouched'}, format='json'
        )

        assert r.status_code == 200, r.data
        ready_clip.refresh_from_db()
        assert ready_clip.title == 'Untouched'
        assert ready_clip.copyright_acknowledgement is True, (
            "an omitted field must not overwrite the stored acknowledgement"
        )


class TestPartialUpdateDoesNotTripOtherGates:
    """Enumeration of the remaining `validate()` requirements.

    `AudioUploadSerializer.validate()` had exactly three obligations:

      * the copyright acknowledgement  -> was unconditional, now
                                          create-only + non-revocable;
      * `license_type == "Unknown"`     -> logs a warning, raises nothing;
      * `_enforce_free_limits(...)`     -> a no-op whenever `original_file`
                                          is absent, which it always is on
                                          a PATCH (the view strips it).

    So the second and third are asserted here to stay non-blocking, which is
    what keeps the enumeration honest: if a future change turns either into a
    raise, this fails instead of the comment going stale.
    """

    def test_patch_without_license_type_is_accepted(self, auth_client, ready_clip):
        """`license_type` is `required=False` with `default="Unknown"`, so a
        PATCH omitting it logs "Upload with Unknown license type" and passes.
        Confusing, but non-blocking — pinned so it cannot silently start
        rejecting partial updates.
        """
        r = auth_client.patch(
            f'/clips/{ready_clip.id}/', {'title': 'No License Sent'}, format='json'
        )

        assert r.status_code == 200, r.data

    def test_free_tier_limit_does_not_block_a_partial_update(
        self, auth_client, ready_clip, settings
    ):
        """`_enforce_free_limits` receives `data.get('original_file')`, which
        is `None` on a PATCH. With the cap at 0 MB and a non-Pro owner, a
        naive change that passed `self.instance.original_file` instead would
        make every edit fail; today it is a no-op.
        """
        original = settings.REVENUECAT_UPLOAD_MAX_SIZE_MB_FREE
        settings.REVENUECAT_UPLOAD_MAX_SIZE_MB_FREE = 0
        try:
            assert ready_clip.creator.is_pro() is False
            r = auth_client.patch(
                f'/clips/{ready_clip.id}/', {'title': 'Zero Budget'}, format='json'
            )
        finally:
            settings.REVENUECAT_UPLOAD_MAX_SIZE_MB_FREE = original

        assert r.status_code == 200, r.data

    def test_the_file_validators_still_reject_on_create(self, auth_client, wav_factory):
        """Must-preserve: the hardening around the acknowledgement must not
        have been relaxed on the way past. A GIF renamed to .wav still fails.
        """
        from django.core.files.uploadedfile import SimpleUploadedFile

        gif = SimpleUploadedFile('evil.wav', b'GIF89a' + b'\x00' * 200,
                                 content_type='audio/wav')
        r = auth_client.post('/clips/', {
            'title': 'Disguised',
            'category': 'comedy',
            'original_file': gif,
            'license_type': 'Owned',
            'copyright_acknowledgement': 'true',
        }, format='multipart')

        assert r.status_code == 400, r.data
        assert 'original_file' in r.data, r.data

    def test_extension_allowlist_still_rejects_on_create(self, auth_client):
        """Same must-preserve intent for the extension layer."""
        from django.core.files.uploadedfile import SimpleUploadedFile

        bad = SimpleUploadedFile('clip.txt', b'hello world' * 10,
                                 content_type='text/plain')
        r = auth_client.post('/clips/', {
            'title': 'Wrong Extension',
            'category': 'comedy',
            'original_file': bad,
            'license_type': 'Owned',
            'copyright_acknowledgement': 'true',
        }, format='multipart')

        assert r.status_code == 400, r.data
        assert 'original_file' in r.data, r.data

    def test_patch_cannot_replace_the_audio_file(self, auth_client, ready_clip, wav_factory):
        """Must-preserve: the N8 rule that `original_file` is read-only on
        update. A PATCH is still a PATCH even now that it is allowed through.

        The clip is given a real stored key first, because the interesting
        comparison is against an *existing* file — asserting that an already
        empty field stays empty would pass even if the swap worked.
        """
        ready_clip.original_file = 'uploads/2026/01/01/original-tone.wav'
        ready_clip.save(update_fields=['original_file'])
        before = ready_clip.original_file.name
        assert before

        r = auth_client.patch(
            f'/clips/{ready_clip.id}/',
            {'title': 'Swapped', 'original_file': wav_factory('other.wav')},
            format='multipart',
        )

        assert r.status_code == 200, r.data
        ready_clip.refresh_from_db()
        assert ready_clip.original_file.name == before, (
            "PATCH must not swap the uploaded audio"
        )
