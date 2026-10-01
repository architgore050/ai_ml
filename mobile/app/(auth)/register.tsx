import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, TextInput, View, Pressable, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';

import { Button } from '../../src/components/ui/Button';
import { uiStyles, uiTints, MIN_TOUCH_TARGET } from '../../src/components/ui/primitives';
import { content, surface, accent, spacing, radius, border } from '../../src/design/tokens';
import { typography } from '../../src/design/typography';
import { getLegalCompliance, authErrorMessage } from '../../src/api/endpoints/auth';
import { ApiError } from '../../src/api/client';
import type { LegalCompliance } from '../../src/api/schema';
import { useAuthStore } from '../../src/store/auth';

/**
 * Registration. The compliance-sensitive screen in the app, so each rule gets
 * its rationale in a comment rather than a bare control.
 *
 * DPDP §11 — affirmative consent: the checkbox starts UNCHECKED. The old app
 * shipped `consentAccepted = useState(true)` (UploadScreen.tsx:34 at 3aea96d),
 * which is pre-ticked consent. The endpoint already rejects `false`; this
 * prevents the app from ever offering to send a false claim.
 *
 * DPDP §9 — the age gate: `dob` is REQUIRED (B1, 2026-09-29). It was
 * `required=False`, which meant a client that simply omitted it registered as
 * an adult — the optionality *was* the bypass, because the platform cannot know
 * whether it is processing a child's data if the client controls whether it
 * finds out. Under 18 the server sets `is_minor=True` and requires a guardian
 * email, and then **403s `log-telemetry/`** for that account.
 *
 * `terms_version` is fetched, never hardcoded: it is validated against
 * `settings.TERMS_VERSIONS`, so a hardcoded "v1.0" 400s the day a version is
 * appended.
 */

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const ADULT_AGE_YEARS = 18;

function ageFromDob(dob: string, now = new Date()): number | null {
  // Compare by calendar fields, not by dividing milliseconds: a leap-day birth
  // date would make a ms/365.25 year estimate drift by a day. The backend uses
  // the same field-wise comparison.
  const [y, m, d] = dob.split('-').map(Number);
  if (!y || !m || !d) return null;
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) {
    age -= 1;
  }
  return age;
}

