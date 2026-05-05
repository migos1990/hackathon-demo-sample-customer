/**
 * In-memory store for AcmeHR-lite.
 *
 * Map<uid, AcmeHrUser>. No persistence between server restarts — the demo
 * doesn't need it, and avoiding SQLite removes a dep + native-binary concern
 * that would add zero demo value.
 *
 * This store intentionally mirrors the same read/mutate surface the generated
 * SCIM connector's target-app client would call. The connector is what talks
 * SCIM to Okta; the connector uses AcmeHR's native LDAP-shaped API, which IS
 * this store fronted by HTTP routes.
 */
import type { AcmeHrUser, AcmeHrUserCreate, AcmeHrUserPatch } from "./types.js";

export class InMemoryAcmeHrStore {
  private users = new Map<string, AcmeHrUser>();

  create(input: AcmeHrUserCreate): AcmeHrUser {
    if (this.users.has(input.uid)) {
      throw new Error(`uid already exists: ${input.uid}`);
    }
    const user: AcmeHrUser = { ...input, lastModified: nowIso() };
    this.users.set(user.uid, user);
    return user;
  }

  get(uid: string): AcmeHrUser | null {
    return this.users.get(uid) ?? null;
  }

  list(): AcmeHrUser[] {
    return [...this.users.values()];
  }

  patch(uid: string, patch: AcmeHrUserPatch): AcmeHrUser | null {
    const existing = this.users.get(uid);
    if (!existing) return null;
    const updated: AcmeHrUser = {
      ...existing,
      ...patch,
      lastModified: nowIso(),
    };
    this.users.set(uid, updated);
    return updated;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
