"""Hygiene guards for the tracked env templates and the compose files.

This is CONFIG validation. It touches no database, no model, no view. It
exists because every defect it guards is silent: an env file that duplicates
a key resolves to the *last* one, a compose `environment:` literal overrides
`env_file:` and cannot be overridden from anywhere, and an operator who reads
the comment above a key is not reading the value that actually takes effect.

Scope note — this file deliberately asserts only things that are true of the
repo as it stands. Where a key is intentionally absent from every template
(DATABASE_URL, the disabled scraper connectors' API keys) the reason is
recorded in ``_NOT_IN_ANY_TEMPLATE`` so that a *new* undeclared os.getenv in
settings.py turns this suite red instead of vanishing silently.

Why no PyYAML: the `api` image ships no YAML parser (verified — `yaml`,
`ruamel.yaml`, `strictyaml` are all absent), so the compose reader below is a
small block-scoped structural parser. It is NOT a grep: it descends into
`environment:` blocks by indentation and ignores comments, which is precisely
the failure mode a grep would have (a commented-out
`- DJANGO_DEBUG=True` in a disabled block would read as a violation).
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]  # backend/app/tests → repo root

ENV_TEMPLATES = (
    '.env.example',
    '.env.vps.example',
    '.env.laptop.example',
)

#: The compose files this repository owns and ships. ``docker-compose.test.yml``
#: is handled separately in :class:`TestComposeNoHardcodedDebug` because its
#: ``DJANGO_DEBUG=True`` is load-bearing rather than accidental.
OWNED_COMPOSE_FILES = (
    'docker-compose.local.yml',
    'docker-compose.yml',
    'docker-compose.vps.yml',
    'docker-compose.laptop.yml',
)

#: Values that look like a secret but are trivially guessable. Kept explicit
#: rather than approximated by an entropy heuristic so that a failure names
#: the literal that shipped.
WEAK_LITERALS = frozenset({
    'admin-password', 'admin_password', 'adminpassword', 'password',
    'passw0rd', 'secret', 'secret-key', 'secretkey', 'changeme',
    'change-me', 'echoflow', 'test', 'testing', 'dev', 'development',
    'placeholder', 'your-password-here', 'please-change-me',
    'insecure', 'default', 'example',
})

#: Keys that must never carry a real value in a tracked template, because the
#: template itself is committed to git and therefore public.
SECRET_KEYS = (
    'DJANGO_SECRET_KEY',
    'DB_PASSWORD',
    'REDIS_BROKER_PASSWORD',
    'REDIS_CACHE_PASSWORD',
    'MEDIA_TOKEN_SECRET',
)

#: Truthy spellings accepted by ``scripts/check_no_tracked_env.sh``. Mirrored
#: verbatim (and cross-checked against the script in
#: :class:`TestDebugFlag`) so this suite and CI can never drift apart.
TRUTHY_DEBUG = frozenset({'true', '1', 'yes'})

# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------
_ASSIGNMENT_RE = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$')
_MAPPING_ENTRY_RE = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$')
_LIST_ITEM_RE = re.compile(r'^-\s+(.*)$')
_TEMPLATE_MARKER_RE = re.compile(r'^<.*>$')


def parse_env_file(path: Path) -> list[tuple[int, str, str]]:
    """Parse a dotenv file into ``[(lineno, key, value), ...]``, in order.

    Duplicates are *kept* rather than collapsed, because collapsing is exactly
    the bug: a dotenv reader takes the last one, so the first is invisible.
    Keeping both lets the tests report which one survived.

    Handles what these templates actually contain: blank lines, ``#`` comment
    lines, an ``export `` prefix, quoted values, and unquoted inline comments
    (``KEY=value  # note`` — the trailing ``# ...`` is a comment only when it
    is preceded by whitespace, so a ``#`` inside a bare value is not eaten).
    """
    assignments: list[tuple[int, str, str]] = []
    for lineno, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[len('export '):].lstrip()
        match = _ASSIGNMENT_RE.match(line)
        if not match:
            continue  # a bare word, a stray directive — not an assignment
        key, value = match.group(1), match.group(2).strip()
        if value[:1] in ('"', "'"):
            quote = value[0]
            end = value.find(quote, 1)
            value = value[1:end] if end != -1 else value[1:]
        else:
            inline = value.find(' #')
            if inline != -1:
                value = value[:inline].rstrip()
        assignments.append((lineno, key, value))
    return assignments


def effective_values(assignments: list[tuple[int, str, str]]) -> dict[str, str]:
    """Collapse assignments the way a loader does: last one wins."""
    return {key: value for _lineno, key, value in assignments}


def is_placeholder(value: str) -> bool:
    """True when ``value`` is obviously not a real secret.

    Accepts: empty, a ``<...>`` template marker, anything containing
    ``change-me`` (the convention every template uses), and anything in
    :data:`WEAK_LITERALS`.
    """
    if value == '':
        return True
    if _TEMPLATE_MARKER_RE.match(value):
        return True
    lowered = value.lower()
    if 'change-me' in lowered or 'changeme' in lowered:
        return True
    return lowered in WEAK_LITERALS


def _indent_of(line: str) -> int:
    return len(line) - len(line.lstrip())


def parse_compose_environment(path: Path) -> list[tuple[int, str, str]]:
    """Return ``[(lineno, key, raw_value), ...]`` for every ``environment:`` entry.

    A deliberately small block-scoped reader rather than a line grep. It:

    * locates ``environment:`` at any indentation and reads only the lines
      indented deeper than it, so a ``DJANGO_DEBUG=True`` in an unrelated
      service (``postgresql``) or in a comment is never reported;
    * understands both compose spellings — the list form ``- KEY=value`` and
      the mapping form ``KEY: value``;
    * ignores comment lines inside the block.

    Values are returned uninterpolated, so ``${DJANGO_DEBUG:-False}`` stays
    that string. This module asserts on literals, which is the point: a
    template that defers to the environment cannot hardcode anything.
    """
    lines = path.read_text().splitlines()
    entries: list[tuple[int, str, str]] = []
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped != 'environment:' and not stripped.startswith('environment:'):
            continue
        base_indent = _indent_of(line)
        inline = stripped[len('environment:'):].strip()
        if inline and not inline.startswith('#'):
            match = _MAPPING_ENTRY_RE.match(inline)
            if match:
                entries.append((i + 1, match.group(1), match.group(2).strip()))
        for j in range(i + 1, len(lines)):
            nxt = lines[j]
            if not nxt.strip() or nxt.strip().startswith('#'):
                continue
            if _indent_of(nxt) <= base_indent:
                break  # dedent out of the block
            item = _LIST_ITEM_RE.match(nxt.strip())
            if item:
                payload = item.group(1).strip()
                if '=' in payload:
                    key, _sep, value = payload.partition('=')
                    entries.append((j + 1, key.strip(), value.strip()))
                else:
                    match = _MAPPING_ENTRY_RE.match(payload)
                    if match:
                        entries.append(
                            (j + 1, match.group(1), match.group(2).strip())
                        )
                continue
            match = _MAPPING_ENTRY_RE.match(nxt.strip())
            if match:
                entries.append((j + 1, match.group(1), match.group(2).strip()))
    return entries


def settings_env_keys() -> set[str]:
    """Every literal key ``settings.py`` reads via os.getenv / os.environ."""
    source = (REPO_ROOT / 'backend' / 'EchoFlow' / 'settings.py').read_text()
    pattern = re.compile(
        r"""os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]"""
        r"""|os\.environ\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]"""
        r"""|os\.environ\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]"""
    )
    return {next(g for g in m.groups() if g) for m in pattern.finditer(source)}


def tracked_env_file_paths() -> list[Path]:
    """The tracked env-shaped files: the three committed templates.

    Scoped exactly like ``scripts/check_no_tracked_env.sh``, which "uses git
    ls-files to avoid scanning untracked local secrets". A real ``.env`` /
    ``.env.local`` / ``.env.laptop`` is gitignored and machine-local, and
    ``DJANGO_DEBUG=True`` in one of those is a legitimate local choice — the
    docker-compose.test.yml stack is the one place that legitimately needs it.
    Including them here would produce a false positive on any developer whose
    local file says True, which is the fastest way to get a guard ignored.

    Discovered by glob rather than hardcoded, so a new ``.env.staging.example``
    is covered the day it is added.
    """
    return sorted(
        p for p in REPO_ROOT.glob('.env*')
        if p.is_file() and p.suffix == '.example'
    )


# ---------------------------------------------------------------------------
# 1. No duplicate keys
# ---------------------------------------------------------------------------
class TestNoDuplicateKeys:
    """A duplicate key resolves to the LAST value; the first is invisible.

    `.env.example` shipped nine of them. One was a real downgrade: it declared
    ``GRAFANA_ADMIN_PASSWORD=change-me-grafana-admin-password`` under a
    comment instructing the operator to keep the value strong, and then
    ``GRAFANA_ADMIN_PASSWORD=admin-password`` twice at the bottom of the file.
    Last-wins handed the Grafana container a shorter, more guessable literal,
    and the stronger placeholder had already propagated into a real .env.
    """

    @pytest.mark.parametrize('template', ENV_TEMPLATES)
    def test_no_key_is_declared_twice(self, template):
        path = REPO_ROOT / template
        assert path.exists(), f'{template} is missing from the repo'
        seen: dict[str, int] = {}
        duplicates: dict[str, list[tuple[int, str]]] = {}
        for lineno, key, value in parse_env_file(path):
            if key in seen:
                duplicates.setdefault(key, []).append((lineno, value))
            seen[key] = lineno
        assert not duplicates, (
            f'{template}: {len(duplicates)} key(s) declared more than once. '
            f'A dotenv loader takes the last one, so the earlier value never '
            f'takes effect:\n'
            + '\n'.join(
                f'  {key}: {len(occurrences) + 1}x — '
                + ', '.join(f'line {ln}={val!r}' for ln, val in occurrences)
                for key, occurrences in sorted(duplicates.items())
            )
        )

    def test_grafana_admin_password_is_not_undercut(self):
        """The specific downgrade, pinned independently of the count above.

        Kept as its own test so that re-introducing the weak literal is a named
        failure rather than a line in a list.
        """
        effective = effective_values(parse_env_file(REPO_ROOT / '.env.example'))
        assert 'GRAFANA_ADMIN_PASSWORD' in effective, (
            'GRAFANA_ADMIN_PASSWORD must stay declared — Grafana v11 refuses to '
            'start without a non-empty GF_SECURITY_ADMIN_PASSWORD.'
        )
        value = effective['GRAFANA_ADMIN_PASSWORD']
        assert value.lower() not in WEAK_LITERALS, (
            'GRAFANA_ADMIN_PASSWORD resolves to a bare guessable literal '
            f'({value!r}). The placeholder documented directly above it must be '
            'the effective value, not a shorter literal from further down the '
            'file.'
        )


# ---------------------------------------------------------------------------
# 2. Cross-template consistency
# ---------------------------------------------------------------------------
#: Keys that legitimately hold a different value per environment. Every entry
#: needs a reason: the point of this map is to make divergence a decision, not
#: a default.
DIVERGENCE_IS_INTENTIONAL: dict[str, str] = {
    'AWS_ACCESS_KEY_ID': 'MinIO creds locally, R2 creds on VPS/laptop.',
    'AWS_SECRET_ACCESS_KEY': 'MinIO creds locally, R2 creds on VPS/laptop.',
    'AWS_S3_ENDPOINT_URL': 'In-network MinIO locally, R2 account URL in prod.',
    'AWS_S3_REGION_NAME': 'ap-south-1 for MinIO; R2 requires the literal auto.',
    'DB_HOST': 'pgbouncer / db / Tailscale IP — different per deployment.',
    'DB_PORT': '6432 through pgbouncer, 5432 direct, 5432 over Tailscale.',
    'DB_PASSWORD': 'Placeholder text differs; the real value is per-deployment '
                   'and must be identical across the fleet at runtime.',
    'DJANGO_SECRET_KEY': 'Placeholder text differs; the real value MUST be '
                         'identical across the fleet at runtime.',
    'DJANGO_ALLOWED_HOSTS': 'Host allowlist is per-deployment by definition.',
    'DJANGO_CORS_ALLOWED_ORIGINS': 'Browser origins are per-deployment.',
    'GUNICORN_WORKERS': '4 locally, 2 on a 4 GB VPS.',
    'HF_TOKEN': 'Only the laptop media image needs it (build-time secret).',
    'MEDIA_TOKEN_COOKIE_DOMAIN': 'Empty on localhost (domain cookies are '
                                 'rejected); the shared parent in prod.',
    'MEDIA_TOKEN_SECRET': 'Placeholder text differs; the real value MUST be '
                          'identical to the Cloudflare Worker secret.',
    'PUBLIC_APP_BASE_URL': 'No public app origin in dev; the Pages origin in '
                           'prod. Empty is the documented "no absolute URL" mode.',
    'PUBLIC_HLS_ENDPOINT_URL': 'Empty in dev (no validating edge); the Worker '
                               'origin in prod.',
    'PUBLIC_MEDIA_ENDPOINT_URL': 'nginx :9443 locally, media.echoflow.in in prod.',
    'REDIS_BROKER_PASSWORD': 'Placeholder text differs; the real value must '
                             'match across VPS and laptop.',
    'REDIS_BROKER_URL': 'Deliberately URL-only in the hybrid templates: the '
                        'Redis passwords contain base64 characters that break '
                        'Kombo URL parsing. See settings.resolve_redis_url().',
    'REDIS_CACHE_PASSWORD': 'Placeholder text differs; the real value must '
                            'match across VPS and laptop.',
    'REDIS_CACHE_URL': 'Same base64-password reason as REDIS_BROKER_URL.',
}

#: Keys whose absence from an environment would make that environment's
#: configuration incomplete. A key present in one template and silently
#: missing from another is a contradiction in the fleet contract: the
#: operator of the second environment has no way to discover it exists.
FLEET_WIDE_REQUIRED: dict[str, tuple[str, ...]] = {
    'SCRAPER_ENABLED': ('.env.example', '.env.vps.example'),
    'SCRAPER_ALLOW_NC': ('.env.example', '.env.vps.example'),
    'SCRAPER_ALLOW_SHARE_ALIKE': ('.env.example', '.env.vps.example'),
    'SHARE_TOKEN_TTL_SECONDS': ('.env.example', '.env.vps.example'),
    'PUBLIC_APP_BASE_URL': ('.env.example', '.env.vps.example'),
    'READ_DATABASE_URL': ('.env.example', '.env.vps.example'),
    'REVENUECAT_SECRET_KEY': ('.env.example', '.env.vps.example'),
    'REVENUECAT_PUBLIC_KEY': ('.env.example', '.env.vps.example'),
    'REVENUECAT_PROJECT_TOKEN': ('.env.example', '.env.vps.example'),
    'REVENUECAT_ENTITLEMENT_ID': ('.env.example', '.env.vps.example'),
    'REVENUECAT_SYNC_INTERVAL_MINUTES': ('.env.example', '.env.vps.example'),
    'SEED_AUTH_TOKEN': ('.env.example', '.env.vps.example'),
    'FREESOUND_API_KEY': ('.env.example', '.env.vps.example'),
}


class TestCrossTemplateConsistency:
    def test_every_cross_template_divergence_is_declared(self):
        parsed = {
            name: effective_values(parse_env_file(REPO_ROOT / name))
            for name in ENV_TEMPLATES
        }
        all_keys: set[str] = set()
        for values in parsed.values():
            all_keys |= set(values)
        undeclared: dict[str, dict[str, str]] = {}
        for key in sorted(all_keys):
            present = {
                name: values[key]
                for name, values in parsed.items()
                if key in values
            }
            if len(set(present.values())) <= 1:
                continue
            if key not in DIVERGENCE_IS_INTENTIONAL:
                undeclared[key] = present
        assert not undeclared, (
            'These keys hold different values across templates but are not '
            'listed in DIVERGENCE_IS_INTENTIONAL. Add the key with a reason if '
            'the divergence is intended, or fix the value if it is not:\n'
            + '\n'.join(
                f'  {key}: ' + ', '.join(f'{n}={v!r}' for n, v in present.items())
                for key, present in undeclared.items()
            )
        )

    def test_intentional_divergences_still_diverging(self):
        """Guard the map itself against rot.

        A key parked in ``DIVERGENCE_IS_INTENTIONAL`` that no longer diverges
        is a stale exemption: it would suppress a future, real divergence
        silently. Any that have converged are removed instead.
        """
        parsed = {
            name: effective_values(parse_env_file(REPO_ROOT / name))
            for name in ENV_TEMPLATES
        }
        stale = [
            key for key in DIVERGENCE_IS_INTENTIONAL
            if len({parsed[n][key] for n in ENV_TEMPLATES if key in parsed[n]}) <= 1
        ]
        assert not stale, (
            'These keys are exempted from the divergence check but no longer '
            'diverge. Remove them from DIVERGENCE_IS_INTENTIONAL: '
            + ', '.join(sorted(stale))
        )

    def test_fleet_wide_keys_are_present_where_required(self):
        missing: list[str] = []
        for key, required_in in FLEET_WIDE_REQUIRED.items():
            for name in required_in:
                values = effective_values(parse_env_file(REPO_ROOT / name))
                if key not in values:
                    missing.append(f'{name}: {key}')
        assert not missing, (
            'Keys required by an environment are not declared in it. An '
            'operator of that environment has no way to discover the key '
            'exists, so the environment silently runs on a code default:\n  '
            + '\n  '.join(missing)
        )

    def test_no_template_declares_a_hand_written_database_url(self):
        """Finding 4: the password must have exactly one home.

        ``DATABASE_URL`` used to be a full hand-written URL in
        ``.env.vps.example`` and ``.env.laptop.example`` *alongside* the four
        ``DB_*`` values, so the password existed twice and could diverge
        without any error. Every compose file now assembles it from
        ``DB_USER``/``DB_PASSWORD``/``DB_HOST``/``DB_PORT``/``DB_NAME``.
        """
        offenders: list[str] = []
        for name in ENV_TEMPLATES:
            for lineno, key, value in parse_env_file(REPO_ROOT / name):
                if key == 'DATABASE_URL':
                    offenders.append(f'{name}:{lineno} = {value}')
        assert not offenders, (
            'DATABASE_URL must not be an active key in any template — compose '
            'does not expand ${...} inside an env file, so a value there '
            'arrives literally and duplicates the DB_* password:\n  '
            + '\n  '.join(offenders)
        )


# ---------------------------------------------------------------------------
# 3. Secrets are never real values
# ---------------------------------------------------------------------------
class TestSecretsArePlaceholders:
    @pytest.mark.parametrize('template', ENV_TEMPLATES)
    @pytest.mark.parametrize('key', SECRET_KEYS)
    def test_secret_key_is_empty_or_placeholder(self, template, key):
        values = effective_values(parse_env_file(REPO_ROOT / template))
        if key not in values:
            pytest.skip(
                f'{key} is not declared in {template} — nothing to validate. '
                '(Declared in: '
                + ', '.join(
                    n for n in ENV_TEMPLATES
                    if key in effective_values(parse_env_file(REPO_ROOT / n))
                )
                + ')'
            )
        value = values[key]
        assert is_placeholder(value), (
            f'{template}: {key} looks like a real credential ({value!r}). '
            'The templates are committed to git, so anything here is public. '
            'Use an empty value, a <angle-bracket> marker, or the '
            '"change-me-..." convention.'
        )

    @pytest.mark.parametrize('template', ENV_TEMPLATES)
    def test_no_declared_secret_is_a_weak_literal(self, template):
        """Broad sweep, not just the five keys above.

        Guards against the next secret being added with a literal default. A
        value that is neither empty nor a recognised placeholder must be long
        and varied enough not to be guessable.
        """
        suspicious: list[str] = []
        for _lineno, key, value in parse_env_file(REPO_ROOT / template):
            if not re.search(r'(SECRET|PASSWORD|TOKEN|API_KEY|KEY)$', key):
                continue
            if is_placeholder(value):
                continue
            if len(value) < 16 or len(set(value.lower())) < 8:
                suspicious.append(f'{key} = {value!r}')
        assert not suspicious, (
            f'{template}: secret-shaped keys whose value is neither empty nor '
            'an obvious placeholder, and is too short/varied-poor to be a real '
            'credential:\n  ' + '\n  '.join(suspicious)
        )


# ---------------------------------------------------------------------------
# 4. DJANGO_DEBUG is never True in a tracked env file
# ---------------------------------------------------------------------------
class TestDebugFlag:
    def test_no_tracked_env_file_sets_debug_true(self):
        """Mirrors ``scripts/check_no_tracked_env.sh``.

        Deliberately duplicative of the CI shell script: the script only runs
        on files git already tracks, so a template staged for its first commit
        is unguarded until it lands. This runs in the ordinary suite.
        """
        violations: list[str] = []
        for path in tracked_env_file_paths():
            for lineno, key, value in parse_env_file(path):
                if key == 'DJANGO_DEBUG' and value.lower() in TRUTHY_DEBUG:
                    rel = path.relative_to(REPO_ROOT)
                    violations.append(f'{rel}:{lineno} DJANGO_DEBUG={value}')
        assert not violations, (
            'DJANGO_DEBUG=True in a tracked env file. Tracked env files must '
            'have DJANGO_DEBUG=False — the `if not DEBUG:` block in settings.py '
            'gates SECURE_SSL_REDIRECT, HSTS and secure cookies on it, and '
            'sentry.py:26 also no-ops when it is true, so a True here '
            'disables error capture too:\n  ' + '\n  '.join(violations)
        )

    def test_matches_the_ci_script_truthy_set(self):
        """This suite and CI must agree on what "True" means.

        If someone widens the CI regex, the guard in CI and the guard here
        diverge and one of them silently stops covering the case.
        """
        script = (REPO_ROOT / 'scripts' / 'check_no_tracked_env.sh').read_text()
        match = re.search(
            r'DJANGO_DEBUG.*?=\[\[:space:\]\]\*\((?P<alts>[^)]*)\)', script
        )
        assert match, (
            'Could not find the DJANGO_DEBUG truthy alternation in '
            'scripts/check_no_tracked_env.sh. Update TRUTHY_DEBUG in this file '
            'to match whatever it now enforces.'
        )
        script_alts = {
            alt.strip().lower()
            for alt in match.group('alts').split('|')
            if alt.strip()
        }
        # The script also anchors the value, so `true-ish` does not match there;
        # here we compare the bare spellings only.
        assert script_alts == set(TRUTHY_DEBUG), (
            'Truthy DJANGO_DEBUG spellings differ between this suite and '
            f'scripts/check_no_tracked_env.sh: script={sorted(script_alts)}, '
            f'suite={sorted(TRUTHY_DEBUG)}.'
        )


# ---------------------------------------------------------------------------
# 5. No compose file hardcodes DJANGO_DEBUG=True
# ---------------------------------------------------------------------------
class TestComposeNoHardcodedDebug:
    """A literal in ``environment:`` is unoverridable.

    Per the Compose spec ``environment:`` is applied AFTER ``env_file:`` and
    wins. ``- DJANGO_DEBUG=True`` therefore cannot be changed by any env file,
    which is exactly what happened: five services in
    ``docker-compose.local.yml`` pinned it while ``.env.local`` said False, and
    ``docker compose config`` confirmed ``DJANGO_DEBUG: "True"`` in the
    rendered output.
    """

    @pytest.mark.parametrize('compose_file', OWNED_COMPOSE_FILES)
    def test_no_hardcoded_debug_true(self, compose_file):
        path = REPO_ROOT / compose_file
        assert path.exists(), f'{compose_file} is missing from the repo'
        offenders = [
            f'{compose_file}:{lineno} {key}={value!r}'
            for lineno, key, value in parse_compose_environment(path)
            if key == 'DJANGO_DEBUG' and value.lower() in TRUTHY_DEBUG
        ]
        assert not offenders, (
            'A compose service hardcodes DJANGO_DEBUG=True. Because '
            '`environment:` overrides `env_file:`, no env file can change it. '
            'Use `DJANGO_DEBUG=${DJANGO_DEBUG:-False}` as every other compose '
            'file does:\n  ' + '\n  '.join(offenders)
        )

    @pytest.mark.parametrize('compose_file', OWNED_COMPOSE_FILES)
    def test_debug_is_interpolated_not_literal(self, compose_file):
        """Stronger than "not True": the value must defer to the environment.

        A future edit that drops the key entirely would satisfy the test above
        while reintroducing the original problem in a quieter form — the
        service would then inherit whatever ``.env`` happens to say, with no
        compose-level default at all.
        """
        path = REPO_ROOT / compose_file
        declared = [
            (lineno, value)
            for lineno, key, value in parse_compose_environment(path)
            if key == 'DJANGO_DEBUG'
        ]
        assert declared, (
            f'{compose_file} sets DJANGO_DEBUG in no service environment block. '
            'Every backend service must declare it explicitly as '
            '${DJANGO_DEBUG:-False} so the prod-default is visible in review.'
        )
        non_interpolated = [
            f'{compose_file}:{lineno} {value!r}'
            for lineno, value in declared
            if '${' not in value
        ]
        assert not non_interpolated, (
            'DJANGO_DEBUG must be interpolated, not a literal, so an env file '
            'can actually change it:\n  ' + '\n  '.join(non_interpolated)
        )

    def test_parser_ignores_commented_out_values(self):
        """The parser this module relies on must not be fooled by a comment.

        Guards the guard: a naive line grep would report
        ``#   - DJANGO_DEBUG=True`` (which exists in no file today) as a live
        violation, and a future editor adding a commented-out alternative
        would be told to "fix" working configuration.
        """
        fake = REPO_ROOT / 'backend' / 'app' / 'tests' / '_compose_probe.yml'
        fake.write_text(
            'services:\n'
            '  web:\n'
            '    environment:\n'
            '      # - DJANGO_DEBUG=True\n'
            '      - DJANGO_DEBUG=${DJANGO_DEBUG:-False}\n'
            '    other_setting:\n'
            '      DJANGO_DEBUG: True\n'
        )
        try:
            entries = parse_compose_environment(fake)
        finally:
            fake.unlink()
        assert entries == [(5, 'DJANGO_DEBUG', '${DJANGO_DEBUG:-False}')], (
            'compose environment parser leaked a comment or a neighbouring '
            f'block: {entries}'
        )

    def test_the_test_stack_also_interpolates_debug(self):
        """`docker-compose.test.yml` used to be the one holdout, pinned to
        `DJANGO_DEBUG=True`.

        It was load-bearing at the time, and for a real reason: the suite drives
        the app through Django's test client on `http://testserver/` with no
        `X-Forwarded-Proto`, so `SECURE_SSL_REDIRECT=True` 301s every request.
        Two things made the pin unnecessary. `settings.py` now gates the
        production transport block on `EchoFlow.secrets.testing_enabled()`, not
        on `DEBUG`, and that check recognises pytest itself — which is imported
        strictly before pytest-django calls `django.setup()`, unlike the
        rootdir `conftest.py` whose `os.environ` writes land too late. And
        `conftest.py` no longer fakes `DJANGO_DEBUG` to get the effect, so the
        suite reports the container's real value instead of a convenient lie.

        The old xfail is now a plain assertion: the exception is gone, and this
        fails if the literal comes back.
        """
        path = REPO_ROOT / 'docker-compose.test.yml'
        offenders = [
            f'docker-compose.test.yml:{lineno} {value!r}'
            for lineno, key, value in parse_compose_environment(path)
            if key == 'DJANGO_DEBUG' and value.lower() in TRUTHY_DEBUG
        ]
        assert not offenders, (
            'docker-compose.test.yml must interpolate DJANGO_DEBUG, like every '
            'other compose file. A literal `True` here means the documented '
            'test stack runs with DEBUG=True regardless of .env, which is the '
            'exact unoverridable-literal problem this whole check exists to '
            'catch — and the suite no longer needs it, because settings.py '
            'gates the transport block on testing_enabled().\n  '
            + '\n  '.join(offenders)
        )


# ---------------------------------------------------------------------------
# 6. settings.py <-> template symmetry
# ---------------------------------------------------------------------------
#: Operator-tunable keys that intentionally appear in NO template. Each needs
#: a reason, and each is a decision someone has to revisit — a new
#: ``os.getenv`` that is not here turns the symmetry test red.
_NOT_IN_ANY_TEMPLATE: dict[str, str] = {
    'DATABASE_URL': (
        'MUST NEVER be an active key in a template: compose does not expand '
        '${...} inside an env file, so every service assembles it from DB_* in '
        'its `environment:` block. Asserted directly by '
        'test_no_template_declares_a_hand_written_database_url.'
    ),
    'LOG_LEVEL': 'Root logger level. Defaults to INFO; a blanket raise hides '
                 'warnings, a blanket lower floods. Per-logger overrides below.',
    'DJANGO_LOG_LEVEL': 'Per-logger override; see LOG_LEVEL.',
    'APP_LOG_LEVEL': 'Per-logger override; see LOG_LEVEL.',
    'CELERY_LOG_LEVEL': 'Per-logger override; see LOG_LEVEL.',
    'PHYSICAL_ADDRESS': 'Deliberately left commented out in .env.example and '
                        '.env.vps.example: the sample is a fake address, and '
                        'shipping it as an active default would put a fiction '
                        'in front of a /legal/compliance/ response. An operator '
                        'who has a real address uncomments it.',
    'PRIVACY_VERSION': 'Undocumented knob. settings.py:1065 defaults it to '
                       '"v1.0" and nothing publishes it; whether it should be '
                       'operator-set is an open question for the owner.',
    'SCRAPER_STATE_DIR': 'Internal state directory for the (currently '
                         'disabled, currently unimportable) scraper. No '
                         'operator has ever set it.',
    'SCRAPER_LOG_DIR': 'Same as SCRAPER_STATE_DIR.',
    'SCRAPER_DOWNLOAD_MAX_ATTEMPTS': 'Retry-count tuning for the disabled '
                                     'scraper. Safe code default (3).',
    'SCRAPER_DOWNLOAD_BACKOFF': 'Backoff tuning for the disabled scraper. Safe '
                                'code default (2.0s).',
    'SCRAPER_OPENVERSE_API_KEY': 'Connector is commented out in settings.py '
                                 '~line 472 ("DISABLED: uncomment once '
                                 'configured"), so the key cannot be used.',
    'SCRAPER_PIXABAY_API_KEY': 'Connector commented out in settings.py, as above.',
    'SCRAPER_PODCAST_INDEX_API_KEY': 'Connector commented out in settings.py.',
    'SCRAPER_PODCAST_INDEX_API_SECRET': 'Connector commented out in settings.py.',
    'SCRAPER_PODCAST_RSS_DEFAULT': 'Belongs to the disabled podcast_index '
                                   'connector.',
    'FEED_POOL_GLOBAL_TOP_N': 'Feed-pool sizing. Code default 10000 is sized '
                              'for the catalog; tuning it is a capacity task, '
                              'not a deployment step.',
    'FEED_POOL_USER_TOP_N': 'Feed-pool sizing. Code default 1000.',
    'FEED_POOL_GLOBAL_TTL': 'Feed-pool sizing. Code default 300s.',
    'FEED_POOL_USER_TTL': 'Feed-pool sizing. Code default 86400s.',
    'FEED_POOL_REBUILD_CHUNK_SIZE': 'Feed-pool sizing. Code default 1000.',
    'TEST_REDIS_CACHE_DB': (
        'Per-test-RUN Redis database index, passed as '
        '`docker compose exec -e TEST_REDIS_CACHE_DB=14` so two concurrent '
        'runs get separate keyspaces. Deliberately never an active template '
        'key: an operator who set it in .env would pin the *development* stack '
        'to the suite\'s index, which is the shared-state defect it exists to '
        'remove. Read only when testing_enabled() is true, so gunicorn and '
        'the Celery fleet ignore it regardless.'
    ),
    'TEST_REDIS_CACHE_URL': (
        'Full-URL form of the above, for a CI runner whose Redis is not the '
        'one compose configured. Same reasoning for being absent from every '
        'template.'
    ),
}


class TestSettingsTemplateSymmetry:
    def test_every_settings_env_key_is_declared_or_explained(self):
        declared: set[str] = set()
        for name in ENV_TEMPLATES:
            declared |= set(effective_values(parse_env_file(REPO_ROOT / name)))
        missing = sorted(settings_env_keys() - declared)
        undeclared = [key for key in missing if key not in _NOT_IN_ANY_TEMPLATE]
        assert not undeclared, (
            'settings.py reads these environment variables, but they appear in '
            'NO env template and are not listed in _NOT_IN_ANY_TEMPLATE. An '
            'operator therefore has no way to discover them. Either add them '
            'to a template with an accurate comment, or record why not:\n  '
            + '\n  '.join(undeclared)
            + f'\n\n(full missing set, {len(missing)} keys: '
            + ', '.join(missing) + ')'
        )

    def test_stale_exclusions_are_empty(self):
        """A key parked in ``_NOT_IN_ANY_TEMPLATE`` that IS in a template is rot.

        The exemption would then suppress nothing while implying a decision
        that was reversed.
        """
        declared: set[str] = set()
        for name in ENV_TEMPLATES:
            declared |= set(effective_values(parse_env_file(REPO_ROOT / name)))
        stale = sorted(set(_NOT_IN_ANY_TEMPLATE) & declared)
        assert not stale, (
            'These keys are in _NOT_IN_ANY_TEMPLATE but now appear in a '
            'template. Remove the exemption: ' + ', '.join(stale)
        )

    def test_exclusions_are_all_still_read_by_settings(self):
        """Every exemption must correspond to a live os.getenv.

        Otherwise a deleted settings.py line leaves a permanent, invisible
        hole in the symmetry check.
        """
        keys = settings_env_keys()
        orphaned = sorted(set(_NOT_IN_ANY_TEMPLATE) - keys)
        assert not orphaned, (
            '_NOT_IN_ANY_TEMPLATE names keys settings.py no longer reads. '
            'Delete them: ' + ', '.join(orphaned)
        )

    def test_key_extraction_finds_the_known_anchors(self):
        """Pins the extractor itself.

        The symmetry test is only as good as the regex behind it. If a
        refactor changes how settings.py reads the environment, this test must
        fail rather than silently shrinking the key set to nothing.
        """
        keys = settings_env_keys()
        for anchor in (
            'DJANGO_DEBUG', 'DJANGO_SECRET_KEY', 'DATABASE_URL',
            'MEDIA_TOKEN_SECRET', 'SHARE_TOKEN_TTL_SECONDS',
            'PUBLIC_APP_BASE_URL', 'READ_DATABASE_URL', 'SCRAPER_ENABLED',
        ):
            assert anchor in keys, (
                f'settings.py key extraction missed {anchor!r} — the symmetry '
                'test above is not looking at the whole file.'
            )
        assert len(keys) > 50, (
            f'settings_env_keys() returned only {len(keys)} keys; the pattern '
            'has probably stopped matching.'
        )
