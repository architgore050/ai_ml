"""Tests for the in-app report pipeline (B4).

``POST /clips/{id}/report/`` existed before B4 and created a ``Report`` row
with no link to the clip and no categorisation. An operator receiving "content:
this is bad" with no clip and no category cannot triage it, and IT Rules 2021
R3(1)(b) requires categorised complaint handling.

These tests pin that a report is now (a) attached to the clip, (b)
categorised against the IT Rules enum, and (c) not spoofable, and that
duplicates from one user collapse rather than burying the clip in rows.
"""
import pytest

from backend.app.models import AudioClip, Report, User

pytestmark = pytest.mark.django_db


@pytest.fixture
def owner(django_user_model):
    return django_user_model.objects.create_user(
        username="owner", email="owner@example.com", password="pw-probe-123"
    )


@pytest.fixture
def reporter(django_user_model):
    return django_user_model.objects.create_user(
        username="reporter", email="reporter@example.com", password="pw-probe-123"
    )


@pytest.fixture
def clip(owner):
    return AudioClip.objects.create(
        creator=owner,
        title="a clip",
        status="ready",
        moderation_approved=True,
    )


def report_client(user):
    from rest_framework.test import APIClient

    client = APIClient()
    client.force_authenticate(user=user)
    return client


class TestReportIsActionable:
    def test_the_report_is_linked_to_the_clip(self, clip, reporter):
        """The core of B4. Before it, Report.clip did not exist."""
        response = report_client(reporter).post(
            f"/clips/{clip.id}/report/",
            {"report_reason": "copyright", "content": "This is my recording."},
            format="json",
        )
        assert response.status_code == 201
        report = Report.objects.get(pk=response.json()["report_id"])
        assert report.clip_id == clip.id

    def test_a_bare_report_row_cannot_be_created_via_the_endpoint(
        self, clip, reporter
    ):
        """Regression guard for the original shape: if clip ever becomes
        nullable-but-unset again, this fails."""
        Report.objects.all().delete()
        report_client(reporter).post(
            f"/clips/{clip.id}/report/",
            {"report_reason": "spam", "content": "Spam."},
            format="json",
        )
        assert Report.objects.filter(clip__isnull=True).count() == 0

    def test_the_reason_is_stored_and_validated_against_the_enum(self, clip, reporter):
        response = report_client(reporter).post(
            f"/clips/{clip.id}/report/",
            {"report_reason": "obscene", "content": "Explicit content."},
            format="json",
        )
        assert response.status_code == 201
        assert Report.objects.get().report_reason == "obscene"

    @pytest.mark.parametrize(
        "reason",
        ["obscene", "hate_speech", "violence", "csam", "terrorism",
         "copyright", "impersonation", "privacy", "spam", "other"],
    )
    def test_every_declared_reason_is_accepted(self, clip, reporter, reason):
        """Each enum member must actually pass validation — an enum that the
        view rejects is a dead option in the UI."""
        assert reason in {code for code, _ in Report.REPORT_REASONS}
        response = report_client(reporter).post(
            f"/clips/{clip.id}/report/",
            {"report_reason": reason, "content": "details"},
            format="json",
        )
        assert response.status_code == 201

    def test_an_unknown_reason_is_rejected(self, clip, reporter):
        response = report_client(reporter).post(
            f"/clips/{clip.id}/report/",
            {"report_reason": "because_i_said_so", "content": "details"},
            format="json",
        )
        assert response.status_code == 400
        assert "report_reason" in response.json()
        # The error must list the valid values so a client can self-correct.
        assert "copyright" in str(response.json()["report_reason"])
        assert Report.objects.count() == 0

    def test_a_missing_reason_is_rejected_rather_than_defaulting(
        self, clip, reporter
    ):
        """The model default is 'other', but silently defaulting would make
        every bug-reporting client produce an uncategorised row, which is the
        thing B4 exists to stop."""
        response = report_client(reporter).post(
            f"/clips/{clip.id}/report/", {"content": "details"}, format="json"
        )
        assert response.status_code == 400
        assert Report.objects.count() == 0

    def test_empty_content_is_rejected(self, clip, reporter):
        """An empty body gives a moderator nothing to act on, and the
        'other' bucket would be an unlabelled report."""
        for body in ({"report_reason": "other", "content": ""},
                     {"report_reason": "other", "content": "   "},
                     {"report_reason": "other"}):
            response = report_client(reporter).post(
                f"/clips/{clip.id}/report/", body, format="json"
            )
            assert response.status_code == 400, body
        assert Report.objects.count() == 0

    def test_title_is_derived_when_absent(self, clip, reporter):
        report_client(reporter).post(
            f"/clips/{clip.id}/report/",
            {"report_reason": "hate_speech", "content": "Abusive."},
            format="json",
        )
        report = Report.objects.get()
        assert report.title  # not blank, and fits the column
        assert len(report.title) <= 200