export default function RegisterScreen() {
  const router = useRouter();
  const register = useAuthStore((s) => s.register);
  const busy = useAuthStore((s) => s.busy);
  const storeError = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);

  const [legal, setLegal] = useState<LegalCompliance | null>(null);
  const [legalError, setLegalError] = useState<string | null>(null);

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [dob, setDob] = useState('');
  const [parentEmail, setParentEmail] = useState('');
  const [consent, setConsent] = useState(false); // DPDP §11: unchecked.
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Scope 'legal' is 30/hour and IP-keyed — fetch once at mount, never poll.
  useEffect(() => {
    let cancelled = false;
    getLegalCompliance()
      .then((data) => {
        if (!cancelled) setLegal(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setLegalError(
            authErrorMessage(err) ??
              'Could not load the current terms version. Check your connection and try again.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => clearError, [clearError]);

  const age = useMemo(() => (dob ? ageFromDob(dob) : null), [dob]);
  const isMinor = age != null && age < ADULT_AGE_YEARS;

  const onSubmit = useCallback(async () => {
    if (busy) return;
    setFieldError(null);
    clearError();

    if (!consent) {
      setFieldError('You must accept the terms and privacy policy to create an account.');
      return;
    }
    if (!legal?.current_terms_version) {
      setFieldError('The terms version is still loading. Try again in a moment.');
      return;
    }
    if (!dob) {
      setFieldError('Date of birth is required.');
      return;
    }
    if (isMinor && !parentEmail.trim()) {
      setFieldError('A parent or guardian email is required for users under 18.');
      return;
    }

    try {
      await register({
        username: username.trim(),
        email: email.trim(),
        password,
        consent_accepted: true,
        terms_version: legal.current_terms_version,
        dob,
        ...(isMinor ? { parent_email: parentEmail.trim() } : {}),
      });
      router.replace('/(tabs)');
    } catch (err) {
      // Prefer DRF's per-field message: e.g. the server's own
      // "Invalid terms version. Allowed: ['v1.0', 'v1.1']".
      setFieldError(authErrorMessage(err) ?? 'Could not create the account.');
    }
  }, [busy, clearError, consent, dob, email, isMinor, legal, parentEmail, password, register, router, username]);

  // register_username is 3/hour per username. Disable the field while the
  // request is in flight so a slow response cannot be followed by a second
  // submit that lands outside the limit.
  const canSubmit =
    !busy &&
    !!legal &&
    username.trim().length > 0 &&
    email.trim().length > 0 &&
    password.length > 0 &&
    !!dob &&
    consent &&
    (!isMinor || parentEmail.trim().length > 0);

  const notice = fieldError ?? storeError;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: surface.base }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={typography.microLabel}>EchoFlow</Text>
          <Text style={styles.title}>Create an account</Text>
        </View>

        {legalError ? (
          <View style={[styles.notice, styles.noticeError]}>
            <Text style={styles.noticeText}>{legalError}</Text>
          </View>
        ) : null}

        {notice ? (
          <View style={[styles.notice, styles.noticeError]} testID="register-error">
            <Text style={styles.noticeText}>{notice}</Text>
          </View>
        ) : null}

        <View style={styles.form}>
          <Field label="Username" hint="3 attempts per hour — typos are rate limited.">
            <TextInput
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              style={uiStyles.input}
              placeholder="your handle"
              placeholderTextColor={content.tertiary}
              testID="register-username"
            />
          </Field>

          <Field label="Email">
            <TextInput
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              style={uiStyles.input}
              placeholder="you@example.com"
              placeholderTextColor={content.tertiary}
              testID="register-email"
            />
          </Field>

          <Field label="Password">
            <TextInput
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="new-password"
              style={uiStyles.input}
              placeholder="••••••••"
              placeholderTextColor={content.tertiary}
              testID="register-password"
            />
          </Field>

          <Field
            label="Date of birth"
            hint="Required. It determines whether DPDP §9 minor protections apply."
          >
            <TextInput
              value={dob}
              onChangeText={setDob}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={content.tertiary}
              keyboardType="numbers-and-punctuation"
              style={uiStyles.input}
              testID="register-dob"
            />
          </Field>

          {isMinor ? (
            <View style={styles.minorPanel} testID="register-minor-panel">
              <Text style={styles.minorTitle}>You are under 18</Text>
              <Text style={styles.minorBody}>
                A parent or guardian email is required. Listening-history telemetry is
                switched off for your account, so we never build behavioural profiles
                from what you play. Likes and skips still work.
              </Text>
              <TextInput
                value={parentEmail}
                onChangeText={setParentEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                style={[uiStyles.input, styles.minorInput]}
                placeholder="guardian@example.com"
                placeholderTextColor={content.tertiary}
                testID="register-parent-email"
              />
            </View>
          ) : null}

          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: consent }}
            accessibilityLabel="Accept terms and privacy policy"
            onPress={() => setConsent((c) => !c)}
            style={styles.consentRow}
            testID="register-consent"
          >
            <View style={[styles.checkbox, consent && styles.checkboxChecked]}>
              {consent ? <Text style={styles.checkmark}>✓</Text> : null}
            </View>
            <Text style={styles.consentText}>
              I accept the terms of service and privacy policy
              {legal?.current_terms_version ? ` (${legal.current_terms_version})` : ''}.
            </Text>
          </Pressable>

          <Button
            label="Create account"
            onPress={onSubmit}
            disabled={!canSubmit}
            loading={busy}
            testID="register-submit"
          />

          <Button
            label="Back to sign in"
            variant="ghost"
            onPress={() => router.back()}
            testID="register-goto-login"
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={typography.microLabel}>{label}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {children}
    </View>
  );
}

const styles = {
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.stack,
    gap: spacing.gutter,
    maxWidth: 470,
    width: '100%',
    alignSelf: 'center',
    paddingBottom: spacing.stack * 2,
  },
  header: { gap: 6, marginBottom: spacing.stack },
  title: { ...typography.page, color: content.primary },
  form: { gap: spacing.gutter },
  field: { gap: 6 },
  hint: { ...typography.body, fontSize: 11, color: content.tertiary },
  notice: { padding: spacing.gutter, borderRadius: radius.md, borderWidth: 1 },
  noticeError: { backgroundColor: uiTints.dangerSoft, borderColor: content.tertiary },
  noticeText: { ...typography.body, fontSize: 12, color: content.primary },
  minorPanel: {
    padding: spacing.gutter,
    borderRadius: radius.md,
    backgroundColor: uiTints.accentSoft,
    borderWidth: 1,
    borderColor: accent.base,
    gap: 8,
  },
  minorTitle: { ...typography.title, fontSize: 15, color: content.primary },
  minorBody: { ...typography.bodySecondary, fontSize: 12 },
  minorInput: { backgroundColor: surface.containerLow },
  consentRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
    minHeight: MIN_TOUCH_TARGET,
    paddingVertical: 8,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: border.strong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: accent.base, borderColor: accent.base },
  checkmark: { color: '#4a280c', fontWeight: '900', fontSize: 14, lineHeight: 18 },
  consentText: { ...typography.body, fontSize: 12, color: content.secondary, flex: 1 },
} as const;
