# Hackapalooza Demo Script — 2-Minute Submission Video

**Status:** shooting script. Locks beat sheet, shot list, VO, and pre-submission checklist.

**Track:** Agentic Internal Tools. **Audience:** Okta-internal (SCIM / OIN / tenants / Pro Serve lingo assumed without explanation).

**Hard constraints:**
- Duration ≤ 2:00 in the final upload
- No audio speedup anywhere (including B-roll montage)
- Share: "Anyone in this Okta group with the link can view"

**Style decisions (locked, reversible):**
- **Human voiceover** over edited cuts. Chosen over music+text because voice is more memorable in a pile of async-reviewed submissions.
- **Partner beat kept** (15 sec). It's the leverage hook that distinguishes this from a pure-automation pitch.
- **All B-roll is real captured output** from the repo — Linear ticket, terminal, vitest runner, OIN runner, AcmeHR-lite admin UI, signed Promotion Manifest. No staged mockups.

---

## Beat sheet (11 cuts, VO lands at ~1:48)

| # | Time | Visual (shot) | VO (spoken) | Word count |
|---|---|---|---|---|
| 1 | 0:00-0:06 | Linear UI with a filed ticket, title visible | "Pro Serve builds a SCIM connector roughly every week. Each one takes a senior consultant about five days." | 18 |
| 2 | 0:06-0:13 | Ticket YAML front-matter close-up, cursor on `customer_app_name` | "This is a ticket for AcmeHR — our customer analog — filed from the template." | 14 |
| 3 | 0:13-0:20 | Agent terminal scroll (real capture, real speed) | "Agent picks it up. Reads `docs/okta-dialect.md`. Writes the connector. 62 tests green." | 14 |
| 4 | 0:20-0:26 | Split: left `vitest run` green, right OIN SPEC runner output all green | "Runs the 12 Okta OIN SPEC tests against our staging tenant. All green." | 13 |
| 5 | 0:26-0:33 | AcmeHR-lite admin UI, users populating row by row | "Users land in AcmeHR. End to end, no human between the ticket and the tenant." | 15 |
| 6 | 0:33-0:42 | Second ticket filed, diff showing missing `active:false` handler | "Now the part that earned this submission its track. Second ticket — this one has a bug. Missing `active:false` handler." | 21 |
| 7 | 0:42-0:47 | OIN test runner, step 7 red, pipeline status red | "Pre-prod verify gate catches it. OIN step 7 red. Promotion refused." | 12 |
| 8 | 0:47-0:53 | Agent terminal: reading dialect doc, editing handler, retry green | "Agent re-reads the dialect doc, fixes the handler. Retry — 12 of 12." | 13 |
| 9 | 0:53-1:02 | Signed Promotion Manifest rendering — JSON with HMAC signature, commit SHA, fixtures hash | "Here's what ships: a signed Promotion Manifest. Commit, fixtures hash, pre-prod verify results, approver, signed with our rotating HMAC key." | 22 |
| 10 | 1:02-1:11 | Human clicks Promote → terraform apply → prod AcmeHR admin panel | "Reviewer clicks promote. Signature verifies. Prod deploys the same code that just passed staging. Provisioning live." | 17 |
| 11 | 1:11-1:27 | Partner slide: two repo forks side-by-side, Promotion Manifest with two signatures | "Same harness, forked by an implementation partner. Pre-prod write, prod deny. Prod promotion requires two signatures — theirs plus ours. Partners accelerate. Okta PS keeps the gate." | 29 |
| closer | 1:27-1:48 | Beauty shot: ticket → manifest → tenant admin UI, then title card | "Tribal knowledge captured as tests and docs. Agent-generated connectors provably equivalent to what our best consultants write. Minutes instead of days, with a gate that refuses when it should. Symphony-for-Okta Pro Serve. Agentic Internal Tools." | 40 |

**Total VO: ~228 words, ≈1:48 at 127 wpm** (natural conversational pace). 12-second buffer absorbs pacing variance.

---

## Shot list (capture before edit day)

All captures at native speed. Record longer than needed; trim in edit.

| Shot | Source | Length needed | Capture plan |
|---|---|---|---|
| S1 | Linear ticket filed from template | 10 sec | Screen record Linear after filing one real ticket (not mock) |
| S2 | Ticket YAML close-up | 10 sec | Zoomed screen grab of `new-scim-connector.md` front-matter in editor |
| S3 | Agent terminal working | 15 sec | Real Claude Agent SDK run against one ticket; speed-up forbidden, so capture 15 usable sec of interesting terminal scroll |
| S4 | `vitest run` + OIN runner green | 10 sec | Real vitest + OIN SPEC runner output |
| S5 | AcmeHR-lite admin UI | 12 sec | Live capture of the admin panel at `/admin` during a real provisioning run; multi-user append |
| S6 | Second ticket filed, diff view | 15 sec | Same as S1 for the second ticket + GitHub/editor diff view showing the bug |
| S7 | OIN step 7 red | 10 sec | Run the OIN suite against the buggy version; capture the red state |
| S8 | Agent re-reads + retries | 15 sec | Real retry run with the fix applied |
| S9 | Signed Promotion Manifest | 15 sec | Terminal + JSON viewer showing the signed manifest; HMAC signature visible |
| S10 | Promote click + terraform apply | 15 sec | CLI click + `terraform apply` output + prod admin UI |
| S11 | Partner slide + two-sig manifest | 20 sec | Static graphic: two repo forks side-by-side, manifest with 2 signatures |
| closer | Beauty shot + title card | 25 sec | Composite shots + static title card |

