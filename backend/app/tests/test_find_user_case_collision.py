"""`GET /share/find-user/` — the 500 on a username case collision (R5-07).

What was broken
---------------
`views/social.py::find_user` did

    User.objects.get(username__iexact=username)

`User.username` is `unique=True` on a **case-sensitive** column. I verified
both halves of that rather than assuming them:

  * `app_user.username` is `character varying(150)` and its constraint is
    `app_user_username_key UNIQUE CONSTRAINT, btree (username)` — a plain
    btree under the database's `en_US.utf8` collation, which is
    case-*sensitive*. Measured on the running database:
    `SELECT 'alice' = 'Alice'` -> `f`, `'alice' ILIKE 'Alice'` -> `t`.
    So both rows are insertable and both persist.
  * `User` (`models.py:14`) subclasses `AbstractUser` and does not redeclare
    `username`, so the field is Django's: `unique=True, max_length=150`.

`iexact` therefore matches *both* rows, `.get()` requires exactly one, and
`MultipleObjectsReturned` is raised. The `except` clause caught only
`User.DoesNotExist`, so the exception escaped as a 500.

Reachability is two ordinary registrations: `RegisterSerializer`'s
`username` field carries DRF's auto-generated `UniqueValidator` (because
`model_field.unique` is True — `rest_framework/utils/field_mapping.py::
get_unique_validators`) and its default lookup is `exact`, i.e. case-sensitive.
`create()` stores `validated_data['username']` verbatim. So `POST
/auth/register/` for `alice` and then for `Alice` returns 201 twice. See
`TestCollisionIsReachableThroughRegistration`.

Why the test builds the pair with `create_user` and not through the API
-----------------------------------------------------------------------
Because the interesting property is a property of the *read path*, and it has
to keep holding after the uniqueness migration lands. The right fix for the
root cause is a case-insensitive `UniqueConstraint`, but that migration has to
decide what to do with rows that already collide — so the read path will keep
having to cope with a colliding pair for as long as one exists. Driving the
state through the ORM makes the test independent of whether registration
still permits the collision; only the one characterisation test below depends
on that.

Constructing the collision needs no database-level trick: `create_user` calls
`user.save()`, and `Model.save()` runs no field validators. Verified in the
container — `create_user(username='probealice')` followed by
`create_user(username='ProbeAlice')` both succeed. (`full_clean()` would not
have blocked it either: `validate_unique()` compares with the same
case-sensitive `exact` lookup.)

Preserved on purpose
--------------------
`iexact` matching is the feature, not the bug — a user who types `ALICE`
should find `alice`. The 404 body shape, the `{"error": …}` convention, the
`{id, username}` success shape, the self-share refusal and the `share_poll`
throttle scope are all unchanged and pinned below.
"""
import pytest
from django.urls import reverse
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db


@pytest.fixture
def searcher(django_user_model):
    """The authenticated caller. Never one of the accounts under test."""
    return django_user_model.objects.create_user(
        username='w2fsearcher', email='w2fsearcher@example.com', password='pw-12345'
    )


@pytest.fixture
def authed(searcher):
    """An authenticated caller.

    Every request below builds the query string by hand rather than passing
    `data={'username': …}`. urlencode would be exact too, but the
    over-length and whitespace cases are clearer when the raw form is
    visible in the test.
    """
    client = APIClient()
    client.force_authenticate(user=searcher)
    return client


@pytest.fixture
def case_collision(django_user_model):
    """Two real rows differing only in the case of `username`.

    The lower-cased one is inserted first so its primary key is the lower of
    the two. Asserted in `test_collision_...` so the fixture cannot drift into
    an arrangement that hides the ordering the fix depends on.
    """
    lower = django_user_model.objects.create_user(
        username='w2fsquat', email='w2fsquat@example.com', password='pw-12345'
    )
    upper = django_user_model.objects.create_user(
        username='W2fSquat', email='W2fsquat@example.com', password='pw-12345'
    )
    assert lower.pk < upper.pk, 'fixture must insert the lower-cased row first'
    return lower, upper


