// netlify/functions/create-deal.js
// ──────────────────────────────────────────────────────────────────────
// Called by the New Deal Setup form at buyer consultation.
//
// Does three things in sequence:
//   1. Creates transaction + seeds ALL 18 milestone rows + key dates in Supabase
//   2. Creates only the 3 PRE-OFFER tasks on the FUB contact (idx 0–2)
//   3. Returns the live portal URL to the form
//
// The remaining 15 contract tasks (idx 3–17) are created separately by
// seed-contract-tasks.js when the FUB deal stage moves to "Under Contract".
//
// ENV VARS REQUIRED:
//   SUPABASE_URL          → Supabase project URL
//   SUPABASE_SERVICE_KEY  → Supabase service role key (NOT anon key)
//   PORTAL_BASE_URL       → e.g. https://your-portal.netlify.app
//   FUB_API_KEY           → FUB API key (Admin → Settings → API)
// ──────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── ALL 18 MILESTONES ─────────────────────────────────────────────────
// All 18 are seeded in Supabase immediately so the portal renders the
// full timeline from day one. Only the FUB task creation is staged.
const MILESTONES = [
  { idx: 0,  task_name: 'Portal: Buyer consultation' },
  { idx: 1,  task_name: 'Portal: Agency Agreement signed' },
  { idx: 2,  task_name: 'Portal: Pre-approval received' },
  { idx: 3,  task_name: 'Portal: Offer submitted' },
  { idx: 4,  task_name: 'Portal: Offer accepted' },
  { idx: 5,  task_name: 'Portal: Earnest money delivered' },
  { idx: 6,  task_name: 'Portal: Inspection scheduled' },
  { idx: 7,  task_name: 'Portal: Inspection completed' },
  { idx: 8,  task_name: 'Portal: Inspection response submitted' },
  { idx: 9,  task_name: 'Portal: Inspection response agreed' },
  { idx: 10, task_name: 'Portal: Appraisal ordered' },
  { idx: 11, task_name: 'Portal: Appraisal completed' },
  { idx: 12, task_name: 'Portal: Clear to close' },
  { idx: 13, task_name: 'Portal: Closing date confirmed' },
  { idx: 14, task_name: 'Portal: Final walkthrough' },
  { idx: 15, task_name: 'Portal: Keys in hand' },
  { idx: 16, task_name: 'Portal: Home insurance confirmed' },
  { idx: 17, task_name: 'Portal: Utilities transferred' },
];

// ── PRE-OFFER TASKS ONLY ──────────────────────────────────────────────
// These 3 are created in FUB at form submission.
// idx 3–17 are created by seed-contract-tasks.js when stage = Under Contract.
const PRE_OFFER_MILESTONES = MILESTONES.filter(m => m.idx <= 2);

// ── KEY DATES ─────────────────────────────────────────────────────────
const KEY_DATE_DEFAULTS = [
  { label: 'Agency Agreement Signed',  sort_order: 1 },
  { label: 'Contract Acceptance',      sort_order: 2 },
  { label: 'Offer Expiration',         sort_order: 3 },
  { label: 'Earnest Money Due',        sort_order: 4 },
  { label: 'Inspection',              sort_order: 5 },
  { label: 'Inspection Response Due',  sort_order: 6 },
  { label: 'Appraisal',               sort_order: 7 },
  { label: 'Clear to Close',          sort_order: 8 },
  { label: 'Closing Day',            sort_order: 9 },
];

