import React, { useState } from 'react';
import { ScrollView, Text, TextInput, View, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';

import { Button } from '../../src/components/ui/Button';
import { uiStyles, uiTints, onAccent } from '../../src/components/ui/primitives';
import { content, surface, border, accent, spacing, radius } from '../../src/design/tokens';
import { typography } from '../../src/design/typography';
import { useAuthStore } from '../../src/store/auth';

/**
 * Login. `POST /auth/login/`, throttle scope `login` = **10/min/IP** — a strict
 * limit chosen against credential stuffing, and IP-keyed so it is shared across
 * a carrier NAT. Two consequences the UI has to respect:
 *
 *  1. A 429 here is NOT a wrong password. Saying "wrong password" sends the
 *     user into a retry loop that guarantees the 429 continues. The auth store
 *     surfaces the server's message, and this screen says "wait".
 *  2. There is no client-side lockout to add — the server owns it.
 */
export default function LoginScreen() {
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const busy = useAuthStore((s) => s.busy);
  const error = useAuthStore((s) => s.error);
  const status = useAuthStore((s) => s.status);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy;

  const onSubmit = async () => {
    if (!canSubmit) return;
    try {
      await login(username.trim(), password);
      router.replace('/(tabs)');
    } catch {
      // Message is already in the store; rendered below.
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: surface.base }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={typography.microLabel}>EchoFlow</Text>
          <Text style={styles.title}>Sign in</Text>
          <Text style={styles.subtitle}>TikTok for your ears.</Text>
        </View>

        {status === 'expired' ? (
          <View style={[styles.notice, styles.noticeInfo]}>
            <Text style={styles.noticeText}>
              Your session expired. Sign in again to continue.
            </Text>
          </View>
        ) : null}

        {error ? (
          <View style={[styles.notice, styles.noticeError]} testID="login-error">
            <Text style={styles.noticeText}>{error}</Text>
          </View>
        ) : null}

        <View style={styles.form}>
          <View style={styles.field}>
            <Text style={typography.microLabel}>Username</Text>
            <TextInput
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              // KEYBOARD: the register form must not submit on every keystroke
              // (register_username is 3/hour per username). Same posture here.
              autoComplete="username"
              textContentType="username"
              style={uiStyles.input}
              placeholder="your handle"
              placeholderTextColor={content.tertiary}
              testID="login-username"
              returnKeyType="next"
            />
          </View>

          <View style={styles.field}>
            <Text style={typography.microLabel}>Password</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="current-password"
              textContentType="password"
              style={uiStyles.input}
              placeholder="••••••••"
              placeholderTextColor={content.tertiary}
              testID="login-password"
              returnKeyType="go"
              onSubmitEditing={onSubmit}
            />
          </View>

          <Button
            label="Sign in"
            onPress={onSubmit}
            disabled={!canSubmit}
            loading={busy}
            testID="login-submit"
          />

          <Button
            label="Create an account"
            variant="ghost"
            onPress={() => router.push('/(auth)/register')}
            testID="login-goto-register"
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
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
  },
  header: { gap: 6, marginBottom: spacing.stack },
  title: { ...typography.page, color: content.primary },
  subtitle: { ...typography.bodySecondary, color: content.tertiary },
  form: { gap: spacing.gutter },
  field: { gap: 6 },
  notice: {
    padding: spacing.gutter,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: 4,
  },
  noticeInfo: { backgroundColor: uiTints.accentSoft, borderColor: accent.base },
  noticeError: { backgroundColor: uiTints.dangerSoft, borderColor: content.tertiary },
  noticeText: { ...typography.body, fontSize: 12, color: content.primary },
} as const;
