/**
 * BuggyAcmeHrUserStore — deliberately bugged variant of AcmeHrUserStore.
 *
 * THIS IS NOT A MISTAKE. This connector captures a real-world failure
 * mode the gate-refusal demo beat exercises: a junior-consultant-forgot-
 * active:false-handling bug that passes SCIM response-shape tests but
 * fails end-to-end because the target app state was never mutated.
 *
 * Behavior:
 *   - create, get, list delegate to the real AcmeHrUserStore — unchanged.
 *   - patch is the bug: returns a SCIM response that claims the PATCH
 *     applied, but never calls the AcmeHR client. AcmeHR's state does
 *     not change.
 *
 * This variant is what the gate-refusal demo beat (beats 6-8 of
 * docs/demo-script.md) ships to pre-prod. The pre-prod verify gate
 * catches it at OIN SPEC Test step 7 AND at runSmoke step 3 (target-
 * verify-deactivated). Promotion refuses. Demo story lands.
 *
 * The bug is NOT clever — it's the kind of mistake a rushed consultant
 * OR an under-specified agent produces. That's the point.
 *
 * See docs/connector-laws.md §6 SMOKE-GREEN for the gate that catches
 * this, and docs/okta-dialect.md §4 for the correct active:false flow.
 */
import type { ScimPatchOperation } from "scim-patch";
import { AcmeHrUserStore } from "../acme-hr/store.js";
import type { AcmeHrClient } from "../acme-hr/client.js";
import type {
  UserStore,
  ListOptions,
  ListResult,
} from "../../skeleton/store/user-store.js";
import type { ScimUser, StoredUser } from "../../skeleton/types.js";

export class BuggyAcmeHrUserStore implements UserStore {
  private readonly realStore: AcmeHrUserStore;

  constructor(client: AcmeHrClient) {
    this.realStore = new AcmeHrUserStore(client);
  }

  create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    return this.realStore.create(input);
  }

  get(id: string): Promise<StoredUser | null> {
    return this.realStore.get(id);
  }

  list(options: ListOptions): Promise<ListResult> {
    return this.realStore.list(options);
  }

  /**
   * THE BUG: pretend to apply the PATCH. Return a SCIM response shaped as
   * if it succeeded, but never forward the mutation to AcmeHR.
   *
   * The user thinks it worked. Their SCIM GET will show active=false
   * because the skeleton's routes might cache the store's return value.
   * But a fresh read from AcmeHR directly (which is what runSmoke step 3
   * does) reveals enabled=true still. That divergence is what the gate
   * refuses on.
   */
  async patch(id: string, _operations: ScimPatchOperation[]): Promise<StoredUser | null> {
    const existing = await this.realStore.get(id);
    if (!existing) return null;

    // Fake-apply: return a response that looks like active got flipped,
    // but SKIP the client.patchUser call. The backing AcmeHR state is
    // never mutated.
    return {
      ...existing,
      active: false,
      meta: {
        ...existing.meta,
        lastModified: new Date().toISOString(),
      },
    };
  }
}