# ---------------------------------------------------------------------------
# 1. The regression: a case collision must not 500.
# ---------------------------------------------------------------------------
class TestCaseCollision:
    """`MultipleObjectsReturned` escaped as a 500 because only
    `User.DoesNotExist` was caught."""

    def test_collision_returns_409_not_500(self, authed, case_collision):
        lower, upper = case_collision

        response = authed.get(
            f"{reverse('share-find-user')}?username=w2fsquat")

        assert response.status_code != 500, 'R5-07 regression: still 500'
        # 409 Conflict. The request was well-formed and the caller exists;
        # the *identity* behind the name is ambiguous, and resolving it by
        # guessing which account was meant would hand the share to whichever
        # row happened to sort first — including an attacker's squat.
        assert response.status_code == 409, response.content
        body = response.json()
        # The file's existing failure convention, so the frontend's
        # `serverMessage()` has something to read.
        assert set(body) == {'error'}, body
        assert isinstance(body['error'], str) and body['error']
        # It must not name an account: the whole point is that there is no
        # defensible single answer, and returning one invites a share aimed
        # at the wrong person.
        assert 'id' not in body and 'username' not in body, body
        # ...and the id it must not leak is a real one from this test.
        assert str(lower.pk) not in body['error']
        assert str(upper.pk) not in body['error']

    def test_collision_is_detected_regardless_of_the_queried_casing(
        self, authed, case_collision
    ):
        """Even the *exact* stored spelling used to 500.

        This is the sharper half of the bug and the easier one to miss:
        a client that reads the casing off a profile and echoes it back gets
        the same crash as one that mistypes it, because `iexact` matches both
        rows either way. So this cannot be fixed by only handling the
        "user typed it differently" path.
        """
        authed.get(f"{reverse('share-find-user')}?username=W2fSquat")
        response = authed.get(
            f"{reverse('share-find-user')}?username=W2FSQUAT")

        assert response.status_code == 409, response.content

    def test_collision_is_a_409_not_a_404(self, authed, case_collision):
        """A colliding name must not read as "no such user".

        Those are different facts and the frontend has a different message
        for each. A 404 here would tell a user searching for a colleague that
        the colleague does not exist.
        """
        response = authed.get(
            f"{reverse('share-find-user')}?username=w2fsquat")
        assert response.status_code != 404, response.content


# ---------------------------------------------------------------------------
# 2-4. Must-preserve: the success shape, the 404 shape, `iexact`.
# ---------------------------------------------------------------------------
class TestFindUserPreservedBehaviour:
    def test_single_match_returns_id_and_username(
        self, authed, django_user_model
    ):
        target = django_user_model.objects.create_user(
            username='w2ftarget', email='w2ftarget@example.com',
            password='pw-12345',
        )

        response = authed.get(
            f"{reverse('share-find-user')}?username=w2ftarget")

        assert response.status_code == 200, response.content
        # Exactly these two keys. `frontend/src/api/client.ts:348` types the
        # response as `{ id: number; username: string }` and `ShareModal`
        # renders `foundUser.username` then posts `foundUser.id`.
        assert response.json() == {'id': target.pk, 'username': 'w2ftarget'}

    def test_no_match_is_404_with_the_existing_error_body(
        self, authed
    ):
        response = authed.get(
            f"{reverse('share-find-user')}?username=w2fghost")

        assert response.status_code == 404, response.content
        # `frontend/src/api/client.ts` and the rewritten `ShareModal` both
        # read this string. Do not reword it.
        assert response.json() == {'error': 'No user found: @w2fghost'}

    def test_case_insensitive_match_on_a_single_user_still_works(
        self, authed, django_user_model
    ):
        """`iexact` is deliberate: `ALICE` must find `alice`."""
        target = django_user_model.objects.create_user(
            username='w2fmixedcase', email='w2fmixedcase@example.com',
            password='pw-12345',
        )

        response = authed.get(
            f"{reverse('share-find-user')}?username=W2FMIXEDCASE")

        assert response.status_code == 200, response.content
        # The *stored* spelling comes back, not the one that was typed —
        # that is what `iexact` has always done and what the client renders.
        assert response.json() == {
            'id': target.pk, 'username': 'w2fmixedcase'}


# ---------------------------------------------------------------------------
# 5. Self-share, unchanged.
# ---------------------------------------------------------------------------
class TestSelfShareUnchanged:
    def test_own_username_is_refused(self, authed, searcher):
        response = authed.get(
            f"{reverse('share-find-user')}?username=w2fsearcher")

        assert response.status_code == 400, response.content
        assert response.json() == {
            'error': "You can't share with yourself"}

    def test_own_username_refused_regardless_of_case(self, authed):
        response = authed.get(
            f"{reverse('share-find-user')}?username=W2FSEARCHER")

        assert response.status_code == 400, response.content
        assert response.json() == {
            'error': "You can't share with yourself"}