// ─────────────────────────────────────────────────────────────────────
exports.handler = async (event) => {

  if (event.httpMethod === 'OPTIONS') return respond(200, {}, true);
  if (event.httpMethod !== 'POST')    return respond(405, { error: 'Method not allowed' });

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }

  const { deal_id, fub_person_id, client_name, address, key_dates } = payload;

  // ── VALIDATE ───────────────────────────────────────────────────────
  if (!client_name)                      return respond(400, { error: 'client_name is required' });
  if (!fub_person_id)                    return respond(400, { error: 'fub_person_id is required' });
  if (typeof fub_person_id !== 'number') return respond(400, { error: 'fub_person_id must be a number' });
  if (!deal_id)                          return respond(400, { error: 'deal_id is required' });

  const safeDealId = deal_id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!safeDealId) return respond(400, { error: 'deal_id could not be sanitized' });

  const portalBaseUrl = (process.env.PORTAL_BASE_URL || 'https://your-portal.netlify.app').replace(/\/$/, '');
  const portalUrl     = `${portalBaseUrl}?deal=${safeDealId}`;

  // ── DUPLICATE CHECK ────────────────────────────────────────────────
  const { data: existing } = await sb
    .from('transactions')
    .select('id, deal_id, fub_person_id')
    .eq('deal_id', safeDealId)
    .limit(1);

  if (existing?.length > 0) {
    const dup = existing[0];
    if (dup.deal_id === safeDealId) {
      return respond(409, { error: `Deal slug "${safeDealId}" already exists. Use a different slug.` });
    }
    return respond(409, { error: `FUB person ID ${fub_person_id} already has a portal transaction.` });
  }

  // ══════════════════════════════════════════════════════════════════
  // STEP 1 — SUPABASE: INSERT TRANSACTION + ALL 18 MILESTONES + DATES
  // All 18 milestones are seeded now so the portal renders the full
  // timeline immediately, even though most are unchecked.
  // ══════════════════════════════════════════════════════════════════
  const { data: tx, error: txErr } = await sb
    .from('transactions')
    .insert({
      deal_id:       safeDealId,
      fub_person_id: fub_person_id,
      client_name:   client_name.trim(),
      address:       address?.trim() || null,
      portal_url:    portalUrl,
    })
    .select('id, deal_id')
    .single();

  if (txErr || !tx) {
    console.error('Transaction insert error:', txErr);
    return respond(500, { error: 'Failed to create transaction: ' + (txErr?.message || 'unknown') });
  }

  // Seed all 18 milestone rows
  const { error: milestonesErr } = await sb.from('milestones').insert(
    MILESTONES.map(m => ({
      transaction_id: tx.id,
      milestone_idx:  m.idx,
      task_name:      m.task_name,
      completed:      false,
    }))
  );

  if (milestonesErr) {
    console.error('Milestones seed error:', milestonesErr);
    await sb.from('transactions').delete().eq('id', tx.id); // rollback
    return respond(500, { error: 'Failed to seed milestones: ' + milestonesErr.message });
  }

  // Seed 9 key date rows
  const { error: datesErr } = await sb.from('key_dates').insert(
    KEY_DATE_DEFAULTS.map(def => {
      const fromForm = (key_dates || []).find(d => d.label === def.label);
      return {
        transaction_id: tx.id,
        label:          def.label,
        date_value:     fromForm?.date_value || null,
        status:         fromForm?.date_value ? 'set' : 'pending',
        sort_order:     def.sort_order,
      };
    })
  );

  if (datesErr) console.warn('Key dates seed failed (non-fatal):', datesErr.message);

  console.log(`✅ Supabase seeded: deal=${safeDealId}, tx_id=${tx.id}`);

  // ══════════════════════════════════════════════════════════════════
  // STEP 2 — FUB: CREATE ONLY PRE-OFFER TASKS (idx 0–2)
  // Contract tasks (idx 3–17) are created by seed-contract-tasks.js
  // when the FUB deal stage changes to "Under Contract".
  // ══════════════════════════════════════════════════════════════════
  const fubApiKey = process.env.FUB_API_KEY;

  if (!fubApiKey) {
    console.warn('FUB_API_KEY not set — skipping FUB task creation');
    return respond(200, buildSuccess(safeDealId, client_name, portalUrl, 0, datesErr));
  }

  const fubAuthHeader = 'Basic ' + Buffer.from(`${fubApiKey}:`).toString('base64');
  const today         = new Date().toISOString().split('T')[0];

  const fubResults = await Promise.allSettled(
    PRE_OFFER_MILESTONES.map(m => createFubTask({
      personId:   fub_person_id,
      name:       m.task_name,
      dueDate:    today,
      authHeader: fubAuthHeader,
    }))
  );

  const succeeded = fubResults.filter(r => r.status === 'fulfilled' && r.value?.ok).length;
  const failed    = fubResults.filter(r => r.status === 'rejected'  || !r.value?.ok);

  if (failed.length > 0) {
    failed.forEach(f => console.warn('FUB task failed:', f.reason || f.value?.error));
  } else {
    console.log(`✅ FUB pre-offer tasks created: ${succeeded}/3 on person_id=${fub_person_id}`);
  }

  return respond(200, {
    ...buildSuccess(safeDealId, client_name, portalUrl, succeeded, datesErr),
    fub_tasks_created:    succeeded,
    fub_tasks_failed:     failed.length,
    fub_contract_tasks:   'pending — will create when stage moves to Under Contract',
    warning: failed.length > 0
      ? `${failed.length} pre-offer FUB task(s) failed. Check Netlify logs.`
      : null,
  });
};

// ─────────────────────────────────────────────────────────────────────
async function createFubTask({ personId, name, dueDate, authHeader }) {
  const res = await fetch('https://api.followupboss.com/v1/tasks', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': authHeader,
      'X-System':      'KO Portal',
      'X-System-Key':  'ko-portal-v2',
    },
    body: JSON.stringify({
      personId:    personId,
      name:        name,
      dueDate:     dueDate,
      type:        'Task',
      isCompleted: false,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data?.errorMessage || `HTTP ${res.status}`, task: name };
  return { ok: true, fub_task_id: data.id, task: name };
}

function buildSuccess(dealId, clientName, portalUrl, fubTasksCreated, datesErr) {
  return {
    ok:                true,
    deal_id:           dealId,
    client_name:       clientName.trim(),
    portal_url:        portalUrl,
    milestones_seeded: 18,
    dates_seeded:      datesErr ? 0 : 9,
    fub_tasks_created: fubTasksCreated,
  };
}

function respond(status, body, preflight = false) {
  return {
    statusCode: status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: preflight ? '' : JSON.stringify(body),
  };
}