class TestReportAttribution:
    def test_the_reporter_is_taken_from_the_token(self, clip, reporter, owner):
        """A client must not be able to file a report attributed to another
        account by putting their id in the body."""
        report_client(reporter).post(
            f"/clips/{clip.id}/report/",
            {
                "report_reason": "spam",
                "content": "Spam.",
                "user": owner.pk,
                "user_id": owner.pk,
            },
            format="json",
        )
        report = Report.objects.get()
        assert report.user_id == reporter.pk
        assert report.user_id != owner.pk

    def test_anonymous_reporting_is_refused(self, clip):
        from rest_framework.test import APIClient

        response = APIClient().post(
            f"/clips/{clip.id}/report/",
            {"report_reason": "spam", "content": "Spam."},
            format="json",
        )
        assert response.status_code in (401, 403)
        assert Report.objects.count() == 0


class TestReportDeduplication:
    def test_a_second_report_from_the_same_user_is_collapsed(
        self, clip, reporter
    ):
        """Without this, a user can bury a clip in duplicate rows and make
        'reported by N users' uncountable."""
        first = report_client(reporter).post(
            f"/clips/{clip.id}/report/",
            {"report_reason": "copyright", "content": "Mine."},
            format="json",
        )
        second = report_client(reporter).post(
            f"/clips/{clip.id}/report/",
            {"report_reason": "copyright", "content": "Also mine, again."},
            format="json",
        )
        assert first.status_code == second.status_code == 201
        assert second.json()["duplicate"] is True
        assert Report.objects.filter(clip=clip, user=reporter).count() == 1

    def test_duplicate_detail_is_appended_not_discarded(self, clip, reporter):
        """The user did tell us something the second time."""
        client = report_client(reporter)
        client.post(
            f"/clips/{clip.id}/report/",
            {"report_reason": "copyright", "content": "First detail."},
            format="json",
        )
        client.post(
            f"/clips/{clip.id}/report/",
            {"report_reason": "copyright", "content": "Second detail."},
            format="json",
        )
        report = Report.objects.get()
        assert "First detail." in report.content
        assert "Second detail." in report.content

    def test_different_users_produce_separate_reports(self, clip, reporter, django_user_model):
        """The constraint is per (user, clip) — the signal moderators need is
        how many distinct users reported it."""
        other = django_user_model.objects.create_user(
            username="reporter2", email="reporter2@example.com", password="pw-probe-123"
        )
        for user in (reporter, other):
            report_client(user).post(
                f"/clips/{clip.id}/report/",
                {"report_reason": "spam", "content": "Spam."},
                format="json",
            )
        assert Report.objects.filter(clip=clip).count() == 2

    def test_the_constraint_tolerates_a_null_clip(self, django_user_model):
        """Partial constraint: general-purpose reports (about an account, not
        a clip) have no clip, and two such rows must not collide."""
        author = django_user_model.objects.create_user(
            username="acct", email="acct@example.com", password="pw-probe-123"
        )
        for i in range(2):
            Report.objects.create(
                title=f"general {i}", content="x", user=author,
                clip=None, report_reason="other",
            )
        assert Report.objects.filter(clip__isnull=True).count() == 2


class TestReportCascade:
    def test_deleting_a_clip_removes_its_reports(self, clip, reporter):
        """CASCADE, not SET_NULL: a report about a clip that no longer exists
        is not a triageable artifact, and retaining orphan rows would let a
        deleted clip be reported on forever with no target."""
        report_client(reporter).post(
            f"/clips/{clip.id}/report/",
            {"report_reason": "copyright", "content": "Mine."},
            format="json",
        )
        assert Report.objects.filter(clip=clip).exists()
        clip.delete()
        assert Report.objects.count() == 0

    def test_deleting_the_reporter_keeps_the_report(self, clip, reporter, owner):
        """SET_NULL on user: the clip and the report survive, and a
        moderator can still see that *someone* reported it. This is the
        opposite choice to clip, deliberately — the clip is the subject, the
        reporter is only the source."""
        report_client(reporter).post(
            f"/clips/{clip.id}/report/",
            {"report_reason": "copyright", "content": "Mine."},
            format="json",
        )
        reporter.delete()
        report = Report.objects.get()
        assert report.user is None
        assert report.clip_id == clip.id
