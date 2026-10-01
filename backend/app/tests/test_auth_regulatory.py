"""Regression tests for regulatory/auth changes (ISSUE-01, 03, 06, 07)."""
import pytest
from django.test import Client
from django.conf import settings
from django.urls import reverse

pytestmark = pytest.mark.django_db


class TestConsentAudit:
    def test_consent_audit_model_exists(self):
        from backend.app.models import ConsentAudit
        assert ConsentAudit is not None

    def test_user_has_dob_and_computed_is_minor(self):
        from datetime import date
        from backend.app.models import User
        user = User.objects.create_user(username='testminor', email='minor@test.com', password='testpass', dob=date(2010, 1, 1))
        assert user.computed_is_minor is True
        user.dob = date(2000, 1, 1)
        user.save()
        assert user.computed_is_minor is False


class TestRegisterSerializerRegulatory:
    def test_register_requires_consent_accepted(self):
        # Without consent_accepted, registration should fail.
        client = Client()
        resp = client.post(reverse('register'), {
            'username': 'nocon',
            'email': 'nocon@test.com',
            'password': 'testpass',
            # missing consent_accepted and terms_version
        })
        # The serializer requires these fields; should return 400.
        assert resp.status_code == 400

    def test_register_with_consent_creates_consent_audit(self):
        client = Client()
        resp = client.post(reverse('register'), {
            'username': 'withconsent',
            'email': 'with@test.com',
            'password': 'testpass123',
            'consent_accepted': True,
            'terms_version': 'v1.0',
            # B1 (2026-09-29): dob is required. An adult DOB keeps this test
            # on the adult path so it stays a pure consent-audit assertion.
            'dob': '1990-01-01',
        })
        assert resp.status_code == 201
        from backend.app.models import ConsentAudit, User
        user = User.objects.get(username='withconsent')
        assert ConsentAudit.objects.filter(user=user).exists()


class TestComplianceEndpoint:
    def test_compliance_contact_returns_json(self):
        client = Client()
        resp = client.get(reverse('legal_compliance'))
        assert resp.status_code == 200
        data = resp.json()
        assert 'compliance_officer' in data
        assert 'grievance_officer' in data
        assert 'nodal_contact' in data


class TestGrievanceEndpoint:
    def test_create_grievance(self):
        client = Client()
        resp = client.post(reverse('grievance_create'), {
            'subject': 'Test Grievance',
            'description': 'This is a test description.',
            'user_email': 'test@example.com',
        }, content_type='application/json')
        # Should return 201 (direct creation in view)
        assert resp.status_code in [200, 201]
        data = resp.json()
        assert 'grievance_id' in data
        assert data['status'] == 'received'


class TestDataSubjectAccess:
    def test_access_requires_auth(self):
        client = Client()
        resp = client.get(reverse('data_subject_access'))
        assert resp.status_code == 401  # Not authenticated


class TestAuditLogModel:
    def test_audit_log_model_exists(self):
        from backend.app.models import AuditLog
        assert AuditLog is not None
