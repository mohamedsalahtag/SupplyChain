# Runbooks

Each runbook is: **symptom → check → action → done when**. Never edit workflow tables by hand. Every fix goes through the app, or through a developer with an invariant run afterwards.

## 1. SAP outcome unknown (`SAP_UNKNOWN` on My work, draft shows *SAP outcome unknown*)
**Why:** the app sent a PO to SAP but has no reliable answer: a timeout, a lost reply, or a crashed worker. The quantity stays *PO submitted* on purpose. Nothing is resent until SAP has been asked.

1. Wait first. The outbox asks SAP by the portal reference (POD-…) after 1, 2, 3 … minutes. Most cases settle by themselves as *Created in SAP* (found) or as a resend with the same key (not found).
2. If the draft shows **Needs a person to check SAP** (5 checks failed, or 3 sends found nothing):
   1. In SAP (ME2N / ME23N), search purchase orders by the portal reference **POD-…**. It is stored on the PO; the field will be agreed with the SAP team for the ZCON adapter.
   2. Take a screenshot of the result. On the draft, under **Evidence and attachments**, upload it. The file must be uploaded *after* the draft was submitted.
   3. Choose **Resolve…**:
      - **SAP has the PO**, and enter its number. The quantity moves to *PO created*.
      - **SAP has no PO**. The quantity goes back to *PO preparation*; build and submit a new draft.
   4. The app asks SAP once more when it can. If SAP disagrees with your answer, it refuses and shows what SAP has.
3. **Done when:** the draft shows *Created in SAP* or *Not created in SAP*, and the My work exception is closed.

## 2. SAP rejected (`SAP_REJECTED`)
1. Open the draft. The alert lists SAP's messages (blocked supplier, missing plant data, price …).
2. Fix the cause: master data in SAP, or a SKU in PO preparation. If the terms are wrong, return the handoff to Procurement.
3. On the handoff, use **Build PO draft**; it gets a new number and a new key. Then **Validate**, then **Submit**.
4. **Done when:** the new draft is *Created in SAP*.

## 3. Late SAP reply (`SAP_UNKNOWN` titled "late SAP reply")
**Why:** SAP answered after the draft had already been settled, for example after a manual "SAP has no PO". There may now be **two POs in SAP**.
1. In SAP, search by the reference POD-… named in the exception.
2. If SAP holds a PO for a draft the portal shows as *Not created in SAP*, cancel that PO in SAP (or keep it, and void the newer one), following the purchasing manager's decision.
3. Record what was done as a comment and close the exception.

## 4. Master data missing (`MASTER_DATA_MISSING`, item *waiting for SAP master data*)
1. **PO drafts & SAP → Master data requests** shows what is missing. Ask the SAP master-data team to create the material.
2. Run **Configuration → Materials sync**, or wait for the scheduled one.
3. Choose **Created in SAP — close**, then **Pick SKU…** on the handoff.

## 5. Master data stale (Operations status: *older than n h*; validation says "Master data older than …")
1. **Configuration → SAP connection → Test**. If it fails, check the SAP service and the password (see the security checklist).
2. Run the sync that is stale: materials, suppliers or purchase orders. The Sync card shows the error of a failed run.
3. **Done when:** Operations status shows the source as *fresh*.

## 6. Overdue work (Operations status → Overdue work)
Items are escalated once, hourly, by the server. Tell the owner's lead. The item's link opens the record. There is nothing to fix technically.

## 7. The outbox does not run (the oldest waiting item keeps growing; the last call to SAP is old)
1. Check that the API server is running: the health check says *connected*, and the server log has "SAP outbox run" lines.
2. Restart the API service. Claims left by the stopped worker expire after 5 minutes and become *unknown*, so SAP is asked; nothing is sent twice.
3. **Done when:** the oldest waiting item drops below 10 minutes.

## 8. Sign-in problems
- **"Wrong username or password" for everyone:** use **Configuration → Active Directory → Test**. If the AD server or certificate changed, an administrator saves the settings again with the password.
- **One user sees nothing:** check that they have a role and at least one company. Operations status lists users *with roles but no company*.
- **Too many attempts:** wait a minute. The limit is 10 attempts per minute per address.
