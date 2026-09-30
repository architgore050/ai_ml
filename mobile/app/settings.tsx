import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { Button } from '../src/components/ui/Button';
import { getLegalCompliance } from '../src/api/endpoints/auth';
import { getDataSummary, requestDataErasure, submitGrievance } from '../src/api/endpoints/legal';
import { content, spacing, surface, accent, border } from '../src/design/tokens';
import { typography } from '../src/design/typography';
import { useSubscription } from '../src/hooks/useSubscription';

/** Account, billing, legal contacts and data-subject controls. */
export default function SettingsScreen() {
  const subscription = useSubscription();
  const [contacts, setContacts] = useState<Record<string, unknown> | null>(null);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [purchasingProductId, setPurchasingProductId] = useState<string | null>(null);

  useEffect(() => { void getLegalCompliance().then((value) => setContacts(value as Record<string, unknown>)).catch(() => undefined); }, []);

  const openPortal = async () => {
    try { await WebBrowser.openBrowserAsync(await subscription.openCustomerPortal()); }
    catch (cause) { Alert.alert('Could not open billing', cause instanceof Error ? cause.message : 'Try again.'); }
  };
  const showPlans = async () => {
    try { await subscription.presentPaywall(); }
    catch (cause) { Alert.alert('Could not open plans', cause instanceof Error ? cause.message : 'Try again.'); }
  };
  const purchasePlan = async (productId: string) => {
    setPurchasingProductId(productId);
    try { await subscription.purchasePlan(productId); }
    catch (cause) { Alert.alert('Purchase could not be completed', cause instanceof Error ? cause.message : 'Try again.'); }
    finally { setPurchasingProductId(null); }
  };
  const sendGrievance = async () => {
    if (!subject.trim() || !description.trim()) return;
    setBusy(true);
    try { Alert.alert('Grievance submitted', (await submitGrievance({ subject, description })).message); setSubject(''); setDescription(''); }
    catch (cause) { Alert.alert('Could not submit grievance', cause instanceof Error ? cause.message : 'Try again.'); }
    finally { setBusy(false); }
  };
  const viewSummary = async () => {
    try { setSummary((await getDataSummary()).categories); }
    catch (cause) { Alert.alert('Could not load data summary', cause instanceof Error ? cause.message : 'Try again.'); }
  };
  const confirmErasure = () => Alert.alert(
    'Request account deletion?',
    'Your account will enter a 30-day cooling-off period. After that, deletion is scheduled and retained audit records are anonymised.',
    [{ text: 'Cancel', style: 'cancel' }, { text: 'Request deletion', style: 'destructive', onPress: () => void requestDataErasure().then((result) => Alert.alert('Deletion request submitted', result.message)).catch((cause) => Alert.alert('Could not request deletion', cause instanceof Error ? cause.message : 'Try again.')) }],
  );

  return <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
    <Text style={styles.title}>Settings</Text>
    <Section title="Subscription">
      <Text style={styles.body}>{subscription.isPro ? 'Pro is active.' : 'Free plan'}</Text>
      {!subscription.isPro ? <Button label="View plans" onPress={() => void showPlans()} /> : null}
      {!subscription.isPro ? subscription.plans.map((plan) => (
        <Button key={plan.productId} label={`${plan.title} — ${plan.price}`} onPress={() => void purchasePlan(plan.productId)} loading={purchasingProductId === plan.productId} disabled={purchasingProductId !== null} variant="ghost" />
      )) : null}
      <Button label="Manage subscription" onPress={() => void openPortal()} variant="ghost" />
      <Button label="Refresh subscription" onPress={() => void subscription.sync()} variant="ghost" loading={subscription.refreshing} />
      {subscription.error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{subscription.error}</Text> : null}
    </Section>
    <Section title="Your data">
      <Button label="View data summary" onPress={() => void viewSummary()} variant="ghost" />
      {summary ? <Text style={styles.body}>{Object.entries(summary).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join('\n')}</Text> : null}
      <Button label="Request account deletion" onPress={confirmErasure} variant="ghost" />
    </Section>
    <Section title="Grievance">
      <TextInput accessibilityLabel="Grievance subject" value={subject} onChangeText={setSubject} placeholder="Subject" placeholderTextColor={content.tertiary} maxLength={200} style={styles.input} />
      <TextInput accessibilityLabel="Grievance description" value={description} onChangeText={setDescription} placeholder="Describe the issue" placeholderTextColor={content.tertiary} maxLength={5000} multiline style={[styles.input, styles.description]} />
      <Button label="Submit grievance" onPress={() => void sendGrievance()} disabled={!subject.trim() || !description.trim()} loading={busy} />
    </Section>
    <Section title="Compliance contacts">
      <Text style={styles.body}>{contacts ? JSON.stringify(contacts, null, 2) : 'Loading contacts…'}</Text>
    </Section>
  </ScrollView>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>;
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, backgroundColor: surface.base, padding: spacing.stack, gap: spacing.stack },
  title: { ...typography.page, color: content.primary },
  section: { borderWidth: 1, borderColor: border.default, borderRadius: 16, padding: spacing.stack, gap: spacing.gutter },
  sectionTitle: { ...typography.label, color: accent.base }, body: { ...typography.bodySecondary, color: content.secondary },
  error: { ...typography.bodySecondary, color: '#ffb4ab' },
  input: { minHeight: 48, borderWidth: 1, borderColor: border.default, borderRadius: 12, paddingHorizontal: spacing.gutter, color: content.primary },
  description: { minHeight: 110, paddingVertical: spacing.gutter, textAlignVertical: 'top' },
});