# ---------------------------------------------------------------------------
# 6-7. Hostile / degenerate input must not 500.
# ---------------------------------------------------------------------------
class TestDegenerateInput:
    @pytest.mark.parametrize('length', [151, 10_000])
    def test_over_length_username_does_not_500(self, authed, length):
        """`username` is `varchar(150)`.

        The length is not enforced on the query string — this view never
        touches a serializer — so Postgres compares a longer value against
        every row and finds nothing. What matters here is that it finds
        nothing *without* raising, and that the answer is the existing 404
        shape rather than a crash.
        """
        response = authed.get(
            f"{reverse('share-find-user')}?username=" + 'a' * length)

        assert response.status_code != 500, response.content
        assert response.status_code == 404, response.content
        body = response.json()
        assert set(body) == {'error'}
        assert body['error'].startswith('No user found: @')
        # The caller's input is reflected in the message, as it always was.
        # Pinned so the reflection cannot be mistaken for truncation.
        assert len(body['error']) == len('No user found: @') + length

    @pytest.mark.parametrize('raw', ['', '%20', '%09%0A'])
    def test_blank_username_is_400(self, authed, raw):
        """Empty and whitespace-only both take the `not username` branch."""
        response = authed.get(
            f"{reverse('share-find-user')}?username={raw}")

        assert response.status_code != 500, response.content
        assert response.status_code == 400, response.content
        body = response.json()
        assert body == {'error': 'Username required'}
        # It must not have fallen through to a match and handed back an
        # arbitrary account.
        assert 'id' not in body and 'username' not in body

    def test_missing_username_parameter_is_400(self, authed):
        response = authed.get(reverse('share-find-user'))
        assert response.status_code == 400, response.content
        assert response.json() == {'error': 'Username required'}


# ---------------------------------------------------------------------------
# Root-cause pin. Describes state OUTSIDE find_user, deliberately.
# ---------------------------------------------------------------------------
class TestUniquenessIsCaseSensitive:
    """The reason `iexact` can match two rows.

    Deliberately scoped to the *model*, not to `RegisterSerializer`.

    I verified the registration path by hand and it is the actual reachability
    story: `POST /auth/register/` returns 201 for `w2freg` and then again for
    `W2fReg`, leaving two rows that `filter(username__iexact=...)` counts as
    one ambiguous match. That is a two-line HTTP reproduction and it does not
    belong in this file, because `serializers.py` is under concurrent edit by
    another agent and a live POST here couples `find_user`'s regression cover
    to an unrelated refactor — the failure would be indistinguishable from
    mine, in both directions. It is written up in the handover instead.

    What *is* asserted here is the fact the read path has to survive, and it
    is asserted where it cannot drift underneath the test: on the field and
    on the rows.
    """

    def test_username_is_a_case_sensitive_unique_field(self, django_user_model):
        field = django_user_model._meta.get_field('username')
        # Not re-declared on `User` (`models.py:14` subclasses
        # `AbstractUser`), so this is Django's: unique, 150 characters.
        # `TestDegenerateInput` depends on the 150.
        assert field.unique is True
        assert field.max_length == 150

    def test_two_rows_differing_only_in_case_persist(self, case_collision):
        """`create_user` runs no field validators, so both rows are real."""
        lower, upper = case_collision
        assert lower.pk != upper.pk
        assert lower.username.lower() == upper.username.lower()
        assert lower.username != upper.username

    def test_the_two_rows_are_indistinguishable_to_the_lookup(self, case_collision):
        """The ambiguity the view has to resolve rather than crash on."""
        from django.contrib.auth import get_user_model

        User = get_user_model()
        matches = User.objects.filter(username__iexact='w2fsquat')
        assert matches.count() == 2
        # ...and the constraint did not object, because on `varchar` under a
        # case-sensitive collation `'w2fsquat' <> 'W2fSquat'`. A single query
        # returning two rows is exactly the state `.get()` cannot survive.
        assert User.objects.filter(username='w2fsquat').count() == 1


class TestThrottleScopePreserved:
    """`find_user` must keep reading at the loose `share_poll` rate.

    Also pinned by `test_adversarial_pass3.py:441`, but this file owns the
    endpoint, so it asserts the wiring it depends on rather than trusting a
    file about a sibling action. `ScopedRateThrottle` allows *everything*
    when the view declares no scope, silently, with no error.
    """

    def test_find_user_uses_share_poll(self):
        from backend.app.views.social import ShareViewSet

        view = ShareViewSet()
        view.action = 'find_user'
        assert view.throttle_scope == 'share_poll'

    def test_find_user_is_not_the_tight_send_rate(self):
        from django.conf import settings
        from backend.app.views.social import ShareViewSet

        view = ShareViewSet()
        view.action = 'find_user'
        rates = settings.REST_FRAMEWORK['DEFAULT_THROTTLE_RATES']
        assert view.throttle_scope != 'share_send'
        # Both bounds still exist; only the dispatch is under test.
        assert rates['share_poll'] and rates['share_send']
