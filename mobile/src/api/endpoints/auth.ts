import { apiFetch, ApiError } from '../client';
import {
  legalComplianceSchema,
  ownProfileSchema,
  registerUserSchema,
  tokenPairSchema,
  type LegalCompliance,
  type OwnProfile,
  type TokenPair,
} from '../schema';

/**
 * Auth endpoints. Thin and typed — no logic here. The logic (session state,
 * navigation on expiry) lives in src/store/auth.ts.
 *
 * Routes, from backend/app/urls.py:78-82:
 *   POST /auth/register/      RegisterView         (AllowAny, anon)
 *   POST /auth/login/         ThrottledTokenObtainPairView  scope 'login' 10/min/IP
 *   POST /auth/token/refresh/ ThrottledTokenRefreshView     scope 'token_refresh' 120/hour
 *   POST /auth/logout/        LogoutView           (IsAuthenticated)
 *   GET  /legal/compliance/   ComplianceContactView (AllowAny, scope 'legal' 30/hour)
 */

export type RegisterInput = {
  username: string;
  email: string;
  password: string;
  /** Required. DPDP §11 affirmative consent — and the old app pre-ticked it. */
  consent_accepted: boolean;
  /** Required, validated against settings.TERMS_VERSIONS. Fetch from
   *  `getLegalCompliance()`; do not hardcode. */
  terms_version: string;
  /** Required since B1 (2026-09-29). */
  dob: string;
  /** Required by the server when the computed age is under 18. */
  parent_email?: string;
};

/**
 * SECURITY: throws unless `consent_accepted` is true. The server already
 * rejects a false value, but the client must not be able to send a request that
 * a network interceptor or a retry could turn into a false claim.
 *
 * `dob` is required (B1: it was `required=False`, which let a client dodge the
 * DPDP §9 age gate by omission). `terms_version` must be one the server
 * accepts — the error message lists the allowed values, so a 400 is
 * self-correcting, but fetching the list first avoids the bad UX entirely.
 */
export async function register(input: RegisterInput): Promise<void> {
  if (input.consent_accepted !== true) {
    throw new Error('register() requires explicit consent (consent_accepted).');
  }
  if (!input.terms_version) {
    throw new Error('register() requires terms_version; fetch it from /legal/compliance/.');
  }
  if (!input.dob) {
    throw new Error('register() requires dob — it gates the DPDP §9 minor path.');
  }

  // The response is 201 with a User and NO tokens, by design. See schema.ts
  // registerUserSchema; the caller must follow up with login().
  const result = await apiFetch('/auth/register/', {
    method: 'POST',
    body: input,
    skipAuth: true,
  });
  registerUserSchema.parse(result);
}

/** Returns the token pair. Scope 'login' is 10/min/IP (credential stuffing). */
export async function login(
  username: string,
  password: string,
): Promise<TokenPair> {
  const result = await apiFetch('/auth/login/', {
    method: 'POST',
    body: { username, password },
    skipAuth: true,
  });
  return tokenPairSchema.parse(result);
}

/**
 * Blacklists the refresh token. `urls.py:62` LogoutView is `IsAuthenticated`
 * and 400s on a missing or invalid `refresh`.
 *
 * The caller must clear local state in a `finally` — a network failure here
 * must still sign the user out locally, or the app shows a logged-out UI with
 * live tokens still on the device.
 */
export async function logout(refresh: string): Promise<void> {
  await apiFetch('/auth/logout/', { method: 'POST', body: { refresh } });
}

/** Own profile. Also the session-restore validation call. */
export async function getMyProfile(): Promise<OwnProfile> {
  const result = await apiFetch('/profile/me/');
  return ownProfileSchema.parse(result);
}

/**
 * Terms/officer contacts for the registration screen.
 *
 * `AllowAny`, so no token is needed — but scope 'legal' is 30/hour and IP-keyed,
 * so fetch **once at mount** and never poll.
 */
export async function getLegalCompliance(): Promise<LegalCompliance> {
  const result = await apiFetch('/legal/compliance/', { skipAuth: true });
  return legalComplianceSchema.parse(result);
}

/** Best-effort message for a failed auth call, preferring DRF's field errors. */
export function authErrorMessage(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const first = Object.values(err.fieldErrors)[0]?.[0];
  if (first) return first;
  if (typeof err.body === 'object' && err.body && 'detail' in err.body) {
    const detail = (err.body as { detail?: unknown }).detail;
    if (typeof detail === 'string') return detail;
  }
  return null;
}
