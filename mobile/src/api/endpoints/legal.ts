import { z } from 'zod';

import { apiFetch } from '../client';

const grievanceSchema = z.object({ grievance_id: z.number(), status: z.string(), message: z.string() });
const dataSummarySchema = z.object({ user_id: z.number(), categories: z.record(z.string(), z.unknown()) });
const erasureSchema = z.object({ request_id: z.number(), status: z.string(), message: z.string(), cooling_off_until: z.string() });

export async function submitGrievance(input: { subject: string; description: string; userEmail?: string }): Promise<{ grievanceId: number; status: string; message: string }> {
  const result = grievanceSchema.parse(await apiFetch('/grievance/', {
    method: 'POST', body: { subject: input.subject.trim(), description: input.description.trim(), user_email: input.userEmail?.trim() },
  }));
  return { grievanceId: result.grievance_id, status: result.status, message: result.message };
}

export async function getDataSummary(): Promise<{ userId: number; categories: Record<string, unknown> }> {
  const result = dataSummarySchema.parse(await apiFetch('/data-subject/access/'));
  return { userId: result.user_id, categories: result.categories };
}

export async function requestDataErasure(): Promise<{ requestId: number; status: string; message: string; coolingOffUntil: string }> {
  const result = erasureSchema.parse(await apiFetch('/data-subject/erasure/', { method: 'POST', body: { confirm: true } }));
  return { requestId: result.request_id, status: result.status, message: result.message, coolingOffUntil: result.cooling_off_until };
}