**Capture day target:** Day 9 of the 10-day plan. Edit day: Day 10 morning. Safety margin: capture re-shoots on Day 10 afternoon if any shot is unusable.

---

## Voiceover recording

**Script:** exact lines from the beat sheet VO column, in order. No ad-libs.

**Setup:** quiet room, phone or USB mic on a stand. Record in 3-4 passes per line; pick the best. Natural pace, don't rush to hit time — we have 12 sec buffer.

**File:** single stereo WAV, one take per line, labeled `vo-beat-<n>.wav`. Editor assembles.

**Fallback:** if VO recording quality is weak, alternate plan is music + on-screen text overlays (takes ~30 min to rewrite for text-heavy delivery; pre-write this fallback script only if VO fails).

---

## Edit sequence (Day 10 morning)

1. Import all captured shots + VO takes
2. Lay VO track first, timed to beat sheet
3. Cut each beat's visual to match VO duration
4. Transitions: hard cuts only. No crossfades. Cut density is doing the work of compression.
5. On-screen text: minimal. Only the title card at the end. Optional: small lower-third labels for `tenant: demo-customer-a-staging.oktapreview.com` during shot 4 and `manifest signed: a1979c4...` during shot 9.
6. Music: optional low-volume instrumental bed, ducked under VO. If in doubt, skip music — VO alone reads more serious.
7. Export: H.264 MP4, 1080p, single audio track. Run duration check.
8. **Pre-submission checklist (from submission-draft.md):**
   - [ ] Duration ≤ 2:00 measured in the final MP4, not the edit timeline
   - [ ] No audio speedup anywhere (play back the whole thing at 1.0x and listen for artifacts)
   - [ ] Share permission set correctly on the Drive upload

---

## Live Watch Party walkthrough (≈5 min — if opted in)

If invited to a Watch Party, the live presentation reuses the same visuals with more room to narrate. Rough structure:

1. **0:00-0:30 — Problem** — same opening, but elaborate on two dialect quirks from `docs/okta-dialect.md` (e.g., why OIN step 16 case-sensitivity is non-obvious).
2. **0:30-2:00 — Happy path** — walk through ticket → agent → tests → tenant with live commentary. Can pause on interesting points (e.g., "this is scim-patch handling the multi-op PATCH — RFC 7644 §3.5.2 atomicity guarantees, see `store/user-store.ts:…`").
3. **2:00-3:30 — Gate refusal** — live walkthrough of the bug ticket, the red state, the signed manifest internals. Show the JSON. Explain HMAC + RFC 8785 briefly.
4. **3:30-4:00 — Partner angle** — same slide, more detail. Two-of-two signature mechanics.
5. **4:00-5:00 — Q&A prep** — leave buffer for questions.

**Q&A brace-yourself list** (questions I'd ask as a judge):
- "What happens when the agent hallucinates an Okta API field?" → harness fails at test-time; `docs/okta-dialect.md` is the ground-truth agent context; SILVER LAW gate.
- "How does customer data never enter the repo?" → `scripts/sanitize-payload.ts` + pre-commit secret scan; synthetic fixtures only; demo tenants are ours.
- "What stops a partner from promoting to prod alone?" → two-of-two signature on the Promotion Manifest; branch-protection rule on prod apply would enforce in post-hackathon wire-up.
- "Is the OIN-12/12 claim measured against Okta's actual SPEC Test suite?" → replay suite against fixtures equivalent to the published SPEC Test JSON; live tenant run against staging during the demo.
- "What's the blast radius if the agent pushes a bad connector?" → pre-prod only; prod gate refuses; worst case is a broken staging deploy we roll back with a revert PR.
- "What's NOT built?" → see `submission-draft.md` Implemented vs Simulated section. Be direct; judges respect honesty more than bluster.

---

## Open items

1. **Verify Watch Party format** — 5-min limit is my guess; check the schedule doc. If shorter/longer, the live walkthrough timings adjust.
2. **Music bed decision** — defer until first VO pass is recorded. Listen, decide.
3. **AcmeHR-lite admin UI polish** — Day 4 build target. If UI is too bare, the shot 5 provisioning payoff reads weak. Minimum: user list table, search, "last updated" column.
